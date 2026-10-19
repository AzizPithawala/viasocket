import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { embedToken } from './viasocket.js'

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
function auditStep(decideUrl) {
  return `
const body = context?.req?.body || {}
console.log('### Auditing ' + body.plugName)
const plug = body.plug || {}
const hasDefinition = Boolean(plug.auth || (plug.actions && plug.actions.length) || (plug.triggers && plug.triggers.length))
let audit = {}
if (!hasDefinition) {
  // Never judge what cannot be seen: no definition means a person decides, never an auto-reject.
  console.log('### No plug definition supplied: skipping the AI audit')
  audit = { recommendation: 'improve', summary: 'No plug definition was available to audit (only a Developer Hub link). Review the plug manually.', findings: [], unverified: ['plug definition not available: nothing was audited'] }
} else {
  const result = await runAiModel({ inputData: {
    query: 'Review this viaSocket plug against the official API docs at ' + body.docsUrl + '. Plug definition (JSON): ' + JSON.stringify(plug).slice(0, 9000) + '\\nLive test results from running the plug on a test account (JSON): ' + JSON.stringify(body.liveResults || { status: 'not_tested' }).slice(0, 5000),
    prompt: 'You are a strict viaSocket plug reviewer. Read the API docs URL. Compare auth type, endpoints, required params, field design, naming and sample data of the plug against the docs and these criteria:\\n' + ${JSON.stringify(readFileSync('criteria.md', 'utf8'))} + '\\nLive test rules: an action or trigger with status failed is a blocking finding and its real error text is the evidence (quote it). Anything with status not_run, or live status not_tested, not_resolved or error, goes under unverified and is never a reason to reject. Write actions are never run; do not treat that as a defect. Only report what you can support from the docs, the plug definition or the live results. Return ONLY JSON.',
    threadid: 'plug-audit-' + body.plugId,
    reasoning: 'medium',
    response_type: 'json_object',
    response_json_structure: '{"recommendation":"approve|improve|reject","summary":"string","findings":[{"criterion":"number","severity":"blocking|minor","detail":"string","evidence":"string"}],"unverified":["string"]}'
  }})
  try { audit = JSON.parse(result?.content || '{}') } catch (e) { audit = { recommendation: 'improve', summary: 'Audit output could not be parsed', findings: [], unverified: ['audit parse failure'] } }
}
const handoff = await axios.post(${JSON.stringify(decideUrl)}, {
  plugId: body.plugId, plugName: body.plugName, assigneeSlackId: body.assigneeSlackId, assigneeName: body.assigneeName,
  docsUrl: body.docsUrl, audit, live: body.liveResults || null
})
return { audit, handoffStatus: handoff.status }
`
}

function decideSteps(settings, slackAuthId, tableAuthId) {
  const S = JSON.stringify
  const recheck = `
const b = context?.req?.body || {}
const result = await runAiModel({ inputData: {
  query: 'Findings for plug ' + b.plugName + ': ' + JSON.stringify(b.audit),
  prompt: 'You are the decision agent. Re-check these audit findings against the criteria. Do not repeat the audit: check that each finding is supported by its evidence, that the recommendation follows the verdict rules, and downgrade or upgrade it if it does not. Criteria and verdict rules:\\n' + ${S(readFileSync('criteria.md', 'utf8'))} + '\\nReturn ONLY JSON.',
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
const liveLine = live.status === 'tested'
  ? '*Live test:* ' + live.summary.passed + ' passed, ' + live.summary.failed + ' failed, ' + live.summary.notRun + ' not run (writes are never run)'
  : '*Live test:* not run (' + (live.reason || 'no live results') + ')'
const content = '*Plug review: ' + b.plugName + '* (' + b.plugId + ')\\nAgent recommends: *' + rec + '* | Re-check says: *' + re.verdict + '*\\n' + (b.audit?.summary || '') + '\\n' + liveLine + '\\n' + liveFailed.join('\\n') + '\\n' + lines.join('\\n') + '\\n_Not verified: ' + ((b.audit?.unverified || []).join('; ') || 'nothing listed') + '_'
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
const key = b.plugId + ':' + d.decision
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
  // Developer Hub access is not connected yet: record the decision, do NOT claim the action ran.
  status = d.decision === 'approve' ? 'approved_publish_not_executed' : 'improve_update_not_executed'
  note = 'Developer Hub not connected: ' + (d.decision === 'approve' ? 'publish access not granted' : 'plug not updated')
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
function intakeSteps(reviewUrlValue) {
  const code = `
const row = context?.req?.body || {}
if (!row.name || !row.docs_url) {
  console.log('### Row ' + row.rowid + ' skipped: plug id and docs URL are required')
  return { skipped: 'incomplete row', rowid: row.rowid }
}
const payload = {
  plugId: row.name, plugName: row.plug_name || row.name, docsUrl: row.docs_url,
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

export async function setupFlows(uniqueIdentifier, settings, state, existing = {}) {
  const token = await proxyToken(uniqueIdentifier)
  const slackAuth = state.rowbu58rc.authId
  const tableAuth = state.rowe71n93.authId
  const decideId = existing.decideId || (await createWebhookFlow(token, 'Plug decision agent', 'Re-checks audit findings, asks the reviewer in Slack, then acts and records the decision.'))
  await saveSteps(token, decideId, decideSteps(settings, slackAuth, tableAuth))
  const reviewId = existing.reviewId || (await createWebhookFlow(token, 'Plug review agent', 'Audits a plug against its API docs and hands findings to the decision agent.'))
  await saveSteps(token, reviewId, [
    { stepname: 'audit', code: auditStep(`${RUN}/${decideId}`), service_action_functions: [{ name: 'runAiModel', auth_id: 'NoAuth', action_id: AI.actionId }] }
  ])
  let intakeId = existing.intakeId
  if (settings.queueTableId) {
    if (!intakeId) intakeId = (await post('scrisgf5H0hN', { title: 'Plug intake', description: 'A new row in the plug queue table starts a plug review.', projectId: PROJECT, proxy_auth_token: token })).data.script_id
    // The trigger is bound to a Table connection and table: re-set it when either changed.
    if (!existing.intakeId || existing.queueTableId !== settings.queueTableId || existing.tableAuthId !== tableAuth) await setIntakeTrigger(token, intakeId, tableAuth, settings.queueTableId)
    await saveSteps(token, intakeId, intakeSteps(`${RUN}/${reviewId}`))
  }
  const readBack = await readFlow(token, decideId)
  return { slackAuthId: slackAuth, tableAuthId: tableAuth, reviewId, decideId, intakeId, decideStepNames: (readBack.steps || readBack.data?.steps || []).map((s) => s.stepname) }
}

export const reviewUrl = (reviewId) => `${RUN}/${reviewId}`
