// The ONLY code in this agent that can change something in Developer Hub. Everything else reads (src/devhub.js).
//   - off unless DEVHUB_WRITES=1
//   - exactly ONE endpoint is reachable, checked by pattern: save a version's input definition (its fields).
//     No create, no delete, no publish, no status change, nothing on the plug or the action itself.
//   - the token only goes in the header and is stripped from any error text

import { isConfigured } from './devhub.js'

export const writesEnabled = () => process.env.DEVHUB_WRITES === '1' && isConfigured()

const ALLOWED = [/^update\/action_version\?identifier=row[0-9a-z]+&filter=updateActionVersionDetails$/]
const redact = (text) => String(text).split(process.env.DEVHUB_TOKEN || '\u0000').join('<token>')

async function put(path, body) {
  if (!writesEnabled()) throw new Error('Writing to Developer Hub is switched off (set DEVHUB_WRITES=1 to allow it)')
  if (!ALLOWED.some((pattern) => pattern.test(path))) throw new Error('That Developer Hub path is not one this agent may write to')
  let response
  try {
    response = await fetch(`${process.env.DEVHUB_API_BASE}/developers/${process.env.DEVHUB_ORG}/${path}`, {
      method: 'PUT', headers: { proxy_auth_token: process.env.DEVHUB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
  } catch (error) { throw new Error('Developer Hub unreachable: ' + redact(error.message)) }
  const payload = await response.json().catch(() => null)
  if (response.status === 401 || response.status === 403) throw new Error('Developer Hub rejected the token (it may have expired)')
  if (!response.ok || !payload || payload.success === false) throw new Error(redact(payload?.message || `Developer Hub answered ${response.status}`))
  return payload
}

/** Save a version's input definition (its fields). Only ever called on a drafted version. */
export const saveVersionInputjson = (versionRowId, inputjson) => put(`update/action_version?identifier=${versionRowId}&filter=updateActionVersionDetails`, { inputjson })
