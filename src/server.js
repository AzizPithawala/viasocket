import express from 'express'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { embedToken, enableApp, findEnabledApp, listConnections, listOptions, runAction, connectionsOf, connectionLabel, revokeConnection, setFlowStatus, enabledAppsFor } from './viasocket.js'
import { setupFlows, reviewUrl } from './flows.js'
import { resolvePlug, runLiveTests } from './livetest.js'
import { createAddonsRouter } from './addons/router.js'
import { createLearning } from './review/learning.js'
import { createLearningRouter } from './review/router.js'
import { readDecisionRows } from './review/rows.js'
import { askJson } from './review/ai.js'
import { criteriaText } from './review/criteria.js'
import { schemaChecks, liveFindings, buildCoverage } from './review/checks.js'
import { isConfigured as devhubConfigured, findPlug, getPlugBundle } from './devhub.js'
import { codeChecks, definitionFromBundle, catalogShape } from './review/codechecks.js'
import { searchApps } from './viasocket.js'

const REVIEWER_ID = process.env.REVIEWER_ID || 'plug-reviewer'
const DATA_DIR = process.env.DATA_DIR || 'data'
mkdirSync(DATA_DIR, { recursive: true })
// STAGING=1 runs against separate flows and files so core changes can be tested without touching production.
const STAGING = process.env.STAGING === '1'
const SUFFIX = STAGING ? '.staging' : ''
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
    const mine = connectionsOf(connections, serviceId)
    // The stored active connection wins while it still exists; otherwise take the newest usable one.
    const chosen = mine.find((c) => c.id === state[serviceId]?.authId) || mine[0]
    if (!chosen || (state[serviceId]?.authId === chosen.id && state[serviceId]?.scriptId)) continue
    const scriptId = (await findEnabledApp(REVIEWER_ID, serviceId, chosen.id)) || (await enableApp(REVIEWER_ID, chosen.id, serviceId))
    state[serviceId] = { authId: chosen.id, scriptId }
  }
  saveState(state)
}
const saveState = (state) => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

const app = express()

