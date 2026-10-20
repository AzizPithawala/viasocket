// Sends one plug through a STAGING server's review path and prints what the staging review flow concluded.
//   node --env-file=.env scripts/staging-review.mjs <plugId> "<plug name>" [developerHubUrl] [port] [docsUrl]
import { readFileSync } from 'node:fs'
import { embedToken } from '../src/viasocket.js'

const [plugId, plugName, dhUrl = '', port = '3001', docsUrl = 'https://developers.notion.com/reference/intro'] = process.argv.slice(2)
const set = JSON.parse(readFileSync(`${process.env.DATA_DIR || 'data'}/settings.staging.json`, 'utf8'))
const res = await fetch(`http://localhost:${port}/api/live-test`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-intake-key': process.env.INTAKE_KEY },
  body: JSON.stringify({ plugId, plugName, docsUrl, assigneeName: 'Staging Test', plug: { developerHubUrl: dhUrl } })
})
console.log('accepted:', res.status)
const token = (await (await fetch(`${process.env.VIASOCKET_API_URL}/users/register`, { headers: { authorization: embedToken(process.env.REVIEWER_ID || 'plug-reviewer') } })).json()).data.token
for (let i = 0; i < 48; i++) {
  const runs = (await (await fetch(`${process.env.VIASOCKET_API_URL}/logs/orgId/${process.env.VIASOCKET_ORG_ID}?projectId=${process.env.VIASOCKET_PROJECT_ID}&scriptId=${set.reviewId}&page=1&limit=6`, { headers: { proxy_auth_token: token } })).json()).data?.finalResponse || []
  const run = runs.find((r) => String(r.requestSnapshot || '').includes(`"plugId":"${plugId}"`))
  if (run) {
    let snap = {}; try { snap = JSON.parse(run.responseSnapshot) } catch { /* empty */ }
    const a = snap.audit?.audit || snap.audit || {}
    const by = {}; for (const f of a.findings || []) by[f.criterion] = (by[f.criterion] || 0) + 1
    console.log(`REVIEW ${run.status} | verdict: ${a.recommendation} | findings: ${JSON.stringify(by)} | patch entries: ${(a.patch || []).length}`)
    console.log('not assessed:'); for (const u of a.unverified || []) console.log('  -', u)
    for (const f of (a.findings || []).filter((x) => x.severity === 'blocking').slice(0, 6)) console.log('  [' + f.criterion + '] ' + f.detail.slice(0, 110) + '\n        evidence: ' + String(f.evidence).slice(0, 150))
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, 10000))
}
console.log('no review run seen within 8 minutes')
