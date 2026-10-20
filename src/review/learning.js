import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { JUDGEMENT_IDS, HARD_IDS, CRITERIA } from './criteria.js'

const AGREE = 1, OVERRULED = -2, RETIRE_AT = -4, MAX_LESSONS = 30, MAX_NEW_PER_SYNC = 3
const VERDICTS = ['approve', 'improve', 'reject']
const category = (status) => { const s = String(status || ''); return s.startsWith('approve') ? 'approve' : s.startsWith('improve') ? 'improve' : s === 'reject' ? 'reject' : null }
const words = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2))
const similar = (a, b) => { const A = words(a), B = words(b); const inter = [...A].filter((w) => B.has(w)).length; return inter / Math.max(1, Math.min(A.size, B.size)) }

// Lessons may only adjust judgement-based checks. A lesson that tries to soften a hard rule is refused.
const SOFTENS_HARD_RULE = /error ?component|try\/catch|live run|required[- ]field|label|placeholder|validation|help text/i

export const LESSON_SCHEMA = {
  name: 'review_lesson', strict: false,
  schema: {
    type: 'object',
    properties: {
      relevant: { type: 'boolean', description: 'False if the reviewer disagreed for a one-off or personal reason that is not a rule worth keeping' },
      criterion: { type: 'string', enum: [...CRITERIA.map((c) => c.id)] },
      adjustment: { type: 'string', enum: ['stricter', 'more_lenient', 'require_stronger_evidence', 'ignore_pattern'] },
      guidance: { type: 'string', description: 'One imperative sentence, at most 200 characters, telling a future review what to do differently' }
    },
    required: ['relevant', 'criterion', 'adjustment', 'guidance']
  }
}

const LESSON_PROMPT = `You improve a plug-review agent. The agent gave a verdict on a plug and the human reviewer overruled it.
Work out the one general mistake behind the difference and write ONE short rule so the agent does not repeat it.
Criteria ids: ${CRITERIA.map((c) => `${c.id} (${c.title})`).join('; ')}.
Say relevant=false if the overrule looks like a one-off or personal taste. Never write a rule that tells the agent to skip or soften label, placeholder, help, error component, validation or live-run checks.`

