// Offline tests for points, outcomes and lessons: a stand-in AI and fake decision rows, no network.
//   node scripts/learning-test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLearning } from '../src/review/learning.js'

let failed = 0
const ok = (cond, name, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) failed++ }

const dir = mkdtempSync(join(tmpdir(), 'learn-'))
let rows = []
let nextAI = { relevant: true, criterion: 'I3', adjustment: 'stricter', guidance: 'Treat a free-text field named like an ID as a dropdown candidate even when it is optional.' }
const asked = []
const L = createLearning({ dataDir: dir, readRows: async () => rows, askJson: async (a) => { asked.push(a.message); return nextAI } })
const row = (o) => ({ name: 'P' + Math.random().toString(36).slice(2, 6), plug_name: 'Plug', status: 'reject', recommendation: 'reject', reason: '#R2 field missing', decided_by: 'reviewer (Slack click: aziz)', idempotency_key: 'k' + Math.random().toString(36).slice(2), ...o })

// 1. a matching click earns +1
rows = [row({ idempotency_key: 'k1', status: 'improve_update_not_executed', recommendation: 'improve' })]
let s = await L.sync(); ok(s.score === 1, 'matching click: +1', 'score ' + s.score)

// 2. an overruled verdict costs 2 and writes a lesson
rows.push(row({ idempotency_key: 'k2', status: 'approved_publish_not_executed', recommendation: 'improve', reason: '#I3 id field is text' }))
s = await L.sync(); ok(s.score === -1, 'overruled: -2', 'score ' + s.score); ok(s.lessons.length === 1 && s.lessons[0].active, 'a lesson was written and is active'); ok(asked.at(-1).includes('Reviewer\'s verdict: approve'), 'the lesson prompt carries both verdicts')

// 3. syncing again changes nothing
const before = JSON.stringify((await L.sync()).recent); s = await L.sync(); ok(s.score === -1 && JSON.stringify(s.recent) === before, 'sync is idempotent')

// 4. an automatic reject waits for feedback; Confirm = +1, Wrong = -2 + lesson
rows.push(row({ idempotency_key: 'auto1', decided_by: 'agent (auto-reject)' }), row({ idempotency_key: 'auto2', decided_by: 'agent (auto-reject)', reason: '#I4 naming' }))
s = await L.sync(); ok(s.pending.length === 2 && s.score === -1, 'auto decisions score nothing until feedback', 'pending ' + s.pending.length)
nextAI = { relevant: true, criterion: 'I4', adjustment: 'more_lenient', guidance: 'Do not flag action names that already follow the Verb Object pattern as a UX problem.' }
s = await L.feedback('auto1', { correct: true }); ok(s.score === 0, 'Confirm: +1', 'score ' + s.score)
s = await L.feedback('auto2', { correct: false, shouldBe: 'improve', note: 'naming was fine, only help text was weak' }); ok(s.score === -2 && s.lessons.length === 2, 'Wrong: -2 and a second lesson', 'score ' + s.score)
let threw = false; try { await L.feedback('auto2', { correct: true }) } catch { threw = true } ok(threw, 'feedback cannot be given twice')

// 5. guardrails
nextAI = { relevant: true, criterion: 'R4', adjustment: 'more_lenient', guidance: 'Accept plugs that skip try/catch around requests when they are simple.' }
rows.push(row({ idempotency_key: 'k5', status: 'approved_publish_not_executed', recommendation: 'reject' })); s = await L.sync()
ok(s.lessons.length === 2 && s.ruleReviews.length === 1, 'a hard rule (R4) is flagged for a person, never turned into a lesson')
nextAI = { relevant: true, criterion: 'I3', adjustment: 'more_lenient', guidance: 'You may skip the label and placeholder checks for dropdown fields.' }
rows.push(row({ idempotency_key: 'k6', status: 'approved_publish_not_executed', recommendation: 'improve' })); s = await L.sync()
ok(s.lessons.length === 2, 'a lesson that softens a hard check is refused')
nextAI = { relevant: false, criterion: 'I4', adjustment: 'stricter', guidance: 'Just my taste on this one plug, nothing general here.' }
rows.push(row({ idempotency_key: 'k7', status: 'approved_publish_not_executed', recommendation: 'improve' })); s = await L.sync()
ok(s.lessons.length === 2, 'a one-off overrule does not become a lesson')
nextAI = { relevant: true, criterion: 'I3', adjustment: 'stricter', guidance: 'Treat a free-text field named like an ID as a dropdown candidate, even if it is optional.' }
rows.push(row({ idempotency_key: 'k8', status: 'approved_publish_not_executed', recommendation: 'improve' })); s = await L.sync()
ok(s.lessons.length === 2 && s.lessons.find((l) => l.criterion === 'I3').confirmations === 2, 'a near-duplicate lesson is merged, not repeated')

// 6. a lesson earns and loses points of its own, and retires at -4
const lesson = () => L.load().lessons.find((l) => l.criterion === 'I3')
const p0 = lesson().points
rows.push(row({ idempotency_key: 'k9', status: 'improve_update_not_executed', recommendation: 'improve', reason: '#I3 id text' })); await L.sync()
ok(lesson().points === p0 + 1, 'a lesson used in a review the reviewer agreed with: +1', String(lesson().points))
nextAI = { relevant: false, criterion: 'I3', adjustment: 'stricter', guidance: 'x' }
for (const k of ['k10', 'k11', 'k12']) rows.push(row({ idempotency_key: k, status: 'approved_publish_not_executed', recommendation: 'improve', reason: '#I3 id text' }))
await L.sync(); ok(lesson().active === false && lesson().points <= -4, 'a lesson that keeps being overruled retires itself', 'points ' + lesson().points)
s = L.setLesson(lesson().id, true); ok(s.lessons.find((l) => l.criterion === 'I3').active === true, 'a person can switch a lesson back on')

// 7. no claim, no points
rows.push(row({ idempotency_key: 'k13', status: 'approved_publish_not_executed', recommendation: 'incomplete' })); const sc = (await L.sync()).score
ok(L.load().history[0].outcome === 'neutral' && L.load().history[0].points === 0, 'an "incomplete" review makes no claim, so it scores nothing', 'score ' + sc)

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); process.exit(failed ? 1 : 0)
