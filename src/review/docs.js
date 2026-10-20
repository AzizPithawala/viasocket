// Finds the API documentation for one operation when the person did not paste a link.
//   1. a doc link already stored with the plug in Developer Hub (plug metadata, written by AI-created plugs)
//   2. otherwise a web search, accepted only if the page is on the provider's own domain and answers
// Every answer says where it came from and how sure it is. A low-confidence page is never used to reject a plug.

const TWO_LEVEL = new Set(['co.uk', 'org.uk', 'com.au', 'co.in', 'co.jp', 'com.br', 'co.nz', 'com.sg', 'co.za'])
const SKIP_HOSTS = /viasocket\.com|socket\.io|sokt\.io|docstar|thingsofbrand|cloudfront|amazonaws|googleusercontent|githubusercontent|gstatic/i
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'new', 'all', 'get', 'list', 'create', 'update', 'delete', 'find', 'add', 'send', 'make', 'retrieve', 'fetch', 'action', 'trigger', 'when', 'user', 'account', 'record', 'item', 'data'])

export function registrableDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  return TWO_LEVEL.has(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.')
}

/** Is this URL a believable official page for a plug on `domain`? Pure check, no network. */
export function checkDocUrl(url, domain) {
  let u
  try { u = new URL(url) } catch { return { ok: false, reason: 'not a valid URL' } }
  if (u.protocol !== 'https:') return { ok: false, reason: 'not https' }
  if (!domain) return { ok: false, reason: "the plug has no domain to compare against" }
  const want = registrableDomain(String(domain).replace(/^https?:\/\//, '').split('/')[0])
  if (registrableDomain(u.hostname) !== want) return { ok: false, reason: `the page is on ${registrableDomain(u.hostname)}, not the provider's ${want}` }
  return { ok: true }
}

const words = (text) => String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w))

/** Doc links stored on the plug (metadata.aiContext and friends), without viaSocket's own links. */
export function storedDocLinks(plug) {
  let meta = plug?.metadata
  if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch { meta = {} } }
  const found = new Set()
  const walk = (v) => { if (typeof v === 'string') for (const m of v.match(/https?:\/\/[^\s"'\\)>,\]]+/g) || []) { if (!SKIP_HOSTS.test(m)) found.add(m.replace(/[.;]+$/, '')) } else if (v && typeof v === 'object') Object.values(v).forEach(walk) }
  walk(meta?.aiContext)
  return [...found]
}

/** The stored link whose path best matches the operation's name. */
export function pickStored(links, operation) {
  if (!links.length) return null
  const want = new Set([...words(operation?.name), ...words(operation?.description)])
  const scored = links.map((url) => ({ url, hits: words(new URL(url).pathname).filter((w) => want.has(w)).length })).sort((a, b) => b.hits - a.hits)
  if (scored[0].hits > 0) return { url: scored[0].url, confidence: 'high', note: 'a doc link stored with the plug that matches this operation' }
  if (links.length === 1) return { url: links[0], confidence: 'medium', note: 'the only doc link stored with the plug' }
  return null
}

export const DOCS_SCHEMA = {
  name: 'docs_lookup', strict: false,
  schema: { type: 'object', properties: { url: { type: 'string', description: "The single most specific official API reference page for this operation, or an empty string if not found" }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reason: { type: 'string' } }, required: ['url', 'confidence'] }
}

const defaultReachable = async (url) => {
  try { const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0 plug-review-agent' } }); return r.status < 400 } catch { return false }
}

/** { url, source: 'developer hub' | 'web search' | null, confidence, note } */
export async function findDocs({ plug, operation, askJson, reachable = defaultReachable }) {
  const stored = pickStored(storedDocLinks(plug), operation)
  if (stored) return { ...stored, source: 'developer hub' } // stored by the plug's author: trusted even on another domain
  if (!plug?.domain) return { url: null, source: null, confidence: 'low', note: 'the plug has no website to look up documentation on' }

  let guess
  try {
    guess = await askJson({
      threadPrefix: 'docs', schema: DOCS_SCHEMA,
      prompt: "You find official API documentation. Use web search. Return the single most specific page of the provider's own API reference that documents this operation (the endpoint's own page when one exists). Only the provider's own site. If you cannot find it with confidence, return an empty url and confidence low.",
      message: `App: ${plug?.name} (website domain: ${plug?.domain || 'unknown'})\nOperation: ${operation?.name}\nWhat it does: ${operation?.description || '(no description)'}\nType: ${operation?.type || 'action'}`
    })
  } catch (error) { return { url: null, source: null, confidence: 'low', note: 'the web search failed: ' + error.message } }

  const url = String(guess?.url || '').trim()
  if (!url) return { url: null, source: null, confidence: 'low', note: 'no official documentation page was found' }
  const verdict = checkDocUrl(url, plug?.domain)
  if (!verdict.ok) return { url, source: 'web search', confidence: 'low', note: 'found by web search but not trusted: ' + verdict.reason }
  if (!(await reachable(url))) return { url, source: 'web search', confidence: 'low', note: 'found by web search but the page did not answer' }
  const sure = guess.confidence === 'high' ? 'high' : guess.confidence === 'medium' ? 'medium' : 'low'
  return { url, source: 'web search', confidence: sure, note: `found by web search on the provider's own site${guess.reason ? ': ' + String(guess.reason).slice(0, 120) : ''}` }
}
