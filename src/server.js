import express from 'express'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { embedToken, enableApp, findEnabledApp, listConnections, listOptions, runAction } from './viasocket.js'
import { setupFlows, reviewUrl } from './flows.js'

const REVIEWER_ID = process.env.REVIEWER_ID || 'plug-reviewer'
const DATA_DIR = process.env.DATA_DIR || 'data'
mkdirSync(DATA_DIR, { recursive: true })
const STATE_FILE = `${DATA_DIR}/state.json`
const APPS = {
  rowbu58rc: 'Slack',
  rowe71n93: 'viaSocket Table'
}

const loadState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {})

// After a redeploy or a fresh DATA_DIR the connections still exist on viaSocket: rebuild from there.
async function recoverState() {
  const state = loadState()
  const connections = await listConnections(REVIEWER_ID)
  for (const serviceId of Object.keys(APPS)) {
    const match = connections.find((c) => String(c.id).endsWith(`_${serviceId}`))
    if (!match || state[serviceId]?.authId === match.id) continue
    const scriptId = (await findEnabledApp(REVIEWER_ID, serviceId)) || (await enableApp(REVIEWER_ID, match.id, serviceId))
    state[serviceId] = { authId: match.id, scriptId }
  }
  saveState(state)
}
const saveState = (state) => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

const app = express()

// Public URL: everything sits behind one shared password (HTTP basic auth).
const PASSWORD = process.env.APP_PASSWORD
app.use((req, res, next) => {
  if (!PASSWORD) return res.status(503).send('APP_PASSWORD is not set')
  const given = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':')
  const a = Buffer.from(given), b = Buffer.from(PASSWORD)
  if (a.length === b.length && timingSafeEqual(a, b)) return next()
  res.set('WWW-Authenticate', 'Basic realm="Plug review"').status(401).send('Password required')
})
app.use(express.json())
app.use(express.static('public'))

// Token for the Connect popup only; the secret never leaves the server.
app.get('/api/viasocket/token', (req, res) => {
  res.json({ token: embedToken(REVIEWER_ID) })
})

