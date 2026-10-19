// Runs a digest add-on's real steps inside viaSocket on a short schedule, prints what happened, then deletes it.
//   node --env-file=.env scripts/addon-run-test.mjs
import { readFileSync } from 'node:fs'
import { embedToken, setFlowStatus } from '../src/viasocket.js'
import { scheduledSteps } from '../src/addons/templates.js'

const U = process.env.REVIEWER_ID || 'plug-reviewer', D = process.env.DATA_DIR || 'data'
const state = JSON.parse(readFileSync(`${D}/state.json`, 'utf8')), settings = JSON.parse(readFileSync(`${D}/settings.json`, 'utf8'))
const token = (await (await fetch(`${process.env.VIASOCKET_API_URL}/users/register`, { headers: { authorization: embedToken(U) } })).json()).data.token
const post = async (fn, body) => { const r = await (await fetch(`${process.env.VIASOCKET_RUN_URL}/func/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); if (r.status === 400 || r.data?.success === false) throw new Error(r.data?.message || r.message); return r }
const spec = { kind: process.argv[2] || 'digest', period_days: 7 }
const created = await post('scrisgf5H0hN', { title: 'Add-on TEST (auto-deleted)', description: 'step test', projectId: process.env.VIASOCKET_PROJECT_ID, proxy_auth_token: token })
const id = created.data.script_id
console.log('flow', id)
try {
  await post('scrij2DSRMlP', { scriptId: id, projectId: process.env.VIASOCKET_PROJECT_ID, triggerType: 'cron', cronStatement: 'Every 5 minutes', proxy_auth_token: token })
  await post('scrigkyMNOEC', { scriptId: id, steps: scheduledSteps(spec, { channelId: process.argv[3] || 'C0C5LSUNPBK', tableId: settings.tableId, tableAuthId: state.rowe71n93.authId, slackAuthId: state.rowbu58rc.authId }), proxy_auth_token: token })
  for (let i = 0; i < 40; i++) {
    const r = (await (await fetch(`${process.env.VIASOCKET_API_URL}/logs/orgId/${process.env.VIASOCKET_ORG_ID}?projectId=${process.env.VIASOCKET_PROJECT_ID}&scriptId=${id}&page=1&limit=1`, { headers: { proxy_auth_token: token } })).json()).data?.finalResponse?.[0]
    if (r) { console.log('RUN', r.status, r.createdAt); console.log('STEP RESULTS', String(r.responseSnapshot).slice(0, 1200)); for (const [k, v] of Object.entries(r.console || {})) console.log(' step', k, String(v).slice(0, 200).replace(/\n/g, ' ')); break }
    await new Promise((x) => setTimeout(x, 15000))
  }
} finally { await setFlowStatus(U, id, 0).catch((e) => console.log('delete failed', e.message)); console.log('deleted', id) }
