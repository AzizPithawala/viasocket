import { runAction } from '../viasocket.js'

/** Read the decisions table (read only), up to 2,000 rows. Blank starter rows are dropped. */
export async function readDecisionRows({ state, settings }) {
  if (!settings.tableId || !state.rowe71n93?.scriptId) return []
  let rows = []
  for (let offset = 0, i = 0; i < 4; i++, offset += 500) {
    const page = await runAction(state.rowe71n93.scriptId, 'rowhk32rn3e0', { table: settings.tableId, filter_mode: 'list_all', queryopt: { limit: '500', offset: String(offset) } })
    const batch = Array.isArray(page) ? page : page?.data || page?.rows || []
    rows = rows.concat(batch)
    if (batch.length < 500) break
  }
  return rows.filter((r) => r.name)
}
