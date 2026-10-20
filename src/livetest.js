import { classifyFailure } from './review/checks.js'
import { listConnections, connectionsOf, findEnabledApp, enableApp, listOptions, runAction, getAppSchema, searchApps, fetchTriggerSample } from './viasocket.js'

const REVIEWER_ID = process.env.REVIEWER_ID || 'plug-reviewer'
const READ_NAME = /^(get|list|find|search|lookup|fetch|retrieve|read|view|check)\b/i
const ROW_ID = /row[0-9a-z]{6,}/gi

const excerpt = (value, max = 300) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text || '').slice(0, max)
}

// A run answers HTTP 200 even when the app failed, so the body has to be read.
function errorIn(body) {
  if (!body || typeof body !== 'object') return null
  if (body.error) return excerpt(body.error?.message || body.error)
  const status = Number(body.response?.status ?? body.status)
  if (status >= 400) return excerpt(body.response?.data?.message || body.message || body.response?.data || body)
  if (body.success === false) return excerpt(body.message || body)
  return null
}

// The HTTP status behind a failed run, when the body carries one.
const statusIn = (body) => { const n = Number(body?.response?.status ?? body?.status ?? body?.error?.status); return Number.isFinite(n) && n >= 100 ? n : null }

/** Add whose-fault information to a failed entry, so only the plug's own failures can reject it. */
function withOrigin(entry, status) {
  const verdict = classifyFailure({ status, message: entry.detail })
  return Object.assign(entry, { httpStatus: status, origin: verdict.origin, originReason: verdict.reason })
}

const hasOperations = (schema) => Boolean(schema && ((schema.actions || []).length || (schema.triggers || []).length))

/** Find the published app a queue row points at: ids in the Developer Hub URL first, then the name. */
export async function resolvePlug({ plugName, dhUrl }) {
  for (const id of new Set(String(dhUrl || '').match(ROW_ID) || [])) {
    const schema = await getAppSchema(id).catch(() => null)
    // An unpublished plug has a catalog entry with no operations: that is not a plug to test, so keep looking.
    if (hasOperations(schema)) return { serviceId: id, name: schema.service.name, via: 'developer hub url', schema }
  }
  const found = await searchApps(plugName || '').catch(() => [])
  const exact = found.filter((app) => String(app.name).toLowerCase() === String(plugName || '').toLowerCase())
  if (exact.length === 1) {
    const schema = await getAppSchema(exact[0].service_id)
    if (hasOperations(schema)) return { serviceId: exact[0].service_id, name: exact[0].name, via: 'name search', schema }
  }
  return { unresolved: true, candidates: found.slice(0, 5).map((a) => ({ id: a.service_id, name: a.name })) }
}

const visible = (field, inputData) => {
  if (!field.visibilityCondition) return true
  try { return Boolean(new Function('context', `return ${field.visibilityCondition}`)({ inputData })) } catch { return true }
}

/**
 * Build inputData for a read action or trigger from its schema. Required pickers take the first value the
 * test account offers; anything that needs free text a person would type is reported, never invented.
 */
async function fillInputs(schema, versionId, authId) {
  const inputData = {}
  const blocks = schema.blocks || {}
  for (const key of schema.steps?.root || []) {
    const field = blocks[key]
    if (!field || field.type === 'help' || !visible(field, inputData)) continue
    const preset = field.defaultValue ?? field.default
    if (!field.required && preset === undefined) continue
    if (preset !== undefined && preset !== null && preset !== '') {
      inputData[key] = typeof preset === 'object' && 'value' in preset ? preset.value : preset
      continue
    }
    if (field.type === 'dropdown' || field.type === 'multiselect') {
      const options = field.options?.length ? field.options : await listOptions(REVIEWER_ID, versionId, key, inputData, authId).catch(() => [])
      if (!options?.length) return { skip: `no choices available for "${field.label || key}" on the test account` }
      inputData[key] = field.type === 'multiselect' ? [options[0].value] : options[0].value
    } else if (field.type === 'boolean') {
      inputData[key] = false
    } else {
      return { skip: `needs a value typed by a person: "${field.label || key}"` }
    }
  }
  return { inputData }
}

