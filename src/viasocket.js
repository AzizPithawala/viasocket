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

export async function findEnabledApp(uniqueIdentifier, serviceId, authId) {
  const response = await fetch(
    `${API}/projects/${process.env.VIASOCKET_PROJECT_ID}/integrations`,
    { headers: { authorization: embedToken(uniqueIdentifier) } }
  )
  const payload = await response.json()
  const flows = payload.data?.flows || []
  // An enabled app belongs to one connection: with an authId, only that connection's app counts.
  return flows.find((flow) => flow.service_id === serviceId && flow.status === 'active' && (!authId || flow.auth_id === authId))?.id || null
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

// Catalog: one app's actions and triggers with ids, input schemas and sample outputs.
export async function getAppSchema(serviceId) {
  const response = await fetch(`${RUN}/func/scriK4LFg2kc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service_id: serviceId })
  })
  const payload = await response.json()
  const data = payload.data || payload
  return data?.service ? data : null
}

export async function searchApps(name) {
  const response = await fetch(`${RUN}/func/scri12BSufQM?key=${encodeURIComponent(name)}`)
  const payload = await response.json()
  return payload.data || []
}

// One real event of a trigger for a connection (the object a handler would read as context.req.body).
export async function fetchTriggerSample(triggerId, authId, authType, inputData) {
  const response = await fetch(
    `${RUN}/func/scrijZpnr8zJ?action_id=${triggerId}&auth_id=${authId}&authType=${encodeURIComponent(authType)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: { inputData } }) }
  )
  return response.json()
}

/** Readable account name from a connection's label, e.g. {"team":"Viasocket"} -> "Viasocket". */
export function connectionLabel(connection) {
  try {
    const parsed = JSON.parse(connection.connection_label)
    return Object.values(parsed)[0] ? String(Object.values(parsed)[0]) : connection.service_name
  } catch {
    return connection.connection_label || connection.service_name
  }
}

/** All connections of one app, newest first, usable ones before expired ones. */
export function connectionsOf(connections, serviceId) {
  return connections
    .filter((c) => String(c.id).endsWith(`_${serviceId}`))
    .sort((a, b) => Number(Boolean(a.isExpired)) - Number(Boolean(b.isExpired)) || String(b.updated_at).localeCompare(String(a.updated_at)))
}
