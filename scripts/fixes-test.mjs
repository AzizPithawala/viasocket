// Offline tests for applying wording fixes: what is applied, what is refused, and what can never be written.
//   node scripts/fixes-test.mjs
import { readFileSync } from 'node:fs'
import { applyPatch, verifyApplied, findField, stableJson, groupByOperation, ALLOWED_PROPS } from '../src/review/fixes.js'

let failed = 0
const ok = (cond, name, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) failed++ }

const make = () => ({
  steps: { root: ['a', 'grp'] },
  inputFields: [
    { key: 'a', type: 'string', label: '', help: 'Sample Help Text', required: true },
    { key: 'grp', type: 'input groups', label: 'Options', help: 'Extra options.', fields: [{ key: 'limit', type: 'string', label: 'Limit', help: '' }] }
  ],
  blocks: { a: { key: 'a', type: 'string', label: '', help: 'Sample Help Text', required: true }, 'grp.limit': { key: 'limit', label: 'Limit', help: '' } }
})
const patch = [
  { operation: 'Op', field: 'a', set: { label: 'Name', placeholder: 'Enter name', help: 'Enter the name.' }, was: { label: '', placeholder: '', help: 'Sample Help Text' } },
  { operation: 'Op', field: 'grp.limit', set: { help: 'Enter the limit.' }, was: { help: '' } }
]

let r = applyPatch(make(), patch)
ok(r.applied.length === 4 && r.skipped.length === 0, 'missing and badly worded text is applied', r.applied.map((a) => a.field + '.' + a.prop).join(', '))
ok(findField(r.inputjson.inputFields, 'a').label === 'Name' && findField(r.inputjson.inputFields, 'a').help === 'Enter the name.', 'the authored field is updated')
ok(r.inputjson.blocks.a.label === 'Name' && r.inputjson.blocks['grp.limit'].help === 'Enter the limit.', "the engine's copy under blocks is kept in step")
ok(findField(r.inputjson.inputFields, 'grp.limit').help === 'Enter the limit.', 'a field inside an input group is found by its full key')
ok(findField(r.inputjson.inputFields, 'a').required === true && r.inputjson.steps.root.join() === 'a,grp', 'nothing else in the definition is touched')
const original = make(); applyPatch(original, patch); ok(stableJson(original) === stableJson(make()), 'the input is never mutated')

// refuse to overwrite a change made after the review
const edited = make(); edited.inputFields[0].help = 'Someone rewrote this'
r = applyPatch(edited, patch); ok(r.skipped.some((s) => s.field === 'a' && s.prop === 'help' && /changed after the review/.test(s.reason)), 'a help text edited since the review is not overwritten')
ok(findField(r.inputjson.inputFields, 'a').help === 'Someone rewrote this', 'and it stays exactly as the person left it')
const labelled = make(); labelled.inputFields[0].label = 'Already named'
r = applyPatch(labelled, patch); ok(r.skipped.some((s) => s.prop === 'label') && findField(r.inputjson.inputFields, 'a').label === 'Already named', 'a label added since the review is not overwritten')

// nothing to do / unknown / needs a person
r = applyPatch(r.inputjson, patch); ok(r.applied.length <= 1, 'a second run does not pile up changes', `${r.applied.length} applied`)
r = applyPatch(make(), [{ operation: 'Op', field: 'gone', set: { help: 'x' }, was: { help: '' } }]); ok(r.skipped[0]?.reason.includes('no longer in the action') && !r.applied.length, 'a field that no longer exists is skipped')
r = applyPatch(make(), [{ operation: 'Op', field: 'a', set: { suggestion: 'Make this a dropdown' }, was: {} }]); ok(r.skipped[0]?.prop === 'dropdown' && !r.applied.length, 'a dropdown suggestion is reported, never applied')

// the only things that can ever change
r = applyPatch(make(), [{ operation: 'Op', field: 'a', set: { required: false, type: 'dropdown', key: 'zzz', source: 'return 1', label: 'Name' }, was: { label: '' } }])
ok(r.applied.length === 1 && r.applied[0].prop === 'label', 'only label, placeholder and help can be applied', ALLOWED_PROPS.join('/'))
const f = findField(r.inputjson.inputFields, 'a'); ok(f.required === true && f.type === 'string' && f.key === 'a' && !f.source, 'required, type, key and code are never changed, even if a patch asks')

// verification
r = applyPatch(make(), patch); ok(verifyApplied(r.inputjson, r.applied).length === 0, 'a correct write verifies')
const wrong = clone(r.inputjson); wrong.inputFields[0].label = 'Other'; ok(verifyApplied(wrong, r.applied).some((b) => b.prop === 'label'), 'a saved definition that differs is caught')
ok(stableJson({ b: 1, a: [{ d: 1, c: 2 }] }) === stableJson({ a: [{ c: 2, d: 1 }], b: 1 }), 'comparison ignores key order')

// grouping
const ops = [{ action: { rowid: 'rowA', name: 'Op', type: 'action' }, version: { rowid: 'rowV', versionid: 'V1', status: 'drafted' } }, { action: { rowid: 'rowB', name: 'Other', type: 'trigger' }, version: { rowid: 'rowW', versionid: 'V2', status: 'published' } }]
const groups = groupByOperation(ops, patch); ok(groups.length === 1 && groups[0].versionId === 'rowV' && groups[0].entries.length === 2, 'a patch is grouped per operation with the version it was reviewed on')
function clone(o) { return JSON.parse(JSON.stringify(o)) }


// ---- the write surface of the whole agent
const w = readFileSync(new URL('../src/devhubwrite.js', import.meta.url), 'utf8')
const allowed = (w.match(/const ALLOWED = \[(.*)\]/) || [])[1] || ''
ok(allowed.includes('updateActionVersionDetails') && !allowed.includes(',') && !allowed.includes('|'), "devhubwrite.js can reach exactly one endpoint: save a version's fields")
ok(/method: 'PUT'/.test(w) && !/method:\s*['"](POST|PATCH|DELETE)['"]/i.test(w), 'it only ever uses PUT')
ok(/DEVHUB_WRITES === '1'/.test(w), 'it is off unless DEVHUB_WRITES=1')
const { writesEnabled } = await import('../src/devhubwrite.js'); ok(writesEnabled() === false, 'writes are off by default in this environment')
import { readdirSync } from 'node:fs'
const importers = []
for (const dir of ['../src', '../src/review', '../src/addons']) for (const f of readdirSync(new URL(dir + '/', import.meta.url))) { if (!f.endsWith('.js')) continue; const t = readFileSync(new URL(`${dir}/${f}`, import.meta.url), 'utf8'); if (/saveVersionInputjson/.test(t) && f !== 'devhubwrite.js') importers.push(f) }
ok(importers.join() === 'fixops.js', 'only fixops.js can call the save function', importers.join(', '))

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); process.exit(failed ? 1 : 0)
