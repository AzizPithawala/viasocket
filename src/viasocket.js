import jwt from 'jsonwebtoken'

const API = process.env.VIASOCKET_API_URL
const RUN = process.env.VIASOCKET_RUN_URL

export function embedToken(uniqueIdentifier) {
  return jwt.sign(
    {
      org_id: process.env.VIASOCKET_ORG_ID,
      project_id: process.env.VIASOCKET_PROJECT_ID,
      unique_identifier: uniqueIdentifier
    },
    process.env.VIASOCKET_EMBED_SECRET,
    { algorithm: 'HS256' }
  )
}

async function call(path, uniqueIdentifier, body, method = 'POST') {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', authorization: embedToken(uniqueIdentifier) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const payload = await response.json()
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || `viaSocket ${path} failed with ${response.status}`)
  }
  return payload.data
}

export async function listConnections(uniqueIdentifier) {
  return call('/embed/authentications', uniqueIdentifier, undefined, 'GET')
}

export async function enableApp(uniqueIdentifier, authId, serviceId) {
  const data = await call(`/embed/enable/${serviceId}/${authId}`, uniqueIdentifier)
  return data.script_id
}

export async function findEnabledApp(uniqueIdentifier, serviceId) {
  const response = await fetch(
    `${API}/projects/${process.env.VIASOCKET_PROJECT_ID}/integrations`,
    { headers: { authorization: embedToken(uniqueIdentifier) } }
  )
  const payload = await response.json()
  const flows = payload.data?.flows || []
  return flows.find((flow) => flow.service_id === serviceId && flow.status === 'active')?.id || null
}

export async function listOptions(uniqueIdentifier, actionVersionId, fieldKey, existingFields, authId) {
  const data = await call(`/embed/list-options/${actionVersionId}`, uniqueIdentifier, {
    fieldKey,
    auth_id: authId,
    existingFields
  })
  if (data && !Array.isArray(data) && data.response && Number(data.response.status) >= 400) {
    throw new Error(data.response.data?.message || 'list-options failed')
  }
  return Array.isArray(data) ? data : data.data
}

export async function runAction(scriptId, actionVersionId, inputData) {
  const response = await fetch(`${RUN}/func/${scriptId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_version_id: actionVersionId, inputData })
  })
  const payload = await response.json()
  const isEnvelope =
    payload && typeof payload === 'object' && typeof payload.success === 'boolean' && 'data' in payload
  if (isEnvelope ? !payload.success : payload?.success === false) {
    throw new Error(payload.message || payload.error?.message || 'Action failed')
  }
  return isEnvelope ? payload.data : payload
}
