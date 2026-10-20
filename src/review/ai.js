import { randomUUID } from 'node:crypto'
import { embedToken, getAppSchema, enableApp, findEnabledApp, runAction } from '../viasocket.js'

const UTILITIES = 'row29ruc9gs1' // viaSocket utilities: the built-in "Run AI Model" action, no connection needed
const RUN_AI_MODEL = 'rowskkqydb6f'
const REVIEWER = () => process.env.REVIEWER_ID || 'plug-reviewer'
const outOfCredits = (error) => /credits are exhausted|upgrade the plan|\b402\b/i.test(String(error?.message || error))

/** A small example JSON for a schema, which is how Run AI Model is told the shape of the answer. */
export function exampleFrom(schema) {
  const one = (p) => {
    if (!p) return 'string'
    if (p.enum) return p.enum.join('|')
    if (p.type === 'boolean') return true
    if (p.type === 'integer' || p.type === 'number') return 0
    if (p.type === 'array') return [one(p.items)]
    if (p.type === 'object') return Object.fromEntries(Object.entries(p.properties || {}).map(([k, v]) => [k, one(v)]))
    return 'string'
  }
  return JSON.stringify(one(schema?.schema || schema))
}

let utilitiesScript = null
async function viaRunAiModel({ message, prompt, schema, threadPrefix }) {
  if (!utilitiesScript) {
    utilitiesScript = (await findEnabledApp(REVIEWER(), UTILITIES, 'NoAuth')) || (await enableApp(REVIEWER(), 'NoAuth', UTILITIES))
  }
  const action = (await getAppSchema(UTILITIES))?.actions?.find((a) => a.action_id === RUN_AI_MODEL)
  if (!action) throw new Error('the built-in AI action is not available')
  const out = await runAction(utilitiesScript, action.action_version_id, {
    query: message, prompt, threadid: `${threadPrefix}-${randomUUID()}`, reasoning: 'low',
    response_type: 'json_object', response_json_structure: exampleFrom(schema)
  })
  return typeof out?.content === 'string' ? JSON.parse(out.content) : out?.content
}

/**
 * Ask the AI for JSON. The embed AI endpoint first (json_schema, then json_object); if its plan credits are used
 * up, the built-in Run AI Model action answers instead. The caller validates the result either way.
 */
export async function askJson({ message, prompt, schema, threadPrefix = 'review' }) {
  const call = async (extra) => {
    const response = await fetch(`${process.env.VIASOCKET_API_URL}/embed/ai/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: embedToken(REVIEWER()) },
      body: JSON.stringify({ message, prompt, thread_id: `${threadPrefix}-${randomUUID()}`, ...extra })
    })
    const payload = await response.json()
    if (!response.ok || payload.success === false) throw new Error(payload.message || 'AI request failed')
    const content = payload.data?.content
    return typeof content === 'string' ? JSON.parse(content) : content
  }
  try {
    try { return await call({ response_type: 'json_schema', json_schema: schema }) } catch (error) { if (outOfCredits(error)) throw error; return await call({ response_type: 'json_object' }) }
  } catch (error) {
    if (!outOfCredits(error)) throw error
    return viaRunAiModel({ message, prompt, schema, threadPrefix })
  }
}
