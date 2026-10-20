import { LEVEL } from './criteria.js'
import { proposeLabel, proposePlaceholder, proposeHelp, fixHelpWording } from './patch.js'

const PLACEHOLDER_TYPES = new Set(['string', 'number', 'date', 'html', 'markdown', 'dropdown', 'multiselect'])
const CHOICE_TYPES = new Set(['dropdown', 'multiselect', 'boolean'])
const ID_FIELD = /(^|[_\s.])ids?$/i
const FIXED_CHOICE_LABEL = /\b(status|type|priority|category|format|mode|unit|visibility|role|direction|order)\s*$/i

const finding = (criterion, detail, evidence, where) => ({ criterion, severity: LEVEL[criterion] === 'reject' ? 'blocking' : 'minor', detail, evidence, where })

/**
 * Checks the catalog schema of a published plug for I1, I2 and the schema part of I3. Pure code, no AI.
 * Returns findings (grouped per operation, a few examples each) and a patch of concrete wording fixes.
 */
export function schemaChecks(schema) {
  const findings = [], patch = []
  const operations = [
    ...(schema.actions || []).map((a) => ({ kind: 'action', name: a.name, schema: a.input_schema })),
    ...(schema.triggers || []).map((t) => ({ kind: 'trigger', name: t.name, schema: t.input_schema }))
  ]
  for (const op of operations) {
    const fields = Object.values(op.schema?.blocks || {}).filter((f) => f && f.type !== 'help')
    const hits = { I1: [], I2: [], I3: [] }
    for (const f of fields) {
      const fix = { operation: op.name, field: f.key, set: {} }
      // I1: label, and placeholder where the type needs one
      const noLabel = !String(f.label || '').trim()
      const noPlaceholder = PLACEHOLDER_TYPES.has(f.type) && !String(f.placeholder || '').trim()
      if (noLabel || noPlaceholder) {
        hits.I1.push(`${f.key} (${[noLabel && 'no label', noPlaceholder && 'no placeholder'].filter(Boolean).join(', ')})`)
        if (noLabel) fix.set.label = proposeLabel(f)
        if (noPlaceholder) fix.set.placeholder = proposePlaceholder({ ...f, label: f.label || fix.set.label })
      }
      // I2: help missing, or present but worded wrongly
      const help = String(f.help || '').trim()
      if (!help) { hits.I2.push(`${f.key} (no help)`); fix.set.help = proposeHelp({ ...f, label: f.label || fix.set.label }) }
      else {
        const wantsSelect = CHOICE_TYPES.has(f.type)
        const isGroup = f.type === 'input groups' || f.type === 'object'
        const startsRight = isGroup || (wantsSelect ? /^select\b/i.test(help) : /^enter\b/i.test(help))
        if (!startsRight || help.length > 220) {
          hits.I2.push(`${f.key} ("${help.slice(0, 50)}${help.length > 50 ? '…' : ''}" ${!startsRight ? 'should start with ' + (wantsSelect ? 'Select' : 'Enter') : 'is too long'})`)
          if (!startsRight) fix.set.help = fixHelpWording(f)
        }
      }
      // I3: a free-text string that looks like an ID or a fixed choice (delete actions take plain IDs by convention)
      if (f.type === 'string' && !/^delete\b/i.test(op.name) && (ID_FIELD.test(f.key) || ID_FIELD.test(f.label || '') || FIXED_CHOICE_LABEL.test(f.label || ''))) {
        hits.I3.push(`${f.key} ("${f.label || f.key}" is free text)`)
        fix.set.suggestion = 'Make this a dropdown (an ID list from the app, or the fixed choices)'
      }
      if (Object.keys(fix.set).length) patch.push(fix)
    }
    const text = { I1: 'Label or placeholder missing', I2: 'Help missing or badly written', I3: 'Free-text field that should be a dropdown' }
    for (const id of ['I1', 'I2', 'I3']) {
      if (!hits[id].length) continue
      const shown = hits[id].slice(0, 4).join('; ') + (hits[id].length > 4 ? `; +${hits[id].length - 4} more` : '')
      findings.push(finding(id, `${text[id]} in ${op.kind} "${op.name}" (${hits[id].length} field${hits[id].length === 1 ? '' : 's'})`, shown, `${op.kind}: ${op.name}`))
    }
  }
  return { findings, patch }
}

const SAAS_WORDS = /service unavailable|bad gateway|gateway time-?out|econnreset|etimedout|econnrefused|timed? out|rate.?limit|too many requests|quota|upgrade your plan|plan limit|subscription|temporar|maintenance|try again later|overloaded/i
const PLUG_WORDS = /is not defined|is not a function|cannot read|cannot destructure|undefined|syntaxerror|typeerror|referenceerror|unexpected token|json\.parse|invalid json|malformed|missing required|required (field|param)|unknown (field|param)|invalid (field|param|value)|unrecognized|not a valid/i

/**
 * Whose fault is a failed live run? plug = the plug is wrong (R1 counts), saas = the app or the account
 * (never counted), unknown = a person decides. Only the plug's own failures can reject a plug.
 */
export function classifyFailure({ status, message }) {
  const code = Number(status) || null
  const text = String(message || '')
  if (code && code >= 500) return { origin: 'saas', reason: `the app answered ${code}, a server-side error` }
  if (code === 429 || SAAS_WORDS.test(text)) return { origin: 'saas', reason: 'rate limit, outage, quota or plan limit on the app side' }
  if (PLUG_WORDS.test(text)) return { origin: 'plug', reason: 'the message points at the plug itself: its code or the request it built' }
  if (code && [400, 404, 405, 409, 415, 422].includes(code)) return { origin: 'plug', reason: `the app rejected the request the plug built (${code})` }
  if (code === 401 || code === 403) return { origin: 'unknown', reason: `${code} on a valid test connection: could be the plug's auth handling or the test account's rights` }
  return { origin: 'unknown', reason: 'the error does not clearly point at the plug or at the app' }
}

/** R1 findings from live results: only failures that are the plug's own count. */
export function liveFindings(live) {
  const out = [], notCounted = []
  if (!live || live.status !== 'tested') return { findings: out, notCounted }
  for (const entry of [...(live.actions || []), ...(live.triggers || [])]) {
    if (entry.status !== 'failed') continue
    if (entry.origin === 'plug') out.push(finding('R1', `Live run of "${entry.name}" failed because of the plug: ${entry.originReason}`, String(entry.detail).slice(0, 300), entry.name))
    else notCounted.push({ name: entry.name, origin: entry.origin || 'unknown', reason: entry.originReason, detail: String(entry.detail).slice(0, 160) })
  }
  return { findings: out, notCounted }
}

/** What was and was not actually checked. The verdict can only be "approve" when everything was. */
export function buildCoverage({ live, codeAvailable }) {
  const notAssessed = []
  const ranSomething = live && live.status === 'tested' && [...(live.actions || []), ...(live.triggers || [])].some((e) => e.status === 'passed' || e.status === 'failed')
  if (!ranSomething) notAssessed.push('R1')
  if (!codeAvailable) notAssessed.push('R3', 'R4')
  return { notAssessed, codeAvailable: Boolean(codeAvailable) }
}
