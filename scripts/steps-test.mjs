// The automation steps are code stored as strings and run inside viaSocket. This parses every generated step as
// the async function body it will become, so a syntax slip is caught here and not in production.
//   node --env-file=.env scripts/steps-test.mjs
import { auditStep, decideSteps, intakeSteps } from '../src/flows.js'

let failed = 0
const ok = (cond, name, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) failed++ }
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const parses = (code) => { try { new AsyncFunction('context', 'axios', 'fetch', 'runAiModel', 'askReviewer', 'dm', 'getRows', 'addRow', 'console', code); return null } catch (e) { return e.message } }

const settings = { channelId: 'C1', tlUserId: 'U1', tableId: 'tbl1', queueTableId: 'tbl2' }
const steps = [
  { name: 'review/audit', code: auditStep('https://flow.sokt.io/func/x') },
  ...decideSteps(settings, 'auth_slack', 'auth_table').map((s) => ({ name: 'decision/' + s.stepname, code: s.code })),
  ...intakeSteps('https://flow.sokt.io/func/y').map((s) => ({ name: 'intake/' + s.stepname, code: s.code }))
]
for (const s of steps) { const err = parses(s.code); ok(!err, `${s.name} parses as an async function body`, err || '') }

const audit = steps[0].code, ask = steps.find((s) => s.name === 'decision/ask').code, act = steps.find((s) => s.name === 'decision/act').code, intake = steps.find((s) => s.name === 'intake/forward').code
ok(/body\.scope/.test(audit) && /scope,/.test(audit), 'the review step reads and passes on the scope')
ok(/lowDocs/.test(audit) && /confidence === 'low'/.test(audit), 'low-confidence docs make R2 "not assessed"')
ok(/!\(lowDocs && f\.criterion === 'R2'\)/.test(audit), 'R2 findings from low-confidence docs are dropped')
ok(/docsLine/.test(ask) && /scopeLine/.test(ask), 'the Slack message names the scope and where the docs came from')
ok(/b\.scope \? '#' \+ b\.scope\.id/.test(act), 'the decision key includes the operation, so two actions of one plug do not collide')
ok(/!row\.docs_url && !row\.dh_pllug_url/.test(intake), 'intake accepts a row with a Developer Hub link instead of docs')

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); process.exit(failed ? 1 : 0)
