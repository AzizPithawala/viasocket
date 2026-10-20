import { randomUUID } from 'node:crypto'
import { embedToken } from '../viasocket.js'

/** Ask the AI for JSON. json_schema first, json_object as the fallback. The caller validates the result. */
export async function askJson({ message, prompt, schema, threadPrefix = 'review' }) {
  const call = async (extra) => {
    const response = await fetch(`${process.env.VIASOCKET_API_URL}/embed/ai/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: embedToken(process.env.REVIEWER_ID || 'plug-reviewer') },
      body: JSON.stringify({ message, prompt, thread_id: `${threadPrefix}-${randomUUID()}`, ...extra })
    })
    const payload = await response.json()
    if (!response.ok || payload.success === false) throw new Error(payload.message || 'AI request failed')
    const content = payload.data?.content
    return typeof content === 'string' ? JSON.parse(content) : content
  }
  try { return await call({ response_type: 'json_schema', json_schema: schema }) } catch { return call({ response_type: 'json_object' }) }
}
