import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { embedToken } from './viasocket.js'
import { criteriaText } from './review/criteria.js'
import { decideVerdict } from './review/verdict.js'

const PROJECT = process.env.VIASOCKET_PROJECT_ID
const API = process.env.VIASOCKET_API_URL
const RUN = `${process.env.VIASOCKET_RUN_URL}/func`

const AI = { actionId: 'rowskkqydb6f' }
const SLACK = { send: 'rowbevmtsy7h', dm: 'rowovgwtt9u4' }
const TABLE = { add: 'rowsn9dar', get: 'rowrfcbb0mkf', rowCreated: 'rownvhf0ucl6' }
const COLUMN = {
  plug_id: 'name@longtext',
  plug_name: 'plug_name@longtext',
  status: 'status@longtext',
  recommendation: 'recommendation@longtext',
  reason: 'reason@longtext',
  assignee: 'assignee@longtext',
  decided_by: 'decided_by@longtext',
  decided_at: 'decided_at@longtext',
  idempotency_key: 'idempotency_key@longtext'
}

async function proxyToken(uniqueIdentifier) {
  const response = await fetch(`${API}/users/register`, { headers: { authorization: embedToken(uniqueIdentifier) } })
  const payload = await response.json()
  if (!payload.data?.token) throw new Error('could not derive proxy_auth_token')
  return payload.data.token
}

