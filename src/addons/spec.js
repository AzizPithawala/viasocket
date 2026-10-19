// An add-on is described by a small spec. Only these kinds exist; the AI fills the spec in and the code
// builds from vetted templates, so no free-form code is ever generated.

export const KINDS = {
  digest: 'Counts of approved, rejected and improved decisions for a period, sent on a schedule',
  event_alert: 'A message each time a plug is rejected',
  developer_summary: 'A weekly summary of open improvements and rejections per developer'
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

// The shape the AI must return (validated again in code; the model is never trusted).
export const SPEC_SCHEMA = {
  name: 'addon_spec',
  strict: false,
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One sentence: what the user wants, in your own words' },
      kind: { type: 'string', enum: [...Object.keys(KINDS), 'unsupported'] },
      schedule: {
        type: 'object',
        properties: { frequency: { type: 'string', enum: ['daily', 'weekly'] }, weekday: { type: 'string', enum: WEEKDAYS }, hour: { type: 'integer', minimum: 0, maximum: 23 } }
      },
      period_days: { type: 'integer', minimum: 1, maximum: 90, description: 'Look-back window for digests; 7 for weekly, 1 for daily' },
      output_app: { type: 'string', description: 'Name of the app the user wants the result in, such as Slack or Gmail' },
      writes_to_other_app: { type: 'boolean', description: 'True if the user wants records created or changed in another app' },
      missing: { type: 'array', items: { type: 'string' }, description: 'What the request needs that the agent has no way to provide' },
      questions: { type: 'array', items: { type: 'string' }, description: 'Things you could not tell from the request' }
    },
    required: ['summary', 'kind', 'output_app', 'writes_to_other_app', 'missing', 'questions']
  }
}

export const GALLERY = [
  {
    id: 'digest', title: 'Decision digest', description: 'Weekly count of approved, rejected and improved plugs, posted to Slack.',
    spec: { summary: 'Post a weekly count of approved, rejected and improved plugs to Slack.', kind: 'digest', schedule: { frequency: 'weekly', weekday: 'Monday', hour: 9 }, period_days: 7, output_app: 'Slack', writes_to_other_app: false, missing: [], questions: [] }
  },
  {
    id: 'reject_alert', title: 'Reject alert', description: 'A Slack message every time a plug is rejected, with the reason.',
    spec: { summary: 'Post a Slack message whenever a plug is rejected.', kind: 'event_alert', output_app: 'Slack', writes_to_other_app: false, missing: [], questions: [] }
  },
  {
    id: 'developer_summary', title: 'Developer summary', description: 'Weekly: open improvements and rejections per developer.',
    spec: { summary: 'Post a weekly per-developer summary of open improvements and rejections to Slack.', kind: 'developer_summary', schedule: { frequency: 'weekly', weekday: 'Monday', hour: 9 }, output_app: 'Slack', writes_to_other_app: false, missing: [], questions: [] }
  }
]

/** Check a spec returned by the model and fill sensible defaults. Returns { spec, problems }. */
export function normalizeSpec(raw) {
  const problems = []
  const spec = { summary: String(raw?.summary || '').slice(0, 300), kind: raw?.kind, output_app: String(raw?.output_app || 'Slack').slice(0, 60), writes_to_other_app: Boolean(raw?.writes_to_other_app), missing: Array.isArray(raw?.missing) ? raw.missing.map(String).slice(0, 8) : [], questions: Array.isArray(raw?.questions) ? raw.questions.map(String).slice(0, 6) : [] }
  if (!Object.keys(KINDS).includes(spec.kind) && spec.kind !== 'unsupported') { problems.push('unknown kind'); spec.kind = 'unsupported' }
  if (spec.kind === 'digest' || spec.kind === 'developer_summary') {
    const s = raw?.schedule || {}
    spec.schedule = { frequency: s.frequency === 'daily' ? 'daily' : 'weekly', weekday: WEEKDAYS.includes(s.weekday) ? s.weekday : 'Monday', hour: Number.isInteger(s.hour) && s.hour >= 0 && s.hour <= 23 ? s.hour : 9 }
  }
  if (spec.kind === 'digest') {
    const d = Number(raw?.period_days)
    spec.period_days = Number.isInteger(d) && d >= 1 && d <= 90 ? d : (spec.schedule.frequency === 'daily' ? 1 : 7)
  }
  return { spec, problems }
}

const hour12 = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`

/** viaSocket's plain-words schedule, read back after saving to confirm it was understood. */
export const cronStatement = (schedule) => (schedule.frequency === 'daily' ? `Every day at ${hour12(schedule.hour)}` : `Every ${schedule.weekday} at ${hour12(schedule.hour)}`)

/** The plan in plain words, built from the spec by code so it cannot say more than will happen. */
export function describePlan(spec, params = {}) {
  const when = spec.schedule ? cronStatement(spec.schedule) : null
  const where = params.channelLabel ? `to #${params.channelLabel}` : 'to a Slack channel you choose'
  if (spec.kind === 'digest') return `${when}: count the plugs approved, rejected and improved in the last ${spec.period_days} day${spec.period_days === 1 ? '' : 's'} from the decisions table and post the totals ${where}.`
  if (spec.kind === 'event_alert') return `Each time the review agent records a rejected plug, post the plug name, who it was assigned to and the reason ${where}.`
  if (spec.kind === 'developer_summary') return `${when}: list for each developer how many plugs are still waiting on improvements and how many were rejected, and post it ${where}.`
  return 'Nothing to build.'
}
