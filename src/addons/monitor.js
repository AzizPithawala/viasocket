// Explains why an add-on run failed. viaSocket's run history does not keep an app's own error text for a
// failed action (only the payload that was sent), so the cause is found by checking the likely culprits with
// read-only probes: is the connection valid, does the channel still exist, does the table still exist.
// It only reads; fixes that change anything are offered as buttons and applied by the user.

// Failures viaSocket itself reports in words (not app errors).
const SYSTEM_RULES = [
  { cause: 'timeout', re: /58 seconds|execution limit|timed out/i, message: 'The run took longer than the 58 seconds viaSocket allows.', fix: { type: 'narrow', label: 'Use a shorter period' } },
  { cause: 'paused', re: /currently paused|has been deleted/i, message: 'The add-on is paused or was deleted on viaSocket.', fix: { type: 'resume', label: 'Resume it' } }
]

export function inspect(run) {
  const status = String(run.status).toLowerCase()
  const consoleText = JSON.stringify(run.console || {})
  const failed = (status !== 'success' && status !== 'paused') || /"error"\s*:/.test(String(run.output)) || /some error occur/i.test(consoleText)
  if (!failed) return { failed: false }
  let snapshot = {}
  try { snapshot = JSON.parse(run.responseSnapshot || '{}') } catch { /* keep empty */ }
  const stepName = Object.keys(snapshot).find((k) => snapshot[k] && typeof snapshot[k] === 'object' && 'error' in snapshot[k])
  const failure = stepName ? snapshot[stepName].error : null
  return { failed: true, stepName, payload: failure?.pluginPayload || null, authId: failure?.authId || null, words: [run.errorMessage, consoleText].map(String).join(' ') }
}

/** probes: { connections(): [{id, isExpired}], channels(): [id], tables(): [id] } */
export async function explain(run, probes) {
  const info = inspect(run)
  if (!info.failed) return { ok: true }

  const system = SYSTEM_RULES.find((r) => r.re.test(info.words))
  if (system) return { ok: false, cause: system.cause, message: system.message, fix: system.fix }

  const connections = await probes.connections().catch(() => [])
  if (info.authId) {
    const conn = connections.find((c) => c.id === info.authId)
    if (!conn) return { ok: false, cause: 'connection', message: 'The connection this add-on uses no longer exists.', fix: { type: 'reconnect', label: 'Connect the account again, then rebuild the add-on' }, evidence: 'connection ' + info.authId + ' is not on viaSocket any more' }
    if (conn.isExpired) return { ok: false, cause: 'connection', message: 'The connection this add-on uses has expired.', fix: { type: 'reconnect', label: 'Reconnect the account' }, evidence: 'connection marked expired' }
  }
  const channel = info.payload?.destination?.channel_id?.[0]
  if (channel) {
    const known = await probes.channels().catch(() => null)
    if (known && !known.includes(channel)) return { ok: false, cause: 'channel', message: 'The Slack channel is not visible to the connected account any more (deleted, archived or renamed).', fix: { type: 'repick_channel', label: 'Delete this add-on and build it again with another channel' }, evidence: 'channel ' + channel + ' is not in the account\'s channel list' }
  }
  const table = info.payload?.table
  if (table) {
    const known = await probes.tables().catch(() => null)
    if (known && !known.includes(table)) return { ok: false, cause: 'table', message: 'The decisions table no longer exists in the connected Table account.', fix: { type: 'settings', label: 'Check the review settings' }, evidence: 'table ' + table + ' is not listed' }
  }
  // Nothing checkable is wrong: say what is known and what is only likely, never guess silently.
  if (channel) return { ok: false, cause: 'channel_access', message: 'Slack refused the message although the channel exists. Most likely the app has not been added to that channel.', fix: { type: 'repick_channel', label: 'Add the app to the channel or pick another one' }, evidence: 'connection valid, channel listed, step "' + info.stepName + '" failed', likely: true }
  return { ok: false, cause: 'unknown', message: 'The run failed and none of the usual causes checked out.', fix: null, evidence: 'step "' + (info.stepName || '?') + '" failed' }
}

export async function recentRuns({ proxyToken, scriptId, probes, limit = 5 }) {
  const url = `${process.env.VIASOCKET_API_URL}/logs/orgId/${process.env.VIASOCKET_ORG_ID}?projectId=${process.env.VIASOCKET_PROJECT_ID}&scriptId=${scriptId}&page=1&limit=${limit}`
  const response = await fetch(url, { headers: { proxy_auth_token: proxyToken } })
  const runs = (await response.json()).data?.finalResponse || []
  return Promise.all(runs.map(async (r) => ({ at: r.createdAt, status: r.status, ...(await explain(r, probes)) })))
}

/** Is the add-on still built on the accounts the agent currently uses? (A switch leaves it on the old one.) */
export function staleness(item, state) {
  const stale = []
  if (item.slackAuthId !== state.rowbu58rc?.authId) stale.push('Slack account changed since this add-on was built')
  if (item.tableAuthId !== state.rowe71n93?.authId) stale.push('Table account changed since this add-on was built')
  return stale
}
