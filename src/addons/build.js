import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { embedToken, listOptions, runAction, setFlowStatus } from '../viasocket.js'
import { cronStatement, WEEKDAYS } from './spec.js'
import { computeDigest, formatDigest, computeByDeveloper, formatByDeveloper, formatRejectAlert, scheduledSteps, alertSteps, ACTION_IDS } from './templates.js'

const PROJECT = process.env.VIASOCKET_PROJECT_ID
const RUN = () => `${process.env.VIASOCKET_RUN_URL}/func`
const TABLE_ROW_CREATED = 'rownvhf0ucl6'
const GET_ROWS_VERSION = 'rowhk32rn3e0'
const SEND_MESSAGE_VERSION = 'rowj2u3wc8h5'

/** Everything an add-on does goes through this service. It never writes to the core's tables or flows. */
export function createAddonService({ loadState, loadSettings, dataDir, reviewerId }) {
  mkdirSync(dataDir, { recursive: true })
  const file = `${dataDir}/addons.json`
  const list = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [])
  const save = (items) => writeFileSync(file, JSON.stringify(items, null, 2))

  async function proxyToken() {
    const response = await fetch(`${process.env.VIASOCKET_API_URL}/users/register`, { headers: { authorization: embedToken(reviewerId) } })
    const token = (await response.json()).data?.token
    if (!token) throw new Error('could not derive proxy_auth_token')
    return token
  }

  async function post(fn, body) {
    const response = await fetch(`${RUN()}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const payload = await response.json()
    // A refused call still answers HTTP 200: the refusal is in the body.
    if (payload.status === 400 || payload.data?.success === false) throw new Error(payload.data?.message || payload.message || `${fn} refused`)
    return payload
  }

  const context = () => {
    const state = loadState(), settings = loadSettings()
    if (!state.rowe71n93 || !state.rowbu58rc) throw new Error('connect Slack and viaSocket Table first')
    if (!settings.tableId) throw new Error('save the review settings first (decisions table)')
    return { tableId: settings.tableId, tableAuthId: state.rowe71n93.authId, slackAuthId: state.rowbu58rc.authId, tableScript: state.rowe71n93.scriptId, slackScript: state.rowbu58rc.scriptId }
  }

  /** Read the decisions table (read only), up to 2,000 rows. */
  async function readDecisions() {
    const c = context()
    let rows = []
    for (let offset = 0, i = 0; i < 4; i++, offset += 500) {
      const page = await runAction(c.tableScript, GET_ROWS_VERSION, { table: c.tableId, filter_mode: 'list_all', queryopt: { limit: '500', offset: String(offset) } })
      const batch = Array.isArray(page) ? page : page?.data || page?.rows || []
      rows = rows.concat(batch)
      if (batch.length < 500) break
    }
    return rows.filter((r) => r.name)
  }

  /** What the add-on would send right now. Computed with the same functions the automation embeds. */
  async function preview(spec) {
    const rows = await readDecisions()
    if (spec.kind === 'digest') {
      const opts = { periodDays: spec.period_days, now: Date.now() }
      const counts = computeDigest(rows, opts)
      // Independent count, written differently, so a bug in the shared function would show up here.
      const cutoff = opts.now - opts.periodDays * 86400000
      const inWindow = rows.filter((r) => Date.parse(r.decided_at) >= cutoff)
      const check = { approved: inWindow.filter((r) => /^approve/.test(r.status)).length, rejected: inWindow.filter((r) => r.status === 'reject').length, improved: inWindow.filter((r) => /^improve/.test(r.status)).length }
      const verified = check.approved === counts.approved && check.rejected === counts.rejected && check.improved === counts.improved
      return { text: formatDigest(counts, opts), counts, rowsRead: rows.length, verified }
    }
    if (spec.kind === 'developer_summary') return { text: formatByDeveloper(computeByDeveloper(rows)), rowsRead: rows.length, verified: true }
    if (spec.kind === 'event_alert') {
      const last = [...rows].reverse().find((r) => r.status === 'reject')
      return { text: last ? formatRejectAlert(last) : 'No rejected plug yet. When one is recorded, the message will look like:\n*Plug rejected: <name>* (<id>)\nDeveloper: <name>\n• <reason>', rowsRead: rows.length, verified: true, example: Boolean(last) }
    }
    throw new Error('this kind cannot be previewed')
  }

  /** A real message, only when the user clicks "Send a test". Marked as a test. */
  async function sendTest(spec, params) {
    const c = context()
    const { text } = await preview(spec)
    await runAction(c.slackScript, SEND_MESSAGE_VERSION, { destination: { messageto: 'channel', channel_id: [params.channelId] }, markdown_content: `:test_tube: *Test of an add-on (not live yet)*\n${text}` })
    return { sent: true }
  }

  /** Create the add-on's own automation. Nothing exists on viaSocket before this call. */
  async function enable(spec, params) {
    if (!params.channelId) throw new Error('choose a Slack channel')
    const c = context()
    const channels = await listOptions(reviewerId, SEND_MESSAGE_VERSION, 'destination.channel_id', {}, c.slackAuthId).catch(() => [])
    const channelLabel = channels.find((o) => o.value === params.channelId)?.label || params.channelId
    const token = await proxyToken()
    const title = `Add-on: ${spec.summary.slice(0, 60)}`
    const created = await post('scrisgf5H0hN', { title, description: spec.summary, projectId: PROJECT, proxy_auth_token: token })
    const scriptId = created.data.script_id
    try {
      const p = { channelId: params.channelId, tableId: c.tableId, tableAuthId: c.tableAuthId, slackAuthId: c.slackAuthId }
      let steps
      if (spec.kind === 'event_alert') {
        await post('scrij2DSRMlP', { scriptId, projectId: PROJECT, triggerType: 'plugin', trigger_id: TABLE_ROW_CREATED, auth_id: c.tableAuthId, inputData: { table: c.tableId }, proxy_auth_token: token })
        steps = alertSteps(spec, p)
      } else {
        await post('scrij2DSRMlP', { scriptId, projectId: PROJECT, triggerType: 'cron', cronStatement: cronStatement(spec.schedule), proxy_auth_token: token })
        steps = scheduledSteps(spec, p)
      }
      await post('scrigkyMNOEC', { scriptId, steps, proxy_auth_token: token })
      const back = (await post('scriiZYPU6I3', { scriptId, env: 'prod', proxy_auth_token: token }))
      const flow = back.data?.steps ? back.data : back
      const record = { id: `ad_${randomUUID().slice(0, 8)}`, title: spec.summary, kind: spec.kind, spec, params: { channelId: params.channelId, channelLabel }, scriptId, status: 'enabled', slackAuthId: c.slackAuthId, tableAuthId: c.tableAuthId, schedule: flow.trigger?.cron_statement || null, stepsSaved: (flow.steps || []).length, createdAt: new Date().toISOString() }
      save([...list(), record])
      return record
    } catch (error) {
      // Do not leave a half-built automation behind.
      await setFlowStatus(reviewerId, scriptId, 0).catch(() => {})
      throw error
    }
  }

  /** pause (2), resume (1) or delete (0) one add-on's own automation; the core is never touched. */
  async function setStatus(id, action) {
    const items = list(), item = items.find((x) => x.id === id)
    if (!item) throw new Error('add-on not found')
    const code = { pause: 2, resume: 1, delete: 0 }[action]
    if (code === undefined) throw new Error('unknown action')
    await setFlowStatus(reviewerId, item.scriptId, code)
    if (action === 'delete') save(items.filter((x) => x.id !== id))
    else { item.status = action === 'pause' ? 'paused' : 'enabled'; save(items) }
    return item
  }

  async function pauseAll() {
    const items = list().filter((x) => x.status === 'enabled')
    for (const item of items) await setStatus(item.id, 'pause')
    return { paused: items.length }
  }

  return { list, preview, sendTest, enable, setStatus, pauseAll, proxyToken, context }
}