// Called by the browser after a connection succeeds: enable the app, keep script_id server-side.
app.post('/api/viasocket/connected', async (req, res) => {
  try {
    const { serviceId, authId } = req.body
    if (!APPS[serviceId] || !authId) return res.status(400).json({ error: 'unknown app or missing authId' })

    let scriptId = await findEnabledApp(REVIEWER_ID, serviceId)
    if (!scriptId) scriptId = await enableApp(REVIEWER_ID, authId, serviceId)

    const state = loadState()
    state[serviceId] = { authId, scriptId }
    saveState(state)
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Connection status for the page: which apps are connected and whether any expired.
app.get('/api/viasocket/status', async (req, res) => {
  try {
    const connections = await listConnections(REVIEWER_ID)
    const status = Object.fromEntries(
      Object.keys(APPS).map((serviceId) => {
        const match = connections.find((c) => String(c.id).endsWith(`_${serviceId}`))
        return [serviceId, match ? { authId: match.id, expired: Boolean(match.isExpired) } : null]
      })
    )
    res.json(status)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})


const SETTINGS_FILE = `${DATA_DIR}/settings.json`
// First start on a fresh DATA_DIR: seed the flow ids so setup updates the existing automations.
if (existsSync('seed/settings.json')) {
  const seed = JSON.parse(readFileSync('seed/settings.json', 'utf8'))
  const current = existsSync(SETTINGS_FILE) ? JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) : {}
  // Keys already saved here win; keys only the seed has (such as newly created flow ids) are added.
  writeFileSync(SETTINGS_FILE, JSON.stringify({ ...seed, ...current, ...Object.fromEntries(Object.entries(seed).filter(([k]) => current[k] === undefined)) }, null, 2))
}
const loadSettings = () => (existsSync(SETTINGS_FILE) ? JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) : {})

// Pickers: values that depend on the reviewer's own workspace are chosen by the reviewer, once.
app.get('/api/options/:kind', async (req, res) => {
  try {
    const state = loadState()
    const slack = state.rowbu58rc?.authId
    const table = state.rowe71n93?.authId
    const kind = req.params.kind
    let options
    if (kind === 'channels') options = await listOptions(REVIEWER_ID, 'rowcw5hseskl', 'channel_id', { messageto: 'channel' }, slack)
    else if (kind === 'users') options = await listOptions(REVIEWER_ID, 'rowcw5hseskl', 'userId', { messageto: 'user' }, slack)
    else if (kind === 'tables') options = await listOptions(REVIEWER_ID, 'rowtzrowrz8v', 'table', {}, table)
    else return res.status(404).json({ error: 'unknown picker' })
    res.json(options.map(({ label, value }) => ({ label, value })))
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/settings', (req, res) => res.json(loadSettings()))

// Saving settings (re)creates the two automations with those values baked into their steps.
app.post('/api/settings', async (req, res) => {
  try {
    const { channelId, tlUserId, tableId, queueTableId } = req.body
    if (!channelId || !tlUserId || !tableId) return res.status(400).json({ error: 'channelId, tlUserId and tableId are required' })
    const state = loadState()
    if (!state.rowbu58rc || !state.rowe71n93) return res.status(400).json({ error: 'connect Slack and viaSocket Table first' })
    const flows = await setupFlows(REVIEWER_ID, { channelId, tlUserId, tableId, queueTableId }, state, loadSettings())
    writeFileSync(SETTINGS_FILE, JSON.stringify({ channelId, tlUserId, tableId, queueTableId, ...flows }, null, 2))
    res.json({ ok: true, ...flows })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Submit plugs for review. The plug definition comes in the body until Developer Hub is connected.
app.post('/api/reviews', async (req, res) => {
  try {
    const settings = loadSettings()
    if (!settings.reviewId) return res.status(400).json({ error: 'save settings first' })
    const plugs = Array.isArray(req.body) ? req.body : [req.body]
    const results = []
    for (const plug of plugs) {
      const response = await fetch(reviewUrl(settings.reviewId), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plug)
      })
      const body = await response.json().catch(() => ({}))
      results.push({ plugId: plug.plugId, status: response.status, body })
    }
    res.json(results)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Recent decisions for the dashboard, newest first. Blank starter rows have no plug id and are dropped.
app.get('/api/decisions', async (req, res) => {
  try {
    const { tableId } = loadSettings()
    const scriptId = loadState().rowe71n93?.scriptId
    if (!tableId || !scriptId) return res.json([])
    const rows = await runAction(scriptId, 'rowhk32rn3e0', { table: tableId, filter_mode: 'list_all', queryopt: { limit: '500' } })
    const list = Array.isArray(rows) ? rows : rows.data || rows.rows || []
    const decisions = list
      .filter((r) => r.name)
      .map((r) => ({
        plugId: r.name, plugName: r.plug_name, status: r.status, recommendation: r.recommendation,
        reason: r.reason, assignee: r.assignee, decidedBy: r.decided_by, decidedAt: r.decided_at
      }))
      .sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)))
      .slice(0, 50)
    res.json(decisions)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Add a plug to the review queue; the intake automation picks the row up.
app.post('/api/queue', async (req, res) => {
  try {
    const { queueTableId } = loadSettings()
    const scriptId = loadState().rowe71n93?.scriptId
    const { plugId, plugName, docsUrl, assigneeName, assigneeSlackId } = req.body
    if (!queueTableId || !scriptId) return res.status(400).json({ error: 'save settings with a queue table first' })
    if (!plugId || !docsUrl) return res.status(400).json({ error: 'plug id and docs URL are required' })
    const field = {
      'name@longtext': plugId, 'plug_name@longtext': plugName || plugId, 'docs_url@longtext': docsUrl,
      'assignee_name@longtext': assigneeName || '', 'assignee_slack@longtext': assigneeSlackId || ''
    }
    await runAction(scriptId, 'rowv9c7j4j40', {
      table: queueTableId, bulkAdd: false, includeLookupFields: false, addMissingOptions: false,
      selectedFields: Object.keys(field), field
    })
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

const port = process.env.PORT || 3000
recoverState().catch((error) => console.error('state recovery failed:', error.message))
app.listen(port, '0.0.0.0', () => console.log(`listening on http://localhost:${port}`))
