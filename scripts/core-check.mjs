// Fingerprint of the core automations (intake, review, decision): trigger + steps as saved on viaSocket.
// Run before and after any change that must not touch the core: the hashes must be identical.
//   node --env-file=.env scripts/core-check.mjs            print hashes
//   node --env-file=.env scripts/core-check.mjs baseline    save them
//   node --env-file=.env scripts/core-check.mjs compare     compare with the saved baseline
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { embedToken } from '../src/viasocket.js'

const REVIEWER_ID = process.env.REVIEWER_ID || 'plug-reviewer'
const DATA_DIR = process.env.DATA_DIR || 'data'
const settings = JSON.parse(readFileSync(`${DATA_DIR}/settings.json`, 'utf8'))
const token = (await (await fetch(`${process.env.VIASOCKET_API_URL}/users/register`, { headers: { authorization: embedToken(REVIEWER_ID) } })).json()).data.token

const hashes = {}
for (const [name, id] of Object.entries({ intake: settings.intakeId, review: settings.reviewId, decide: settings.decideId })) {
  const res = await fetch(`${process.env.VIASOCKET_RUN_URL}/func/scriiZYPU6I3`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scriptId: id, env: 'prod', proxy_auth_token: token })
  })
  const parsed = await res.json()
  const body = parsed.data?.steps ? parsed.data : parsed
  const material = JSON.stringify({ trigger: { type: body.trigger?.triggerType, auth: body.trigger?.auth_id, table: body.trigger?.inputData?.table }, steps: (body.steps || []).map((s) => ({ n: s.stepname, c: s.code, a: s.service_action_functions })) })
  hashes[name] = createHash('sha256').update(material).digest('hex').slice(0, 16)
}
const file = `${DATA_DIR}/core-baseline.json`
const mode = process.argv[2]
if (mode === 'baseline') { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(file, JSON.stringify(hashes, null, 2)); console.log('baseline saved', hashes) }
else if (mode === 'compare') {
  const base = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  if (!base) { console.log('no baseline saved'); process.exit(2) }
  const same = Object.keys(hashes).every((k) => hashes[k] === base[k])
  console.log(same ? 'CORE UNCHANGED' : 'CORE CHANGED', { now: hashes, baseline: base }); process.exit(same ? 0 : 1)
} else console.log(hashes)
