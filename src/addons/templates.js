// Vetted step templates. The pure functions below run in two places with the same source: in the backend
// (for the preview) and inside the add-on's automation on viaSocket (embedded with Function#toString), so a
// preview shows exactly what the automation will compute.

export function computeDigest(rows, opts) {
  const cutoff = opts.periodDays ? opts.now - opts.periodDays * 86400000 : 0
  const counts = { approved: 0, rejected: 0, improved: 0, other: 0 }
  for (const r of rows) {
    if (!r.name) continue // blank starter rows of a new table
    if (opts.periodDays && !(Date.parse(r.decided_at) >= cutoff)) continue
    const s = String(r.status || '')
    if (s.startsWith('approve')) counts.approved++
    else if (s.startsWith('improve')) counts.improved++
    else if (s === 'reject') counts.rejected++
    else counts.other++
  }
  return counts
}

export function formatDigest(counts, opts) {
  const total = counts.approved + counts.rejected + counts.improved + counts.other
  const span = opts.periodDays === 1 ? 'the last day' : `the last ${opts.periodDays} days`
  return `*Plug review digest* (${span})\n• Approved: ${counts.approved}\n• Rejected: ${counts.rejected}\n• Needs improvement: ${counts.improved}\n_${total} decision${total === 1 ? '' : 's'} recorded._`
}

// Latest decision per plug decides what is "open" for a developer.
export function computeByDeveloper(rows) {
  const latest = {}
  for (const r of rows) {
    if (!r.name) continue
    const t = Date.parse(r.decided_at) || 0
    if (!latest[r.name] || t >= latest[r.name].t) latest[r.name] = { t, status: String(r.status || ''), assignee: r.assignee || 'Unassigned', plug: r.plug_name || r.name }
  }
  const byDev = {}
  for (const p of Object.values(latest)) {
    const d = (byDev[p.assignee] = byDev[p.assignee] || { improve: [], rejected: [] })
    if (p.status.startsWith('improve')) d.improve.push(p.plug)
    else if (p.status === 'reject') d.rejected.push(p.plug)
  }
  return byDev
}

export function formatByDeveloper(byDev) {
  const names = Object.keys(byDev).filter((n) => byDev[n].improve.length || byDev[n].rejected.length)
  if (!names.length) return '*Developer summary*\nNothing open: no plug is waiting on improvements or rejected.'
  return '*Developer summary*\n' + names.map((n) => `• *${n}*: ${byDev[n].improve.length} to improve${byDev[n].improve.length ? ' (' + byDev[n].improve.join(', ') + ')' : ''}, ${byDev[n].rejected.length} rejected${byDev[n].rejected.length ? ' (' + byDev[n].rejected.join(', ') + ')' : ''}`).join('\n')
}

export function formatRejectAlert(row) {
  return `*Plug rejected: ${row.plug_name || row.name}* (${row.name})\nDeveloper: ${row.assignee || 'unassigned'}\n${String(row.reason || '').split(' || ')[0].split(' | ').slice(0, 4).map((x) => '• ' + x).join('\n')}`
}

const src = (...fns) => fns.map((f) => f.toString()).join('\n')

// Reads every row (up to 2,000) of the decisions table with the Table connection.
const readRows = (tableId) => `
let rows = []
for (let offset = 0, i = 0; i < 4; i++, offset += 500) {
  const page = await getRows({ inputData: { table: ${JSON.stringify(tableId)}, filter_mode: 'list_all', queryopt: { limit: '500', offset: String(offset) } } })
  const list = Array.isArray(page) ? page : (page?.data || page?.rows || [])
  rows = rows.concat(list)
  if (list.length < 500) break
}
console.log('### Read ' + rows.length + ' rows from the decisions table')
return { rows, truncated: rows.length >= 2000 }
`

const sendToSlack = (channelId) => `
const text = context?.res?.compute?.text
if (!text) { console.log('### Nothing to send'); return { skipped: 'nothing to send' } }
await sendMessage({ inputData: { destination: { messageto: 'channel', channel_id: [${JSON.stringify(channelId)}] }, markdown_content: text } })
console.log('### Message sent')
return { sent: true }
`

const fn = (name, auth_id, action_id) => ({ name, auth_id, action_id })
const ACTIONS = { getRows: 'rowrfcbb0mkf', sendMessage: 'row1jrbor' }

/** Steps for a scheduled add-on (digest, developer summary). */
export function scheduledSteps(spec, p) {
  const read = { stepname: 'read', code: readRows(p.tableId), service_action_functions: [fn('getRows', p.tableAuthId, ACTIONS.getRows)] }
  const computeCode = spec.kind === 'digest'
    ? `${src(computeDigest, formatDigest)}\nconst rows = context?.res?.read?.rows || []\nconst opts = { periodDays: ${spec.period_days}, now: Date.now() }\nreturn { counts: computeDigest(rows, opts), text: formatDigest(computeDigest(rows, opts), opts) + (context?.res?.read?.truncated ? '\\n_Only the latest 2,000 rows were read._' : '') }`
    : `${src(computeByDeveloper, formatByDeveloper)}\nconst rows = context?.res?.read?.rows || []\nreturn { text: formatByDeveloper(computeByDeveloper(rows)) }`
  return [read, { stepname: 'compute', code: computeCode, service_action_functions: [] }, { stepname: 'send', code: sendToSlack(p.channelId), service_action_functions: [fn('sendMessage', p.slackAuthId, ACTIONS.sendMessage)] }]
}

/** Steps for the reject alert; it runs on each new row of the decisions table. */
export function alertSteps(spec, p) {
  const code = `${src(formatRejectAlert)}
const row = context?.req?.body || {}
if (row.status !== 'reject') { console.log('### Skipped: status is ' + row.status); return { skipped: 'not a reject' } }
const text = formatRejectAlert(row)
await sendMessage({ inputData: { destination: { messageto: 'channel', channel_id: [${JSON.stringify(p.channelId)}] }, markdown_content: text } })
console.log('### Reject alert sent for ' + row.name)
return { sent: true, plug: row.name }
`
  return [{ stepname: 'alert', code, service_action_functions: [fn('sendMessage', p.slackAuthId, ACTIONS.sendMessage)] }]
}

export const ACTION_IDS = ACTIONS
export { src as embedSource }