/** The catalog schema narrowed to one action or trigger (by id, else by name). */
export function scopeSchema(schema, only) {
  if (!only) return schema
  const same = (x) => (only.actionId && (x.action_id === only.actionId || x.trigger_id === only.actionId)) || String(x.name).toLowerCase() === String(only.name).toLowerCase()
  return { ...schema, actions: (schema.actions || []).filter(same), triggers: (schema.triggers || []).filter(same) }
}

/** Run every read action and fetch one event per trigger on the reviewer's test connection. */
export async function runLiveTests({ serviceId, schema }) {
  const result = { serviceId, name: schema.service.name, status: 'tested', actions: [], triggers: [], summary: { passed: 0, failed: 0, notRun: 0 } }
  const connections = await listConnections(REVIEWER_ID)
  const connection = connectionsOf(connections, serviceId)[0] // newest usable test connection
  const noAuth = String(schema.service.auth_type || '').toLowerCase().includes('no')
  if (!connection && !noAuth) {
    return { ...result, status: 'not_tested', reason: 'No test connection for this app. Connect a test account on the dashboard.' }
  }
  if (connection?.isExpired) return { ...result, status: 'not_tested', reason: 'The test connection has expired. Reconnect it on the dashboard.' }
  const authId = connection?.id || 'NoAuth'
  const scriptId = (await findEnabledApp(REVIEWER_ID, serviceId, authId)) || (await enableApp(REVIEWER_ID, authId, serviceId))
  const tally = (status) => { result.summary[status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'notRun']++ }

  for (const action of schema.actions || []) {
    const entry = { name: action.name, kind: READ_NAME.test(action.name) ? 'read' : 'write' }
    if (entry.kind === 'write') {
      Object.assign(entry, { status: 'not_run', detail: 'Write action: not run so nothing changes in the test account.' })
    } else {
      const filled = await fillInputs(action.input_schema, action.action_version_id, authId).catch((e) => ({ skip: `could not prepare inputs: ${e.message}` }))
      if (filled.skip) Object.assign(entry, { status: 'not_run', detail: filled.skip })
      else {
        const started = Date.now()
        try {
          const body = await runAction(scriptId, action.action_version_id, filled.inputData)
          const error = errorIn(body)
          Object.assign(entry, { status: error ? 'failed' : 'passed', durationMs: Date.now() - started, detail: error || `Returned ${excerpt(body, 160)}`, input: filled.inputData })
          if (error) withOrigin(entry, statusIn(body))
        } catch (error) {
          Object.assign(entry, { status: 'failed', durationMs: Date.now() - started, detail: excerpt(error.message), input: filled.inputData })
          withOrigin(entry, null)
        }
      }
    }
    tally(entry.status); result.actions.push(entry)
  }

  for (const trigger of schema.triggers || []) {
    const entry = { name: trigger.name }
    const filled = await fillInputs(trigger.input_schema, trigger.trigger_version_id, authId).catch((e) => ({ skip: `could not prepare inputs: ${e.message}` }))
    if (filled.skip) Object.assign(entry, { status: 'not_run', detail: filled.skip })
    else {
      try {
        const event = await fetchTriggerSample(trigger.trigger_id, authId, schema.service.auth_type || 'Auth2.0', filled.inputData)
        const error = errorIn(event)
        if (error) withOrigin(Object.assign(entry, { status: 'failed', detail: error }), statusIn(event))
        else if (/only a sample|stand-in|no data/i.test(String(event.viasockethelp || event.viasocket_help || ''))) {
          Object.assign(entry, { status: 'passed', detail: 'No real event yet on this account: a stand-in sample was returned.', emptyAccount: true })
        } else {
          const declared = Object.keys(trigger.sample_output || {})
          const got = new Set(Object.keys(event))
          const missing = declared.filter((k) => !got.has(k))
          Object.assign(entry, { status: 'passed', detail: missing.length ? `Event received. Keys in the declared sample but absent from the real event: ${missing.join(', ')}` : 'Event received and its keys match the declared sample.', missingKeys: missing })
        }
      } catch (error) {
        withOrigin(Object.assign(entry, { status: 'failed', detail: excerpt(error.message) }), null)
      }
    }
    tally(entry.status); result.triggers.push(entry)
  }
  return result
}
