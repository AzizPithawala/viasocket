import { randomUUID } from 'node:crypto'
import { embedToken, listConnections, connectionsOf, connectionLabel, searchApps, getAppSchema } from '../viasocket.js'
import { KINDS, SPEC_SCHEMA, GALLERY, normalizeSpec, describePlan } from './spec.js'

const AI_PROMPT = `You turn a user's request into a spec for an add-on of a plug review agent.
The agent reviews viaSocket plugs and records every decision in a table with these fields: plug id, plug name, status (approved / rejected / improve), the agent's recommendation, the reason, the developer (assignee), who decided, when.
An add-on can only READ that table and send a result somewhere. These are the only kinds you may choose:
${Object.entries(KINDS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
- unsupported: anything else (list what is missing in "missing").
Rules: never invent data the table does not have. If the user wants records created or changed in another app, set writes_to_other_app true. Put anything you could not tell in "questions". Name the app the user wants the result in (default Slack). Return only JSON.`

/** Ask the AI for a spec. json_schema first, json_object as the fallback; the result is validated in code. */
async function askForSpec(text) {
  const body = (extra) => JSON.stringify({ message: text, thread_id: `addon-plan-${randomUUID()}`, prompt: AI_PROMPT, ...extra })
  const call = async (extra) => {
    const response = await fetch(`${process.env.VIASOCKET_API_URL}/embed/ai/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', authorization: embedToken(process.env.REVIEWER_ID || 'plug-reviewer') }, body: body(extra)
    })
    const payload = await response.json()
    if (!response.ok || payload.success === false) throw new Error(payload.message || 'AI request failed')
    const content = payload.data?.content
    return typeof content === 'string' ? JSON.parse(content) : content
  }
  try { return await call({ response_type: 'json_schema', json_schema: SPEC_SCHEMA }) } catch { return call({ response_type: 'json_object' }) }
}

/** Plain words in, a validated spec out. A request the model cannot map becomes kind "unsupported". */
export async function specFromWords(text) {
  let raw
  try { raw = await askForSpec(text) } catch (error) { return { spec: { kind: 'unsupported', summary: text.slice(0, 200), output_app: 'Slack', writes_to_other_app: false, missing: ['The request could not be analysed: ' + error.message], questions: [] }, problems: ['ai failed'] } }
  return normalizeSpec(raw)
}

export const gallerySpec = (id) => GALLERY.find((g) => g.id === id)?.spec

/** Check a spec against reality and say what can be built. Nothing is created here. */
export async function assess(spec, ctx) {
  const issues = [], notes = [], apps = [], needs = []
  const supported = Object.keys(KINDS).includes(spec.kind)

  if (!supported) issues.push(...(spec.missing.length ? spec.missing : ['This is not something the review data can answer or the agent can send yet.']))
  if (spec.writes_to_other_app) issues.push('Creating or changing records in another app is not supported yet; add-ons can read the decisions and send a message.')
  if (!ctx.settings.tableId) issues.push('The decisions table is not set up yet. Save the review settings first.')

  // The output app: Slack is built; any other app is resolved and reported honestly.
  const connections = await listConnections(ctx.reviewerId).catch(() => [])
  const wantsSlack = /slack/i.test(spec.output_app)
  let outputOk = false
  if (wantsSlack) {
    const active = connections.find((c) => c.id === ctx.state.rowbu58rc?.authId)
    const status = !active ? 'not connected' : active.isExpired ? 'expired' : 'connected'
    apps.push({ name: 'Slack', status, detail: active ? connectionLabel(active) : 'Connect Slack on the dashboard' })
    outputOk = status === 'connected'
    if (!outputOk) issues.push(`Slack is ${status}.`)
    else needs.push({ key: 'channelId', label: 'Slack channel for the message', type: 'channel' })
  } else {
    const found = (await searchApps(spec.output_app).catch(() => []))[0]
    if (!found) apps.push({ name: spec.output_app, status: 'not found', detail: 'No published app with that name' })
    else {
      const mine = connectionsOf(connections, found.service_id)
      const schema = await getAppSchema(found.service_id).catch(() => null)
      const sendLike = (schema?.actions || []).filter((a) => /send|post|create|add/i.test(a.name)).slice(0, 4).map((a) => a.name)
      apps.push({ name: found.name, status: mine.length ? 'connected' : 'not connected', detail: sendLike.length ? 'Actions it offers: ' + sendLike.join(', ') : 'No send-like action found' })
    }
    notes.push(`Add-ons can send to Slack today. ${spec.output_app} output is not built yet, so this would go to Slack instead.`)
    if (connections.find((c) => c.id === ctx.state.rowbu58rc?.authId && !c.isExpired)) needs.push({ key: 'channelId', label: 'Slack channel for the message', type: 'channel' })
  }

  const buildable = supported && !spec.writes_to_other_app && ctx.settings.tableId
  const slackReady = apps.some((a) => a.name === 'Slack' && a.status === 'connected') || (!wantsSlack && needs.length)
  let verdict = 'cannot'
  if (buildable && slackReady) verdict = wantsSlack ? 'can_build' : 'partial'
  else if (supported && !spec.writes_to_other_app) verdict = 'cannot'
  if (!supported) notes.push('Closest ready-made add-ons: ' + GALLERY.map((g) => g.title).join(', ') + '.')

  // A plan is shown only for what will really be built. For "cannot", the closest thing that works is a note.
  const plan = supported && verdict !== 'cannot' ? describePlan(spec) : null
  if (supported && verdict === 'cannot' && spec.writes_to_other_app) notes.push('What I can do instead: ' + describePlan({ ...spec, writes_to_other_app: false }))
  return { verdict, summary: spec.summary, plan, apps, needs, issues, notes, questions: spec.questions, spec }
}
