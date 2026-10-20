import { LEVEL } from './criteria.js'

// R3 and R4 on a plug's real code, following viaSocket's own P0 rules (dh-review.md):
//   R3  errorComponent is awaited in the catch, and every component the code calls is mapped to the version.
//   R4  the code parses, runs inside try/catch, validates required inputs before the request, reads only inputs
//       that a field defines, and builds no auth of its own.
// Pure functions, no network. Heuristics are kept to patterns precise enough to put in front of a person.

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const CODE_BLOCKS = ['perform', 'performlist', 'performsubscribe', 'performunsubscribe', 'modifytriggerdata', 'transferoption']
const SYSTEM_INPUT_KEYS = new Set(['hookUrl', 'performsubscribe', 'scheduledTime', 'transferOption'])
const SKIP_REQUIRED_TYPES = new Set(['help', 'input groups', 'object'])

const finding = (criterion, detail, evidence, where) => ({ criterion, severity: LEVEL[criterion] === 'reject' ? 'blocking' : 'minor', detail, evidence, where })
const has = (s) => typeof s === 'string' && s.trim().length > 0
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const stripComments = (code) => String(code).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
const list = (items, max = 4) => items.slice(0, max).join('; ') + (items.length > max ? `; +${items.length - max} more` : '')

/** The input fields of a version, from the rebuilt blocks (preferred) or the authored inputFields. */
export function fieldsOf(inputjson) {
  const blocks = Object.values(inputjson?.blocks || {}).filter((b) => b && b.key)
  return blocks.length ? blocks : (inputjson?.inputFields || []).filter((f) => f && f.key)
}

