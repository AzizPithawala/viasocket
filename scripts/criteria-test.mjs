// Offline tests: the verdict rule, the schema checks (I1-I3), the failure classifier (R1) and coverage.
//   node scripts/criteria-test.mjs
import { decideVerdict } from '../src/review/verdict.js'
import { schemaChecks, classifyFailure, liveFindings, buildCoverage } from '../src/review/checks.js'

let failed = 0
const ok = (cond, name, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) failed++ }
const f = (criterion, evidence = 'quoted evidence') => ({ criterion, evidence, detail: 'd' })
const full = { complete: true }, partial = { complete: false, notAssessed: ['R3', 'R4'] }

// ---- verdict rule
ok(decideVerdict([f('R1')], full).verdict === 'reject', 'any reject finding -> reject')
ok(decideVerdict([f('I1'), f('R2')], full).verdict === 'reject', 'reject wins over improve')
ok(decideVerdict([f('I2')], full).verdict === 'improve', 'only improve findings -> improve')
ok(decideVerdict([], full).verdict === 'approve', 'nothing found and everything assessed -> approve')
const inc = decideVerdict([], partial); ok(inc.verdict === 'incomplete' && /R3, R4/.test(inc.reason), 'nothing found but R3/R4 not assessed -> incomplete, never approve', inc.reason)
ok(decideVerdict([{ criterion: 'R2', evidence: '' }], full).verdict === 'approve', 'a finding without evidence is ignored')
ok(decideVerdict([f('R9')], full).verdict === 'approve', 'a finding with an unknown criterion is ignored')
ok(decideVerdict([f('I1')], partial).verdict === 'improve', 'improve is allowed even when coverage is partial')
ok(decideVerdict([f('R1')], partial).verdict === 'reject', 'reject is allowed even when coverage is partial')

// ---- schema checks on synthetic catalog-shaped plugs
const plug = (blocks, actionName = 'Create Contact') => ({ actions: [{ name: actionName, input_schema: { blocks } }], triggers: [] })
const field = (o) => ({ type: 'string', label: 'Name', placeholder: 'Enter name', help: 'Enter the name.', required: true, ...o })
const ids = (r) => [...new Set(r.findings.map((x) => x.criterion))].sort().join(',')

let r = schemaChecks(plug({ name: field({ key: 'name' }), email: field({ key: 'email', label: 'Email', placeholder: 'Enter email', help: 'Enter the email.' }) }))
ok(r.findings.length === 0, 'a clean plug has no findings')
r = schemaChecks(plug({ name: field({ key: 'name', label: '' }) })); ok(ids(r) === 'I1' && r.patch[0].set.label === 'Name', 'missing label -> I1, patch proposes "Name"')
r = schemaChecks(plug({ name: field({ key: 'name', placeholder: '' }) })); ok(ids(r) === 'I1' && /^Enter /.test(r.patch[0].set.placeholder), 'missing placeholder on a text field -> I1', r.patch[0].set.placeholder)
r = schemaChecks(plug({ grp: { key: 'grp', type: 'input groups', label: 'Options', help: 'Extra options for the request.' } })); ok(r.findings.length === 0, 'an input group needs no placeholder and no Enter/Select wording')
r = schemaChecks(plug({ name: field({ key: 'name', help: '' }) })); ok(ids(r) === 'I2' && r.patch[0].set.help === 'Enter the name.', 'missing help -> I2 with proposed help')
r = schemaChecks(plug({ name: field({ key: 'name', help: 'Provide the contact name' }) })); ok(ids(r) === 'I2' && /^Enter /.test(r.patch[0].set.help), 'help that starts wrongly -> I2, wording fixed', r.patch[0].set.help)
r = schemaChecks(plug({ pick: field({ key: 'pick', type: 'dropdown', label: 'List', placeholder: 'Select List', help: 'Choose a list' }) })); ok(ids(r) === 'I2' && /^Select /.test(r.patch[0].set.help), 'a dropdown help must start with Select')
r = schemaChecks(plug({ contact_id: field({ key: 'contact_id', label: 'Contact ID', placeholder: 'Enter contact id', help: 'Enter the contact id.' }) })); ok(ids(r) === 'I3', 'a free-text "...ID" field -> I3')
r = schemaChecks(plug({ status: field({ key: 'status', label: 'Status', placeholder: 'Enter status', help: 'Enter the status.' }) })); ok(ids(r) === 'I3', 'a free-text "Status" field -> I3 (fixed choices)')
r = schemaChecks(plug({ contact_id: field({ key: 'contact_id', label: 'Contact ID', placeholder: 'Enter contact id', help: 'Enter the contact id.' }) }, 'Delete Contact')); ok(r.findings.length === 0, 'Delete actions take a plain ID: not flagged')
r = schemaChecks(plug({ a: field({ key: 'a', label: '' }), b: field({ key: 'b', label: '' }) })); ok(r.findings.length === 1 && /2 fields/.test(r.findings[0].detail), 'findings are grouped per operation, not one per field')
r = schemaChecks(plug({ a: field({ key: 'a', label: '' }) })); ok(r.findings[0].severity === 'minor' && r.findings[0].criterion === 'I1', 'improve findings are minor')

