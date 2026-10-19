// Breaks a throwaway alert on purpose (bad Slack channel) and shows how the monitor explains the failure.
import { readFileSync } from 'node:fs'
import { embedToken, setFlowStatus } from '../src/viasocket.js'
import { alertSteps } from '../src/addons/templates.js'
import { explain } from '../src/addons/monitor.js'
import { listConnections, listOptions } from '../src/viasocket.js'

const U = process.env.REVIEWER_ID || 'plug-reviewer', D = process.env.DATA_DIR || 'data'
const state = JSON.parse(readFileSync(`${D}/state.json`, 'utf8')), settings = JSON.parse(readFileSync(`${D}/settings.json`, 'utf8'))
const token = (await (await fetch(`${process.env.VIASOCKET_API_URL}/users/register`, { headers: { authorization: embedToken(U) } })).json()).data.token
const RUN = `${process.env.VIASOCKET_RUN_URL}/func`
const post = async (fn, body) => (await fetch(`${RUN}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()
const id = (await post('scrisgf5H0hN', { title: 'Add-on DIAG TEST (auto-deleted)', description: 'x', projectId: process.env.VIASOCKET_PROJECT_ID, proxy_auth_token: token })).data.script_id
try {
  await post('scrij2DSRMlP', { scriptId: id, projectId: process.env.VIASOCKET_PROJECT_ID, triggerType: 'webhook', proxy_auth_token: token })
  await post('scrigkyMNOEC', { scriptId: id, steps: alertSteps({}, { channelId: 'CFAKE00000', tableId: settings.tableId, tableAuthId: state.rowe71n93.authId, slackAuthId: state.rowbu58rc.authId }), proxy_auth_token: token })
  const res = await post(id, { status: 'reject', name: 'DIAG-1', plug_name: 'Diag plug', reason: 'x' })
  console.log('webhook answered:', JSON.stringify(res).slice(0, 200))
  let runs = []
  for (let i = 0; i < 12 && !runs.length; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    runs = (await (await fetch(`${process.env.VIASOCKET_API_URL}/logs/orgId/${process.env.VIASOCKET_ORG_ID}?projectId=${process.env.VIASOCKET_PROJECT_ID}&scriptId=${id}&page=1&limit=1`, { headers: { proxy_auth_token: token } })).json()).data?.finalResponse || []
  }
  const r = runs[0]
  if (!r) console.log('no run recorded')
  else { console.log('RUN status:', r.status, '| output:', String(r.output).slice(0, 160)); console.log('SNAPSHOT:', String(r.responseSnapshot).slice(0, 400)); console.log('CONSOLE:', JSON.stringify(r.console).slice(0, 300)); const probes = {
    connections: () => listConnections(U),
    channels: async () => (await listOptions(U, 'rowj2u3wc8h5', 'destination.channel_id', {}, state.rowbu58rc.authId)).map((c) => c.value),
    tables: async () => (await listOptions(U, 'rowtzrowrz8v', 'table', {}, state.rowe71n93.authId)).map((t) => t.value)
  }
  console.log('EXPLAINED:', JSON.stringify(await explain(r, probes), null, 1))
  }
} finally { await setFlowStatus(U, id, 0).catch(() => {}); console.log('deleted', id) }