async function post(fn, body) {
  const response = await fetch(`${RUN}/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const payload = await response.json()
  // A refused call still answers HTTP 200: the refusal is in the body.
  if (payload.status === 400 || payload.data?.success === false) {
    throw new Error(payload.data?.message || payload.message || `${fn} refused`)
  }
  return payload
}

async function createWebhookFlow(token, title, description) {
  const created = await post('scrisgf5H0hN', { title, description, projectId: PROJECT, proxy_auth_token: token })
  const scriptId = created.data.script_id
  await post('scrij2DSRMlP', { scriptId, projectId: PROJECT, triggerType: 'webhook', proxy_auth_token: token })
  return scriptId
}

const saveSteps = (token, scriptId, steps) =>
  post('scrigkyMNOEC', { scriptId, steps, proxy_auth_token: token })

const readFlow = (token, scriptId) =>
  post('scriiZYPU6I3', { scriptId, env: 'prod', proxy_auth_token: token })

// Step code. Settings are baked in as JSON literals; findings arrive per run in context.req.body.
// The AI only reports findings (R2, I3, I4). Code decides the verdict with decideVerdict, the same function
// the tests run, embedded here with Function#toString.
export function auditStep(decideUrl) {
  return `
${decideVerdict.toString()}
const body = context?.req?.body || {}
console.log('### Auditing ' + body.plugName)
const plug = body.plug || {}
const hasDefinition = Boolean(plug.auth || (plug.actions && plug.actions.length) || (plug.triggers && plug.triggers.length))
const notAssessed = body.coverage && body.coverage.notAssessed ? body.coverage.notAssessed.slice() : ['R1', 'R3', 'R4']
const JUDGEMENT = ['R2', 'I3', 'I4']
const scope = body.scope || null
let audit = {}
if (!hasDefinition) {
  // Never judge what cannot be seen: no definition means a person decides, never an auto-reject.
  console.log('### No plug definition supplied: nothing to judge')
  audit = { recommendation: 'incomplete', summary: 'No plug definition was available to audit. A person has to decide.', findings: [], unverified: ['plug definition not available: ' + ((body.liveResults && body.liveResults.reason) || 'nothing was audited')], patch: [], notCounted: [], coverage: { notAssessed: ['R1', 'R2', 'R3', 'R4'] } }
} else {
  const result = await runAiModel({ inputData: {
    query: 'Review this viaSocket plug ' + (scope ? '(only the ' + scope.type + ' "' + scope.name + '") ' : '') + 'against the official API docs at ' + (body.docsUrl || '(none found)') + '. Plug definition (JSON): ' + JSON.stringify(plug).slice(0, 9000) + '\\nLive test results (JSON, for context): ' + JSON.stringify(body.liveResults || { status: 'not_tested' }).slice(0, 3000),
    prompt: 'You review a viaSocket plug against its official API docs. Criteria:\\n' + (body.criteriaText || ${JSON.stringify(criteriaText())}) + '\\nRead the docs URL. For R2, compare each operation\\'s documented parameters with the action fields and quote the docs for every documented parameter that is missing. Set docs_read to false if you could not open or read the docs.' + (scope ? ' Review ONLY the ' + scope.type + ' "' + scope.name + '": the plug definition contains only that operation, so judge nothing else.' : '') + ' Return ONLY JSON.',
    threadid: 'plug-audit-' + body.plugId,
    reasoning: 'medium',
    response_type: 'json_object',
    response_json_structure: '{"summary":"string","docs_read":true,"findings":[{"criterion":"R2|I3|I4","detail":"string","evidence":"string"}]}'
  }})
  let ai = {}
  try { ai = JSON.parse(result?.content || '{}') } catch (e) { ai = { docs_read: false, summary: 'The AI answer could not be parsed.' } }
  // Docs that were not found, or found with low confidence, cannot be used to reject: R2 is then not assessed.
  const lowDocs = !body.docsUrl || Boolean(body.docsInfo && body.docsInfo.confidence === 'low')
  if ((lowDocs || !ai.docs_read) && !notAssessed.includes('R2')) notAssessed.push('R2')
  const aiFindings = (Array.isArray(ai.findings) ? ai.findings : []).filter((f) => JUDGEMENT.includes(f.criterion) && !(lowDocs && f.criterion === 'R2')).map((f) => ({ criterion: f.criterion, severity: f.criterion === 'R2' ? 'blocking' : 'minor', detail: String(f.detail || '').slice(0, 300), evidence: String(f.evidence || '').slice(0, 300) }))
  const pre = Array.isArray(body.preFindings) ? body.preFindings : []
  const outcome = decideVerdict(pre.concat(aiFindings), { complete: notAssessed.length === 0, notAssessed })
  const why = { R1: 'no live run completed', R2: 'API docs not read', R3: 'plug code not available (error component)', R4: 'plug code not available (validation)' }
  const counts = outcome.counted.reduce((n, f) => { n[f.severity === 'blocking' ? 0 : 1]++; return n }, [0, 0])
  audit = { recommendation: outcome.verdict, summary: (outcome.verdict + ': ' + counts[0] + ' reject and ' + counts[1] + ' improve finding(s). ' + (ai.summary || '')).slice(0, 400), findings: outcome.counted, unverified: notAssessed.map((id) => id + ' not assessed: ' + ((body.coverage && body.coverage.reasons && body.coverage.reasons[id]) || why[id] || 'unknown')), patch: body.patch || [], notCounted: body.notCounted || [], coverage: { notAssessed }, droppedFindings: outcome.dropped, scope, docs: body.docsInfo || null }
}
const handoff = await axios.post(${JSON.stringify(decideUrl)}, {
  plugId: body.plugId, plugName: body.plugName, assigneeSlackId: body.assigneeSlackId, assigneeName: body.assigneeName,
  docsUrl: body.docsUrl, audit, live: body.liveResults || null, scope, docsInfo: body.docsInfo || null
})
return { audit, handoffStatus: handoff.status }
`
}

export function decideSteps(settings, slackAuthId, tableAuthId) {
  const S = JSON.stringify
  const recheck = `
const b = context?.req?.body || {}
const result = await runAiModel({ inputData: {
  query: 'Findings for plug ' + b.plugName + ': ' + JSON.stringify(b.audit),
  prompt: 'You are the decision agent. Re-check these audit findings against the criteria. Do not repeat the audit: check that each finding is supported by its evidence, that the recommendation follows the verdict rules, and downgrade or upgrade it if it does not. Criteria and verdict rules:\\n' + ${S(criteriaText())} + '\\nReturn ONLY JSON.',
  threadid: 'plug-decide-' + b.plugId,
  reasoning: 'medium',
  response_type: 'json_object',
  response_json_structure: '{"verdict":"approve|improve|reject","agrees_with_audit":true,"reasoning":"string"}'
}})
let out = {}
try { out = JSON.parse(result?.content || '{}') } catch (e) { out = { verdict: 'improve', agrees_with_audit: false, reasoning: 'recheck parse failure' } }
return out
`
  const ask = `
const b = context?.req?.body || {}
const re = context?.res?.recheck || {}
const rec = b.audit?.recommendation
const blockingWithEvidence = (b.audit?.findings || []).filter((f) => f.severity === 'blocking' && f.evidence).length
if (rec === 'reject' && re.verdict === 'reject' && blockingWithEvidence >= 1) {
  console.log('### Audit and re-check both say reject with evidence: acting without a click')
  return { decision: 'reject', mode: 'auto' }
}
const lines = (b.audit?.findings || []).map((f) => '• [' + f.severity + '] #' + f.criterion + ' ' + f.detail)
const live = b.live || {}
const liveItems = [].concat(live.actions || [], live.triggers || [])
const liveFailed = liveItems.filter((i) => i.status === 'failed').map((i) => '• FAILED ' + i.name + ': ' + String(i.detail).slice(0, 160))
const patchLines = (b.audit?.patch || []).slice(0, 6).map((p) => '• ' + p.operation + ' › ' + p.field + ': ' + Object.entries(p.set).map(([k, v]) => k + ' = "' + v + '"').join(', '))
const notCounted = (b.audit?.notCounted || []).slice(0, 4).map((n) => '• Not counted (' + n.origin + '): ' + n.name + ': ' + String(n.detail).slice(0, 120))
const liveLine = live.status === 'tested'
  ? '*Live test:* ' + live.summary.passed + ' passed, ' + live.summary.failed + ' failed, ' + live.summary.notRun + ' not run (writes are never run)'
  : '*Live test:* not run (' + (live.reason || 'no live results') + ')'
const scopeLine = b.scope ? '_Reviewing only the ' + b.scope.type + ' "' + b.scope.name + '" (' + b.scope.version + ')_\\n' : ''
const docsLine = b.docsInfo && b.docsInfo.url ? '_Docs: ' + b.docsInfo.url + ' (' + b.docsInfo.source + ', ' + b.docsInfo.confidence + ' confidence)_' : '_Docs: none found_'
const content = ('*Plug review: ' + b.plugName + '* (' + b.plugId + ')\\n' + scopeLine + 'Agent recommends: *' + rec + '* | Re-check says: *' + re.verdict + '*\\n' + (b.audit?.summary || '') + '\\n' + liveLine + '\\n' + liveFailed.join('\\n') + (notCounted.length ? '\\n' + notCounted.join('\\n') : '') + '\\n' + lines.join('\\n') + (patchLines.length ? '\\n*Suggested fixes:*\\n' + patchLines.join('\\n') : '') + '\\n' + docsLine + '\\n_Not assessed: ' + ((b.audit?.unverified || []).join('; ') || 'nothing') + '_').slice(0, 2900)
await askReviewer({ inputData: {
  messageto: 'channel', channel_id: ${S(settings.channelId)}, content, operation: 'Approval',
  buttons: { Approve: 'approve', Reject: 'reject', Improve: 'improve' },
  bot_details: { bot_name: 'Plug Review Agent', customIcon: false }, isScheduledMessage: 'no'
}})
// The run pauses here; when the reviewer clicks, the next steps see the Slack payload at context.res.ask.
return { mode: 'click' }
`
  const act = `
const b = context?.req?.body || {}
const ask = context?.res?.ask || {}
const clicked = ask.actions?.[0]?.value
const d = ask.mode === 'auto' ? ask : { decision: ['approve', 'reject', 'improve'].includes(clicked) ? clicked : 'unknown', mode: 'click', by: ask.user?.name }
const re = context?.res?.recheck || {}
if (d.decision === 'unknown' || !d.decision) return { skipped: 'no valid decision' }
const key = b.plugId + (b.scope ? '#' + b.scope.id : '') + ':' + d.decision
const liveBits = [].concat(b.live?.actions || [], b.live?.triggers || []).filter((i) => i.status === 'failed').map((i) => 'LIVE FAIL ' + i.name + ': ' + String(i.detail).slice(0, 140))
const liveHead = b.live?.status === 'tested' ? 'Live: ' + b.live.summary.passed + ' passed, ' + b.live.summary.failed + ' failed, ' + b.live.summary.notRun + ' not run' : 'Live: not run'
const reason = [liveHead].concat(liveBits, (b.audit?.findings || []).map((f) => '#' + f.criterion + ' ' + f.detail)).join(' | ') || b.audit?.summary || ''

// Idempotency: skip if this plug+decision was already recorded.
const rows = await getRows({ inputData: { table: ${S(settings.tableId)}, filter_mode: 'list_all', queryopt: { limit: '500' } } })
const list = Array.isArray(rows) ? rows : (rows?.data || rows?.rows || [])
if (JSON.stringify(list).includes(key)) return { skipped: 'already recorded', key }

let status = d.decision
let note = ''
if (d.decision === 'reject') {
  const msg = '*Plug rejected: ' + b.plugName + '* (' + b.plugId + ')\\n' + reason
  const targets = [${S(settings.tlUserId)}, b.assigneeSlackId].filter(Boolean)
  for (const userId of targets) {
    await dm({ inputData: { userId, content: msg, isScheduledMessage: 'no', bot_details: { bot_name: 'Plug Review Agent', customIcon: false } } })
  }
  note = 'Reject message sent to ' + targets.length + ' recipient(s)'
} else {
  // The agent reads Developer Hub but does not change plugs yet: record the decision, do NOT claim the action ran.
  status = d.decision === 'approve' ? 'approved_publish_not_executed' : 'improve_update_not_executed'
  note = 'Developer Hub is connected read-only, so the agent does not ' + (d.decision === 'approve' ? 'grant publish access yet: nothing was published' : 'apply fixes yet: the plug was not changed')
  await dm({ inputData: { userId: ${S(settings.tlUserId)}, content: '*' + b.plugName + '*: reviewer chose ' + d.decision + '. ' + note, isScheduledMessage: 'no', bot_details: { bot_name: 'Plug Review Agent', customIcon: false } } })
}
await addRow({ inputData: {
  table: ${S(settings.tableId)}, bulkAdd: false, includeLookupFields: false, addMissingOptions: false,
  selectedFields: ${S(Object.values(COLUMN))},
  field: {
    ${S(COLUMN.plug_id)}: b.plugId, ${S(COLUMN.plug_name)}: b.plugName, ${S(COLUMN.status)}: status,
    ${S(COLUMN.recommendation)}: b.audit?.recommendation || '', ${S(COLUMN.reason)}: reason + ' || ' + note,
    ${S(COLUMN.assignee)}: b.assigneeName || '', ${S(COLUMN.decided_by)}: d.mode === 'auto' ? 'agent (auto-reject)' : 'reviewer (Slack click: ' + (d.by || 'unknown') + ')',
    ${S(COLUMN.decided_at)}: new Date().toISOString(), ${S(COLUMN.idempotency_key)}: key
  }
}})
return { recorded: true, status, key, note }
`
  const fn = (name, auth_id, action_id) => ({ name, auth_id, action_id })
  return [
    { stepname: 'recheck', code: recheck, service_action_functions: [fn('runAiModel', 'NoAuth', AI.actionId)] },
    { stepname: 'ask', code: ask, service_action_functions: [fn('askReviewer', slackAuthId, SLACK.send)] },
    {
      stepname: 'act', code: act,
      service_action_functions: [fn('dm', slackAuthId, SLACK.dm), fn('getRows', tableAuthId, TABLE.get), fn('addRow', tableAuthId, TABLE.add)]
    }
  ]
}

// Intake: a new row in the queue table starts a review. Keys are those of the real sample event.
export function intakeSteps(reviewUrlValue) {
  const code = `
const row = context?.req?.body || {}
if (!row.name || (!row.docs_url && !row.dh_pllug_url)) {
  console.log('### Row ' + row.rowid + ' skipped: a plug id and either a docs URL or a Developer Hub link are required')
  return { skipped: 'incomplete row', rowid: row.rowid }
}
const payload = {
  plugId: row.name, plugName: row.plug_name || row.name, docsUrl: row.docs_url || '',
  assigneeName: row.assignee_name || '', assigneeSlackId: row.assignee_slack || '',
  plug: { developerHubUrl: row.dh_pllug_url || null }
}
console.log('### Queued ' + payload.plugId + ' for review')
// Live tests run on the hosted app (an automation stops at 58 s); it hands the results to the review flow.
try {
  const res = await axios.post(${JSON.stringify(process.env.PUBLIC_URL + '/api/live-test')}, payload, { timeout: 20000, headers: { 'x-intake-key': ${JSON.stringify(process.env.INTAKE_KEY)} } })
  return { forwarded: 'live-test', status: res.status }
} catch (error) {
  // The app is unreachable: still start the review so a plug is never dropped, with live tests marked as not run.
  console.log('### Live-test service unavailable (' + (error?.message || error) + '): reviewing without live tests')
  payload.liveResults = { status: 'error', reason: 'Live-test service unavailable: ' + (error?.message || error) }
  try {
    const res = await axios.post(${JSON.stringify(reviewUrlValue)}, payload, { timeout: 45000 })
    return { forwarded: 'review-direct', status: res.status }
  } catch (e) {
    return { forwarded: 'review-direct', note: 'no reply within 45s or error: ' + (e?.message || e) }
  }
}
`
  return [{ stepname: 'forward', code, service_action_functions: [] }]
}

async function setIntakeTrigger(token, scriptId, tableAuthId, queueTableId) {
  return post('scrij2DSRMlP', {
    scriptId, projectId: PROJECT, triggerType: 'plugin', trigger_id: TABLE.rowCreated,
    auth_id: tableAuthId, inputData: { table: queueTableId }, proxy_auth_token: token
  })
}

export async function setupFlows(uniqueIdentifier, settings, state, existing = {}, options = {}) {
  const prefix = options.staging ? 'STAGING: ' : ''
  const token = await proxyToken(uniqueIdentifier)
  const slackAuth = state.rowbu58rc.authId
  const tableAuth = state.rowe71n93.authId
  const decideId = existing.decideId || (await createWebhookFlow(token, prefix + 'Plug decision agent', 'Re-checks audit findings, asks the reviewer in Slack, then acts and records the decision.'))
  await saveSteps(token, decideId, decideSteps(settings, slackAuth, tableAuth))
  const reviewId = existing.reviewId || (await createWebhookFlow(token, prefix + 'Plug review agent', 'Audits a plug against its API docs and hands findings to the decision agent.'))
  await saveSteps(token, reviewId, [
    { stepname: 'audit', code: auditStep(`${RUN}/${decideId}`), service_action_functions: [{ name: 'runAiModel', auth_id: 'NoAuth', action_id: AI.actionId }] }
  ])
  let intakeId = existing.intakeId
  // Staging flows are entered by webhook only: no queue trigger, so they can never start from a real queue row.
  if (settings.queueTableId && !options.staging) {
    if (!intakeId) intakeId = (await post('scrisgf5H0hN', { title: 'Plug intake', description: 'A new row in the plug queue table starts a plug review.', projectId: PROJECT, proxy_auth_token: token })).data.script_id
    // The trigger is bound to a Table connection and table: re-set it when either changed.
    if (!existing.intakeId || existing.queueTableId !== settings.queueTableId || existing.tableAuthId !== tableAuth) await setIntakeTrigger(token, intakeId, tableAuth, settings.queueTableId)
    await saveSteps(token, intakeId, intakeSteps(`${RUN}/${reviewId}`))
  }
  const readBack = await readFlow(token, decideId)
  return { slackAuthId: slackAuth, tableAuthId: tableAuth, reviewId, decideId, intakeId, decideStepNames: (readBack.steps || readBack.data?.steps || []).map((s) => s.stepname) }
}

export const reviewUrl = (reviewId) => `${RUN}/${reviewId}`