/** Bodies of every catch clause (brace matched). Falls back to a window if braces do not balance. */
function catchBodies(code) {
  const bodies = []
  for (const m of code.matchAll(/\bcatch\s*(\([^)]*\))?\s*\{/g)) {
    let depth = 1, i = m.index + m[0].length
    while (i < code.length && depth > 0) { const c = code[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
    bodies.push(depth === 0 ? code.slice(m.index + m[0].length, i - 1) : code.slice(m.index, m.index + 400))
  }
  return bodies
}

/** A block that only returns a constant (a sample payload): nothing in it can fail, so no try/catch is needed. */
const isStatic = (code, componentNames) => !/\bawait\b|\b(axios|fetch)\b|\bcontext\b/.test(code) && !componentNames.some((n) => new RegExp(`\\b${esc(n)}\\s*\\(`).test(code))

/** authData in a header or token position builds auth by hand. In a URL it is fine: the platform fills those in. */
const AUTH_WORDS = /authorization|bearer|\bbasic\b|\boauth\b|token|api[_-]?key|x-[\w-]*(key|token)|secret/i
const buildsAuth = (code) => code.split('\n').some((line) => /\bauthData\b/.test(line) && AUTH_WORDS.test(line))

/** A required field that is a fixed-choice dropdown is enforced by the form itself, so a code guard adds nothing. */
const isFixedChoice = (f) => ['dropdown', 'multiselect', 'boolean'].includes(f.type) && Array.isArray(f.options) && f.options.length > 0 && !f.source && !f.optionsGenerator

const firstRequestAt = (code) => { const m = /\b(axios|fetch)\b\s*[.(]/.exec(code); return m ? m.index : -1 }

/** Is `key` checked before the request? Accepts the usual guard shapes; evidence is only ever "no guard found". */
function guardIndex(code, key) {
  const k = esc(key)
  const patterns = [
    new RegExp(`(^|[^=!<>])!\\s*[\\w$.?\\[\\]'"]*\\b${k}\\b`),
    new RegExp(`\\b${k}\\b\\s*(===|==|!==|!=)\\s*(undefined|null|''|"")`),
    new RegExp(`assertRequired\\s*\\([^)]*\\b${k}\\b`),
    new RegExp(`isEmpty\\s*\\([^)]*\\b${k}\\b`),
    new RegExp(`\\b${k}\\b[^;\\n]*\\.length\\s*(===|==|<)\\s*[01]`)
  ]
  const hits = patterns.map((p) => p.exec(code)).filter(Boolean).map((m) => m.index)
  return hits.length ? Math.min(...hits) : -1
}

/** Input keys the code reads: inputData.x, inputData?.x, inputData['x'] and { x } = context.inputData. */
function inputsRead(code) {
  const keys = new Set()
  for (const m of code.matchAll(/inputData\??\.\s*([A-Za-z_$][\w$]*)/g)) keys.add(m[1])
  for (const m of code.matchAll(/inputData\??\.?\[\s*['"]([^'"]+)['"]\s*\]/g)) keys.add(m[1])
  for (const m of code.matchAll(/\{([^}]*)\}\s*=\s*context\??\.inputData\b/g)) {
    for (const part of m[1].split(',')) { const name = part.trim().replace(/^\.\.\./, '').split(/[:=]/)[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.add(name) }
  }
  return keys
}

export function codeChecks(bundle) {
  const findings = [], stats = { operations: 0, codeBlocks: 0, versions: [] }
  const components = bundle.components || []
  const componentIds = new Map(components.map((c) => [c.function_name, c.rowid]))

  for (const op of bundle.operations || []) {
    stats.operations++
    const label = `${op.action.type} "${op.action.name}"`
    const where = `${label} (${op.version.versionid}, ${op.version.status})`
    stats.versions.push(`${op.action.name} ${op.version.versionid} ${op.version.status}`)
    const fields = fieldsOf(op.inputjson)
    const mapped = new Set((op.mappings || []).map((m) => m.component_id))
    const known = new Set(SYSTEM_INPUT_KEYS)
    for (const f of fields) { known.add(f.key); for (const seg of String(f.key).split('.')) known.add(seg) }

    const blocks = []
    for (const name of CODE_BLOCKS) if (has(op.version[name])) blocks.push({ name, code: op.version[name], isPerform: name === 'perform' })
    for (const f of fields) { const src = f.source || f.optionsGenerator || f.fieldsGenerator; if (has(src)) blocks.push({ name: `field "${f.key}"`, code: src, isPerform: false }) }

    const r3 = { notCalled: [], noCatchCall: [], unmapped: [] }
    const r4 = { parse: [], noTry: [], required: [], align: [], auth: [] }
    const i4 = []

    for (const b of blocks) {
      stats.codeBlocks++
      const code = stripComments(b.code)
      let parsed = true
      try { new AsyncFunction('context', 'axios', 'fetch', b.code) } catch (error) { parsed = false; r4.parse.push(`${b.name}: ${String(error.message).slice(0, 80)}`) }
      if (!parsed) continue

      // R3: errorComponent is called inside a catch, and is mapped (a call to an unmapped component fails at run time)
      const catches = catchBodies(code)
      const constant = isStatic(code, [...componentIds.keys()])
      if (constant) continue // a constant sample payload: nothing can fail, nothing to guard
      if (!/\berrorComponent\s*\(/.test(code)) r3.notCalled.push(b.name)
      else if (catches.length && !catches.some((c) => /\berrorComponent\s*\(/.test(c))) r3.noCatchCall.push(b.name)
      for (const [name, id] of componentIds) {
        if (new RegExp(`\\b${esc(name)}\\s*\\(`).test(code) && !mapped.has(id)) r3.unmapped.push(`${name} (in ${b.name})`)
      }

      // R4: structure, validation, alignment, auth
      if (!catches.length) r4.noTry.push(b.name)
      if (buildsAuth(code)) r4.auth.push(b.name)
      const missingKeys = [...inputsRead(code)].filter((k) => !known.has(k))
      if (missingKeys.length) r4.align.push(`${b.name} reads ${missingKeys.map((k) => `"${k}"`).join(', ')}`)
      if (b.isPerform) {
        const requestAt = firstRequestAt(code)
        const unguarded = fields.filter((f) => (f.required === true || f.required === 'true') && !f.visibilityCondition && !SKIP_REQUIRED_TYPES.has(f.type) && !String(f.key).includes('.') && !isFixedChoice(f))
          .filter((f) => { const g = guardIndex(code, f.key); return g < 0 || (requestAt >= 0 && g > requestAt) }).map((f) => f.key)
        if (unguarded.length) r4.required.push(...unguarded)
      }
      if (/\bcontext\.(inputData|req|paginateData|paginationData)\b/.test(code)) i4.push(b.name)
    }

    if (r3.notCalled.length) findings.push(finding('R3', `errorComponent is not called in ${label}`, `no errorComponent call in: ${list(r3.notCalled)}`, where))
    if (r3.noCatchCall.length) findings.push(finding('R3', `errorComponent is not awaited in the catch of ${label}`, `catch without errorComponent in: ${list(r3.noCatchCall)}`, where))
    if (r3.unmapped.length) findings.push(finding('R3', `A component used by ${label} is not mapped to this version`, `called but not mapped: ${list(r3.unmapped)}. It fails at run time with "<name> is not defined"`, where))
    if (r4.parse.length) findings.push(finding('R4', `Code of ${label} does not parse`, list(r4.parse), where))
    if (r4.noTry.length) findings.push(finding('R4', `No try/catch around the work in ${label}`, `no try/catch in: ${list(r4.noTry)}`, where))
    if (r4.required.length) findings.push(finding('R4', `Required inputs are not validated before the request in ${label}`, `no guard found for required field(s): ${list([...new Set(r4.required)])}`, where))
    if (r4.align.length) findings.push(finding('R4', `Code of ${label} reads inputs that no field defines`, list(r4.align), where))
    if (r4.auth.length) findings.push(finding('R4', `Code of ${label} handles authentication itself`, `authData used for credentials in: ${list(r4.auth)}. The platform adds auth from the connection, so a hand-built header sends a masked placeholder`, where))
    if (i4.length) findings.push(finding('I4', `Optional chaining is missing in ${label}`, `plain "context.inputData" style access in: ${list(i4)}; use context?.inputData?.<key>`, where))
  }
  return { findings, stats }
}

/** The plug as the review AI reads it (actions and triggers with their fields), built from Developer Hub data. */
export function definitionFromBundle(bundle) {
  const entry = (op) => ({ name: op.action.name, description: op.action.description, inputs: fieldsOf(op.inputjson).filter((f) => f.type !== 'help').map((f) => ({ key: f.key, label: f.label, type: f.type, required: Boolean(f.required), help: f.help, placeholder: f.placeholder })), sampledata: op.version.sampledata })
  const ops = bundle.operations || []
  return { auth: { type: bundle.authType || 'unknown' }, actions: ops.filter((o) => o.action.type !== 'trigger').map(entry), triggers: ops.filter((o) => o.action.type === 'trigger').map(entry) }
}

/** The same plug in the catalog's shape, so the schema checks (I1, I2, I3) also work for draft plugs. */
export function catalogShape(bundle) {
  const to = (op) => ({ name: op.action.name, description: op.action.description, input_schema: { blocks: Object.fromEntries(fieldsOf(op.inputjson).map((f) => [f.key, f])) } })
  const ops = bundle.operations || []
  return { service: { name: bundle.plug.name, auth_type: bundle.authType }, actions: ops.filter((o) => o.action.type !== 'trigger').map(to), triggers: ops.filter((o) => o.action.type === 'trigger').map(to) }
}