// Public URL: everything sits behind one shared password (HTTP basic auth).
const PASSWORD = process.env.APP_PASSWORD
app.use((req, res, next) => {
  if (!PASSWORD) return res.status(503).send('APP_PASSWORD is not set')
  // The intake automation calls one endpoint with its own key, so the main password never leaves this app.
  const key = process.env.INTAKE_KEY
  if (key && req.path === '/api/live-test' && req.method === 'POST') {
    const sent = Buffer.from(String(req.headers['x-intake-key'] || ''))
    if (sent.length === Buffer.from(key).length && timingSafeEqual(sent, Buffer.from(key))) return next()
  }
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

// Which saved picks belong to which app's account. They mean nothing in another account.
const STALE_PICKS = { rowbu58rc: ['channelId', 'tlUserId'], rowe71n93: ['tableId', 'queueTableId'] }

/** Make a connection the active one for its app: its own enabled app, and forget picks from the old account. */
async function activateConnection(serviceId, authId) {
  const connections = await listConnections(REVIEWER_ID)
  const connection = connections.find((c) => c.id === authId && String(c.id).endsWith(`_${serviceId}`))
  if (!connection) throw new Error('that connection does not exist for this app')
  if (connection.isExpired) throw new Error('that connection has expired: reconnect it first')

  const scriptId = (await findEnabledApp(REVIEWER_ID, serviceId, authId)) || (await enableApp(REVIEWER_ID, authId, serviceId))
  const state = loadState()
  const changed = state[serviceId]?.authId !== authId
  state[serviceId] = { authId, scriptId }
  saveState(state)

  if (changed) {
    // null, not delete: the seed merge on start only re-adds keys that are missing.
    const settings = loadSettings()
    for (const key of STALE_PICKS[serviceId] || []) settings[key] = null
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
  }
  return { changed, label: connectionLabel(connection) }
}

// Called by the browser after a connection succeeds: make it the active one for that app.
app.post('/api/viasocket/connected', async (req, res) => {
  try {
    const { serviceId, authId } = req.body
    if (!serviceId || !authId) return res.status(400).json({ error: 'missing serviceId or authId' })
    // Test connections for other apps stay on viaSocket; live tests read them from there and enable lazily.
    if (!APPS[serviceId]) return res.json({ ok: true, testConnection: true })
    const { changed } = await activateConnection(serviceId, authId)
    res.json({ ok: true, needsSetup: changed })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Choose which of the app's connections is active.
app.post('/api/viasocket/activate', async (req, res) => {
  try {
    const { serviceId, authId } = req.body
    if (!APPS[serviceId] || !authId) return res.status(400).json({ error: 'unknown app or missing authId' })
    const { changed, label } = await activateConnection(serviceId, authId)
    res.json({ ok: true, needsSetup: changed, label })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Every app's connections for the dropdowns, with the active one marked.
app.get('/api/viasocket/status', async (req, res) => {
  try {
    const connections = await listConnections(REVIEWER_ID)
    const state = loadState()
    const status = Object.fromEntries(
      Object.keys(APPS).map((serviceId) => {
        const mine = connectionsOf(connections, serviceId)
        const active = mine.find((c) => c.id === state[serviceId]?.authId) || null
        return [serviceId, {
          active: active?.id || null,
          connections: mine.map((c) => ({ authId: c.id, label: connectionLabel(c), expired: Boolean(c.isExpired) }))
        }]
      })
    )
    res.json(status)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

const SETTINGS_FILE = `${DATA_DIR}/settings${SUFFIX}.json`
// First start on a fresh DATA_DIR: seed the flow ids so setup updates the existing automations.
if (!STAGING && existsSync('seed/settings.json')) { // staging must never inherit the production flow ids
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
// Columns each table must have (keys as Add Records lists them). A new account starts with no tables.
const DECISION_COLUMNS = ['name', 'plug_name', 'status', 'recommendation', 'reason', 'assignee', 'decided_by', 'decided_at', 'idempotency_key']
const QUEUE_COLUMNS = ['name', 'plug_name', 'docs_url', 'assignee_name', 'assignee_slack']

async function missingColumns(tableId, required, tableAuthId) {
  const fields = await listOptions(REVIEWER_ID, 'rowv9c7j4j40', 'selectedFields', { table: tableId, includeLookupFields: false }, tableAuthId)
  const have = new Set(fields.map((f) => String(f.value).split('@')[0]))
  return required.filter((column) => !have.has(column))
}

// Saving settings (re)creates the automations with the active connections and these picks baked into their steps.
app.post('/api/settings', async (req, res) => {
  try {
    const { channelId, tlUserId, tableId, queueTableId } = req.body
    if (!channelId || !tlUserId || !tableId || !queueTableId) return res.status(400).json({ error: 'channel, team leader, decisions table and queue table are all required' })
    const state = loadState()
    if (!state.rowbu58rc || !state.rowe71n93) return res.status(400).json({ error: 'connect Slack and viaSocket Table first' })

    const problems = []
    const decisionsMissing = await missingColumns(tableId, DECISION_COLUMNS, state.rowe71n93.authId)
    if (decisionsMissing.length) problems.push(`The decisions table is missing columns: ${decisionsMissing.join(', ')}.`)
    const queueMissing = await missingColumns(queueTableId, QUEUE_COLUMNS, state.rowe71n93.authId)
    if (queueMissing.length) problems.push(`The queue table is missing columns: ${queueMissing.join(', ')}.`)
    if (problems.length) return res.status(400).json({ error: problems.join(' ') + ' Add them as text columns in this account, then save again.' })

    const flows = await setupFlows(REVIEWER_ID, { channelId, tlUserId, tableId, queueTableId }, state, loadSettings(), { staging: STAGING })
    writeFileSync(SETTINGS_FILE, JSON.stringify({ channelId, tlUserId, tableId, queueTableId, ...flows }, null, 2))
    res.json({ ok: true, ...flows, accounts: await activeAccountNames() })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Name the accounts the automations now run on, so a switch is visible after saving.
async function activeAccountNames() {
  const connections = await listConnections(REVIEWER_ID)
  const state = loadState()
  const nameOf = (serviceId) => {
    const c = connections.find((x) => x.id === state[serviceId]?.authId)
    return c ? connectionLabel(c) : null
  }
  return { slack: nameOf('rowbu58rc'), table: nameOf('rowe71n93') }
}

// What the active Table account already has, so the pickers can be preselected after a switch.
app.get('/api/setup-hints', async (req, res) => {
  try {
    const authId = loadState().rowe71n93?.authId
    const tables = authId ? await listOptions(REVIEWER_ID, 'rowtzrowrz8v', 'table', {}, authId).catch(() => []) : []
    const byName = (re) => tables.find((t) => re.test(t.label))?.value || null
    res.json({
      decisionsTableId: byName(/^plug_decisions$/i),
      queueTableId: byName(/^plug_queue$/i),
      required: { decisions: DECISION_COLUMNS, queue: QUEUE_COLUMNS },
      accounts: await activeAccountNames()
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Check the chosen tables have the required columns, without saving anything.
app.post('/api/check-tables', async (req, res) => {
  try {
    const { tableId, queueTableId } = req.body
    const authId = loadState().rowe71n93?.authId
    if (!authId) return res.status(400).json({ error: 'connect viaSocket Table first' })
    const result = {}
    if (tableId) result.decisionsMissing = await missingColumns(tableId, DECISION_COLUMNS, authId)
    if (queueTableId) result.queueMissing = await missingColumns(queueTableId, QUEUE_COLUMNS, authId)
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Remove a connection that is not in use: delete the enabled app built on it, then revoke it.
app.delete('/api/viasocket/connections/:authId', async (req, res) => {
  try {
    const { authId } = req.params
    const state = loadState()
    const settings = loadSettings()
    const inUse = Object.values(state).some((s) => s.authId === authId) || [settings.slackAuthId, settings.tableAuthId].includes(authId)
    if (inUse) return res.status(400).json({ error: 'this account is in use: switch to another account first' })
    const connections = await listConnections(REVIEWER_ID)
    if (!connections.some((c) => c.id === authId)) return res.status(404).json({ error: 'connection not found' })
    for (const flow of await enabledAppsFor(REVIEWER_ID, authId)) await setFlowStatus(REVIEWER_ID, flow.id, 0)
    await revokeConnection(REVIEWER_ID, authId)
    res.json({ ok: true })
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
// Test connections: apps a reviewer connects with a test account so plugs under review can be run live.
app.get('/api/apps/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (q.length < 2) return res.json([])
    const found = await searchApps(q)
    res.json(found.slice(0, 8).map((a) => ({ id: a.service_id, name: a.name, icon: a.iconurl })))
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/test-connections', async (req, res) => {
  try {
    const connections = await listConnections(REVIEWER_ID)
    res.json(
      connections
        .filter((c) => !APPS[c.service_id])
        .map((c) => ({ authId: c.id, serviceId: c.service_id, name: c.service_name, icon: c.iconUrl, expired: Boolean(c.isExpired) }))
    )
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Compact, readable plug definition from the catalog, so the audit sees real actions and fields.
function definitionFrom(schema) {
  const fields = (s) => Object.values(s?.blocks || {}).filter((f) => f.type !== 'help').map((f) => ({ key: f.key, label: f.label, type: f.type, required: Boolean(f.required), help: f.help }))
  return {
    auth: { type: schema.service.auth_type || 'unknown' },
    actions: (schema.actions || []).map((a) => ({ name: a.name, description: a.description, inputs: fields(a.input_schema), sampledata: a.sample_output })),
    triggers: (schema.triggers || []).map((t) => ({ name: t.name, description: t.description, inputs: fields(t.input_schema), sampledata: t.sample_output }))
  }
}

// Live tests run here (not in an automation, which stops at 58 s). Answer at once, then hand off to review.
app.post('/api/live-test', (req, res) => {
  const row = req.body || {}
  if (!row.plugId) return res.status(400).json({ error: 'plugId is required' })
  res.status(202).json({ accepted: true })
  ;(async () => {
    const settings = loadSettings()
    const payload = { ...row }
    try {
      const plug = await resolvePlug({ plugName: row.plugName, dhUrl: row.plug?.developerHubUrl })

      // The plug in Developer Hub (read only): its real code, for R3 and R4, and a definition even for a draft.
      let bundle = null, devhubNote = null, ambiguous = false, lookupFailed = false
      if (!devhubConfigured()) devhubNote = 'Developer Hub is not configured'
      else {
        try {
          const hit = await findPlug({ dhUrl: row.plug?.developerHubUrl, serviceId: plug.serviceId, name: row.plugName })
          if (!hit.plug) { devhubNote = hit.reason; ambiguous = Boolean(hit.ambiguous) }
          else {
            bundle = await getPlugBundle(hit.plug)
            if (!bundle.operations.length) { devhubNote = `"${hit.plug.name}" has no actions or triggers with a saved version yet`; bundle = null }
          }
        } catch (error) { devhubNote = error.message; lookupFailed = true }
      }

      // The catalog only counts when it is the same plug Developer Hub holds. A public app that merely shares
      // the name is a different plug, and its definition must not stand in for the plug under review.
      const sameAsCatalog = !plug.unresolved && bundle && plug.serviceId === bundle.plug.rowid
      let schemaResult = { findings: [], patch: [] }
      // If Developer Hub cannot say which plug is meant (ambiguous name, or the lookup failed), the catalog is not
      // used as a stand-in: a same-named public app is a different plug and must never be reviewed in its place.
      if (!plug.unresolved && !ambiguous && !lookupFailed && (!bundle || sameAsCatalog)) {
        payload.plug = { ...row.plug, ...definitionFrom(plug.schema) }
        payload.liveResults = await runLiveTests(plug)
        schemaResult = schemaChecks(plug.schema)
      } else if (bundle) {
        // Not the catalog's plug (a draft, or private): Developer Hub supplies the definition. Live runs for these come later.
        payload.plug = { ...row.plug, ...definitionFromBundle(bundle) }
        payload.liveResults = { status: 'not_tested', reason: 'This plug is not in the public catalog (a draft or private plug): live runs for these are not built yet' }
        schemaResult = schemaChecks(catalogShape(bundle))
      } else {
        payload.liveResults = { status: 'not_resolved', reason: 'Could not match this plug to a published app or find it in Developer Hub. ' + (devhubNote || '') + (plug.candidates?.length ? ' Catalog candidates: ' + plug.candidates.map((c) => c.name).join(', ') : '') }
      }
      const live = liveFindings(payload.liveResults)
      const code = bundle ? codeChecks(bundle) : { findings: [], stats: null }
      // Rules decided by code: schema checks (I1, I2, I3), live failures that are the plug's own (R1), plug code (R3, R4).
      payload.preFindings = [...live.findings, ...code.findings, ...schemaResult.findings]
      payload.patch = schemaResult.patch
      payload.notCounted = live.notCounted
      // Plug code is only "assessed" when Developer Hub really supplied it; otherwise R3 and R4 stay "not assessed".
      payload.coverage = buildCoverage({ live: payload.liveResults, codeAvailable: Boolean(bundle) })
      if (!bundle) payload.coverage.reasons = { R3: 'plug code not read: ' + devhubNote, R4: 'plug code not read: ' + devhubNote }
      else if (payload.liveResults.status !== 'tested') payload.coverage.reasons = { R1: payload.liveResults.reason }
      payload.devhub = bundle ? { plug: bundle.plug.name, status: bundle.plug.status, versions: code.stats.versions.slice(0, 12), codeBlocks: code.stats.codeBlocks } : { note: devhubNote }
      try { payload.criteriaText = criteriaText(learning.activeLessons()) } catch { /* the review falls back to the criteria baked into the flow */ }
    } catch (error) {
      payload.liveResults = { status: 'error', reason: error.message }
    }
    try {
      await fetch(reviewUrl(settings.reviewId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    } catch (error) {
      console.error('hand-off to review failed:', error.message)
    }
  })()
})

// Points and lessons: learned from the decisions table the core already writes.
const learning = createLearning({
  dataDir: DATA_DIR, suffix: SUFFIX, askJson, baselineOnFirstRun: process.env.LEARN_FROM_HISTORY !== '1',
  readRows: () => readDecisionRows({ state: loadState(), settings: loadSettings() })
})
app.use('/api/learning', createLearningRouter({ learning }))
setInterval(() => learning.sync().catch((e) => console.error('learning sync failed:', e.message)), 5 * 60 * 1000)

// Add-ons: built on top of the decisions data, in their own code and their own automations.
app.use('/api/addons', createAddonsRouter({ loadState, loadSettings, dataDir: DATA_DIR, reviewerId: REVIEWER_ID }))

recoverState().catch((error) => console.error('state recovery failed:', error.message))
app.listen(port, '0.0.0.0', () => console.log(`listening on http://localhost:${port}`))