// ---- whose fault is a live failure (R1)
const origin = (status, message) => classifyFailure({ status, message }).origin
ok(origin(500, 'Internal Server Error') === 'saas', '5xx -> SaaS side, not counted')
ok(origin(503, 'Service Unavailable') === 'saas', '503 -> SaaS side')
ok(origin(429, 'Too many requests') === 'saas', '429 rate limit -> SaaS side')
ok(origin(null, 'ETIMEDOUT while calling the API') === 'saas', 'timeout -> SaaS side')
ok(origin(403, 'Your plan does not include this feature. Upgrade your plan.') === 'saas', 'plan limit -> SaaS side')
ok(origin(400, 'Missing required parameter: email') === 'plug', '400 bad request -> the plug built it wrong')
ok(origin(404, 'Not found') === 'plug', '404 -> wrong endpoint, the plug')
ok(origin(null, 'ReferenceError: errorComponent is not defined') === 'plug', 'a code error in the plug -> the plug')
ok(origin(401, 'Unauthorized') === 'unknown', '401 on a valid connection -> a person decides')
ok(origin(null, 'something odd') === 'unknown', 'unclear -> a person decides')

// ---- live results -> R1 findings: only the plug's own failures count
const live = { status: 'tested', actions: [
  { name: 'Get A', status: 'failed', origin: 'plug', originReason: 'bad request', detail: 'Missing required parameter: email' },
  { name: 'Get B', status: 'failed', origin: 'saas', originReason: 'server error', detail: '502 Bad Gateway' },
  { name: 'Get C', status: 'failed', origin: 'unknown', originReason: 'unclear', detail: 'weird' },
  { name: 'Get D', status: 'passed' }], triggers: [] }
const lf = liveFindings(live)
ok(lf.findings.length === 1 && lf.findings[0].criterion === 'R1' && lf.notCounted.length === 2, 'only the plug-side failure becomes R1; SaaS and unclear are listed but not counted')
ok(liveFindings({ status: 'not_tested' }).findings.length === 0, 'no live run -> no R1 finding')

// ---- coverage
ok(buildCoverage({ live, codeAvailable: true }).notAssessed.length === 0, 'live ran and code available -> nothing unassessed')
ok(buildCoverage({ live, codeAvailable: false }).notAssessed.join() === 'R3,R4', 'no plug code -> R3 and R4 not assessed')
ok(buildCoverage({ live: { status: 'not_tested' }, codeAvailable: true }).notAssessed.join() === 'R1', 'no live run -> R1 not assessed')
ok(buildCoverage({ live: { status: 'tested', actions: [{ status: 'not_run' }], triggers: [] }, codeAvailable: true }).notAssessed.includes('R1'), 'live run where nothing actually ran -> R1 not assessed')

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); process.exit(failed ? 1 : 0)
