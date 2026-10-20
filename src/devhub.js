// Read-only client for viaSocket Developer Hub. It can only issue GET requests: there is no write function
// here by design, and request() takes no method or body. Nothing in this agent changes a plug through it.

const ROW_ID = /row[0-9a-z]{6,}/gi
const CODE_FIELDS = 'rowid,actionid,type,triggertype,versionid,perform,performlist,performsubscribe,performunsubscribe,modifytriggerdata,transferoption,inputjson,sampledata,status,isdeleted,authid'
const TTL_MS = 5 * 60 * 1000
const cache = new Map()

export const isConfigured = () => Boolean(process.env.DEVHUB_TOKEN && process.env.DEVHUB_ORG && process.env.DEVHUB_API_BASE)

const base = () => `${process.env.DEVHUB_API_BASE}/developers/${process.env.DEVHUB_ORG}`
const redact = (text) => String(text).split(process.env.DEVHUB_TOKEN || '\u0000').join('<token>')

/** One GET. The token only ever goes in the header and is stripped from any error text. */
async function request(path) {
  const hit = cache.get(path)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data
  let response
  try { response = await fetch(`${base()}/${path}`, { method: 'GET', headers: { proxy_auth_token: process.env.DEVHUB_TOKEN } }) }
  catch (error) { throw new Error('Developer Hub unreachable: ' + redact(error.message)) }
  const body = await response.json().catch(() => null)
  if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Developer Hub rejected the token (it may have expired)'), { code: 'auth' })
  if (!response.ok || !body) throw new Error(`Developer Hub answered ${response.status}`)
  const data = body.data ?? []
  cache.set(path, { at: Date.now(), data })
  return data
}

const live = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && r.status !== 'deleted' && !r.isdeleted)
const parseJson = (v) => { if (typeof v !== 'string') return v || {}; try { return JSON.parse(v) } catch { return {} } }
const newest = (versions) => [...versions].sort((a, b) => String(b.versionid).localeCompare(String(a.versionid), undefined, { numeric: true }))[0]

export const getPlugs = async () => live(await request(`get/plugins?identifier=${process.env.DEVHUB_ORG}&filter=getAllPlugins`))

/** Which plug in the org does a queue row mean? Ids in its URL first, then the catalog service id, then the exact name. */
export async function findPlug({ dhUrl, serviceId, name }) {
  const plugs = await getPlugs()
  const byId = new Map(plugs.map((p) => [p.rowid, p]))
  for (const id of [...new Set(String(dhUrl || '').match(ROW_ID) || []), serviceId].filter(Boolean)) if (byId.has(id)) return { plug: byId.get(id), via: id === serviceId ? 'catalog id' : 'Developer Hub URL' }
  const same = plugs.filter((p) => String(p.name).toLowerCase() === String(name || '').toLowerCase())
  if (same.length === 1) return { plug: same[0], via: 'name' }
  return same.length > 1
    ? { ambiguous: true, reason: `${same.length} plugs in Developer Hub share the name "${name}", so it is not clear which one to review` }
    : { reason: `no plug named "${name}" in this Developer Hub org` }
}

/** Run a list of async jobs, a few at a time, so a big plug does not flood the API. */
async function pool(items, size, job) {
  const out = new Array(items.length); let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await job(items[i], i) } }))
  return out
}

/**
 * Everything the code checks need for one plug: its actions and triggers, the newest version of each with its
 * code and input definition, the plug's reusable components and which of them are mapped to each version.
 */
export async function getPlugBundle(plug) {
  const [actions, components, connections] = await Promise.all([
    request(`get/actions?identifier=${plug.rowid}&filter=getAllActions`).then(live),
    request(`get/reusable_components?identifier=${plug.rowid}&filter=dhGetReusableComponentDetails`).then(live),
    request(`get/oauth_details?identifier=${plug.rowid}&filter=getAuthDetails`).then(live).catch(() => [])
  ])
  const operations = await pool(actions, 4, async (action) => {
    const versions = live(await request(`get/action_version?identifier=${action.rowid}&filter=getActionVersions&fields=${CODE_FIELDS}`))
    const version = newest(versions)
    if (!version) return { action, version: null, inputjson: {}, mappings: [] }
    const mappings = live(await request(`get/action_version_component_table?identifier=${version.rowid}&filter=dhGetUsedComponentInActionVersionDetails`))
    return { action, version, inputjson: parseJson(version.inputjson), mappings }
  })
  return { plug, components, authType: connections[0]?.type || null, operations: operations.filter((o) => o.version) }
}
