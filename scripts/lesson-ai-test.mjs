// Gives the REAL AI three overrule situations and shows what lesson (if any) comes out. Uses fake decision rows
// and a temporary learning file, so no flow, table or Slack message is involved.
//   node --env-file=.env scripts/lesson-ai-test.mjs [dataDir] [suffix]     (a dataDir keeps the lessons)
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLearning } from '../src/review/learning.js'
import { askJson } from '../src/review/ai.js'

const keep = process.argv[2]
const dir = keep || mkdtempSync(join(tmpdir(), 'lesson-ai-'))
let rows = []
const L = createLearning({ dataDir: dir, suffix: process.argv[3] || '', askJson, readRows: async () => rows })
const row = (o) => ({ plug_name: 'Test plug', decided_by: 'reviewer (Slack click: test)', idempotency_key: 'ai' + Math.random().toString(36).slice(2), ...o })
const cases = [
  ['I3 overruled (agent: improve, reviewer: approve)', row({ name: 'AI-1', status: 'approved_publish_not_executed', recommendation: 'improve', reason: 'Live: 3 passed, 0 failed, 0 not run | #I3 Free-text field that should be a dropdown in action "Get Order" (1 field): order_ref ("Order reference" is free text) | #I2 Help badly written (1 field)' })],
  ['R4 overruled (agent: reject, reviewer: approve)', row({ name: 'AI-2', status: 'approved_publish_not_executed', recommendation: 'reject', reason: '#R4 Code validation is not handled: no try/catch around the request in "Create Order"' })],
  ['taste-only overrule (agent: improve, reviewer: reject)', row({ name: 'AI-3', status: 'reject', recommendation: 'improve', reason: '#I4 Description of "Find Order" is 130 characters' })]
]
const L2 = createLearning({ dataDir: dir, suffix: process.argv[3] || '', askJson, readRows: async () => rows })
await L2.sync().catch(() => {}) // first call baselines nothing (not enabled here), so rows below are scored once
for (const [name, r] of cases) {
  rows = [r]; const before = L.load().lessons.length
  const s = await L.sync()
  const item = s.recent[0]
  console.log('\n' + name + '\n  points:', item.points, '| lesson result:', JSON.stringify(item.lesson))
  const created = L.load().lessons.slice(before)
  for (const l of created) console.log('  NEW LESSON [' + l.criterion + '/' + l.adjustment + ']:', l.guidance)
}
console.log('\nactive lessons:', L.load().lessons.filter((l) => l.active).length, '| rule reviews flagged:', L.load().ruleReviews.length)
if (!keep) rmSync(dir, { recursive: true, force: true })