/** dataDir/learning<suffix>.json holds everything the agent has learned. */
export function createLearning({ dataDir, suffix = '', readRows, askJson, baselineOnFirstRun = false }) {
  mkdirSync(dataDir, { recursive: true })
  const file = `${dataDir}/learning${suffix}.json`
  const empty = () => ({ score: 0, history: [], pending: {}, processed: {}, lessons: [], ruleReviews: [] })
  const load = () => {
    if (!existsSync(file)) return empty()
    const state = { ...empty(), ...JSON.parse(readFileSync(file, 'utf8')) }
    // A damaged entry must never break a review: keep only well-formed lessons.
    state.lessons = (Array.isArray(state.lessons) ? state.lessons : []).filter((l) => l && typeof l === 'object' && l.criterion && l.guidance)
    return state
  }
  const save = (state) => { writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${file}.tmp`, file) }

  /** Turn an overrule into a lesson, with guardrails. Never throws: a missing lesson must not lose the points. */
  async function learnFrom(state, ctx) {
    try {
      const out = await askJson({
        threadPrefix: 'lesson', prompt: LESSON_PROMPT, schema: LESSON_SCHEMA,
        message: `Plug: ${ctx.plugName} (${ctx.plugId})\nAgent verdict: ${ctx.recommendation}\nReviewer's verdict: ${ctx.final}\nReviewer's note: ${ctx.note || '(none)'}\nAgent's findings: ${String(ctx.reason).slice(0, 1500)}`
      })
      const guidance = String(out?.guidance || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      if (!out?.relevant) return { skipped: 'not a general rule' }
      if (guidance.length < 15) return { skipped: 'guidance too short' }
      if (HARD_IDS.includes(out.criterion)) {
        // A hard rule was overruled: do not let the AI weaken it. Flag it for a person to review the rule.
        state.ruleReviews.push({ at: new Date().toISOString(), criterion: out.criterion, plugId: ctx.plugId, recommendation: ctx.recommendation, final: ctx.final, note: ctx.note || '' })
        return { skipped: `${out.criterion} is a hard rule: flagged for a person, not changed` }
      }
      if (!JUDGEMENT_IDS.includes(out.criterion)) return { skipped: 'unknown criterion' }
      if (SOFTENS_HARD_RULE.test(guidance)) return { skipped: 'would touch a hard rule' }
      const twin = state.lessons.find((l) => l.criterion === out.criterion && similar(l.guidance, guidance) > 0.7)
      if (twin) { twin.confirmations = (twin.confirmations || 1) + 1; return { merged: twin.id } }
      const lesson = { id: `ls_${Date.now().toString(36)}${state.lessons.length}`, criterion: out.criterion, adjustment: out.adjustment, guidance, createdAt: new Date().toISOString(), fromPlug: ctx.plugId, points: 0, uses: 0, active: true, confirmations: 1 }
      state.lessons.push(lesson)
      const active = state.lessons.filter((l) => l.active)
      if (active.length > MAX_LESSONS) { const worst = active.sort((a, b) => a.points - b.points || a.createdAt.localeCompare(b.createdAt))[0]; worst.active = false; worst.retiredReason = 'made room for newer lessons' }
      return { created: lesson.id }
    } catch (error) { return { skipped: 'lesson not written: ' + error.message } }
  }

  /** Lessons whose criterion shows up in a decided review earn or lose points with the outcome. */
  function scoreLessons(state, reason, agreed) {
    const hit = new Set((String(reason).match(/#([RI][1-4])\b/g) || []).map((m) => m.slice(1)))
    for (const l of state.lessons) {
      if (!l.active || !hit.has(l.criterion)) continue
      l.uses = (l.uses || 0) + 1
      l.points += agreed ? AGREE : OVERRULED
      if (l.points <= RETIRE_AT) { l.active = false; l.retiredAt = new Date().toISOString(); l.retiredReason = 'kept being overruled' }
    }
  }

  const record = (state, item) => { state.score += item.points; state.history.unshift(item); state.history = state.history.slice(0, 500) }

  /** Read new decisions and score them. Idempotent: each decision key is scored once. */
  async function sync() {
    const rows = await readRows()
    // First ever run: decisions that already exist (including test ones) are the starting point, not scored.
    if (baselineOnFirstRun && !existsSync(file)) {
      const first = empty(); const now = new Date().toISOString()
      for (const r of rows) if (r.idempotency_key) first.processed[r.idempotency_key] = 'baseline ' + now
      save(first); return summary(first)
    }
    const state = load()
    let newLessons = 0, changed = false
    for (const row of rows) {
      const key = row.idempotency_key
      if (!key || state.processed[key]) continue
      const rec = String(row.recommendation || '').toLowerCase(), final = category(row.status)
      const base = { at: new Date().toISOString(), key, plugId: row.name, plugName: row.plug_name || row.name, recommendation: rec, final, reason: String(row.reason || '').slice(0, 600) }
      state.processed[key] = base.at; changed = true
      if (String(row.decided_by || '').startsWith('agent')) { state.pending[key] = base; continue } // auto decision: waits for feedback
      if (!VERDICTS.includes(rec) || !final) { record(state, { ...base, points: 0, mode: 'click', outcome: 'neutral' }); continue }
      const agreed = rec === final
      scoreLessons(state, row.reason, agreed)
      const item = { ...base, points: agreed ? AGREE : OVERRULED, mode: 'click', outcome: agreed ? 'agreed' : 'overruled' }
      if (!agreed && newLessons < MAX_NEW_PER_SYNC) { item.lesson = await learnFrom(state, { ...base, reason: row.reason }); newLessons++ }
      record(state, item)
    }
    if (changed) save(state)
    return summary(state)
  }

  /** The reviewer's verdict on an automatic decision: Confirm (+1) or Wrong (-2 and a lesson). */
  async function feedback(key, { correct, shouldBe, note }) {
    const state = load()
    const p = state.pending[key]
    if (!p) throw new Error('nothing is waiting for feedback on that decision')
    if (!correct && !VERDICTS.includes(shouldBe)) throw new Error('say what the verdict should have been: approve, improve or reject')
    delete state.pending[key]
    if (correct) { scoreLessons(state, p.reason, true); record(state, { ...p, points: AGREE, mode: 'feedback', outcome: 'agreed' }) }
    else {
      scoreLessons(state, p.reason, false)
      const item = { ...p, final: shouldBe, points: OVERRULED, mode: 'feedback', outcome: 'overruled', note: String(note || '').slice(0, 300) }
      item.lesson = await learnFrom(state, { ...p, final: shouldBe, note: item.note })
      record(state, item)
    }
    save(state)
    return summary(state)
  }

  function setLesson(id, active) {
    const state = load(), l = state.lessons.find((x) => x.id === id)
    if (!l) throw new Error('lesson not found')
    l.active = Boolean(active); if (active) { delete l.retiredAt; delete l.retiredReason; if (l.points <= RETIRE_AT) l.points = 0 }
    save(state); return summary(state)
  }

  // Learning is an extra: if it cannot be read, a review simply runs without lessons.
  const activeLessons = () => { try { return load().lessons.filter((l) => l.active).sort((a, b) => b.points - a.points).slice(0, MAX_LESSONS) } catch { return [] } }

  function summary(state = load()) {
    const scored = state.history.filter((h) => h.outcome === 'agreed' || h.outcome === 'overruled').slice(0, 30)
    const agreed = scored.filter((h) => h.outcome === 'agreed').length
    return {
      score: state.score, agreementRate: scored.length ? Math.round((agreed / scored.length) * 100) : null, scored: scored.length,
      recent: state.history.slice(0, 10), pending: Object.values(state.pending), lessons: state.lessons, ruleReviews: state.ruleReviews.slice(-5)
    }
  }

  return { sync, feedback, setLesson, activeLessons, summary: () => summary(), load, file }
}
