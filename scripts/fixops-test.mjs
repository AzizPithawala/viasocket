// Offline tests for the risky branches of applying fixes, against an in-memory stand-in for Developer Hub:
// a published version, a write that does not save as intended, double edits, and undo after later changes.
//   node scripts/fixops-test.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixOps } from '../src/review/fixops.js'
import { createFixStore } from '../src/review/fixstore.js'
import { stableJson } from '../src/review/fixes.js'

let failed = 0
const ok = (cond, name, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) failed++ }
const clone = (o) => JSON.parse(JSON.stringify(o))

/** A fake Developer Hub holding one version. `mode` can make the save misbehave. */
function fakeHub({ status = 'drafted' } = {}) {
  const hub = { writes: [], mode: 'ok', version: { rowid: 'rowV', versionid: 'V1', status, inputjson: { inputFields: [{ key: 'a', type: 'string', label: '', help: 'Sample Help Text', required: true }], blocks: { a: { key: 'a', label: '', help: 'Sample Help Text' } } } } }
  hub.io = {
    getPlugs: async () => [{ rowid: 'rowP', name: 'Plug' }],
    forgetCache: () => {},
    getPlugBundle: async () => ({ operations: [{ action: { rowid: 'rowA', name: 'Op', type: 'action' }, version: { rowid: hub.version.rowid, versionid: hub.version.versionid, status: hub.version.status }, inputjson: clone(hub.version.inputjson), mappings: [] }] }),
    saveVersionInputjson: async (id, inputjson) => {
      hub.writes.push(clone(inputjson))
      if (hub.mode === 'ignore') return // the write "succeeds" but nothing is saved
      if (hub.mode === 'corrupt') { const c = clone(inputjson); c.inputFields[0].label = 'Something else'; hub.version.inputjson = c; return }
      hub.version.inputjson = clone(inputjson)
    }
  }
  return hub
}
const op = { actionId: 'rowA', actionName: 'Op', versionId: 'rowV', versionLabel: 'V1 drafted', entries: [{ operation: 'Op', field: 'a', set: { label: 'Name', help: 'Enter the name.' }, was: { label: '', help: 'Sample Help Text' } }] }
const fix = { id: 'fx_test', pluginId: 'rowP' }
const setup = (opts) => { const hub = fakeHub(opts); const store = createFixStore({ dataDir: mkdtempSync(join(tmpdir(), 'fixops-')) }); return { hub, ops: createFixOps({ store, io: hub.io }), store } }
const plug = { rowid: 'rowP', name: 'Plug' }

// a draft: applied, verified, and undoable
let t = setup(); let r = await t.ops.applyOpWrite(fix, plug, op)
ok(r.status === 'applied' && r.applied.length === 2 && t.hub.writes.length === 1, 'a draft is changed once and the change is verified', r.status)
ok(t.hub.version.inputjson.inputFields[0].label === 'Name' && t.hub.version.inputjson.inputFields[0].required === true, 'only the wording changed')
let u = await t.ops.undoOpWrite(fix, plug, op, r); ok(u.status === 'undone' && t.hub.version.inputjson.inputFields[0].label === '' && t.hub.version.inputjson.inputFields[0].help === 'Sample Help Text', 'undo puts back exactly what was there')

// a published version is never written
t = setup({ status: 'published' }); r = await t.ops.applyOpWrite(fix, plug, op)
ok(r.status === 'skipped' && /published/.test(r.reason) && t.hub.writes.length === 0, 'a published version is refused and nothing is written')
ok((await t.ops.previewOp(plug, op)).state === 'published', 'the preview says it is published')

// the version changed after the review
t = setup(); t.hub.version.inputjson.inputFields[0].help = 'Someone rewrote this'; r = await t.ops.applyOpWrite(fix, plug, op)
ok(r.status === 'applied' && r.applied.length === 1 && r.skipped.some((s) => s.prop === 'help') && t.hub.version.inputjson.inputFields[0].help === 'Someone rewrote this', 'an edit made since the review survives; only the untouched label is applied')
t = setup(); t.hub.version.inputjson.inputFields[0] = { key: 'a', type: 'string', label: 'Named', help: 'Enter it.', required: true }; r = await t.ops.applyOpWrite(fix, plug, op)
ok(r.status === 'nothing' && t.hub.writes.length === 0, 'when everything changed since the review, nothing is written')

// the write does not save as intended: the original is put back
t = setup(); t.hub.mode = 'corrupt'; const orig = clone(t.hub.version.inputjson); r = await t.ops.applyOpWrite(fix, plug, op)
ok(r.status === 'failed' && t.hub.writes.length === 2, 'a save that does not match is detected and the original written back', 'writes: ' + t.hub.writes.length)
ok(stableJson(t.hub.writes[1].inputFields) === stableJson(orig.inputFields), 'the restore writes the exact original fields')
t = setup(); t.hub.mode = 'ignore'; r = await t.ops.applyOpWrite(fix, plug, op); ok(r.status === 'failed', 'a write that silently saves nothing is caught')

// the version or action vanished
t = setup(); const gone = { ...op, versionId: 'rowGONE' }; r = await t.ops.applyOpWrite(fix, plug, gone); ok(r.status === 'skipped' && t.hub.writes.length === 0, 'a reviewed version that no longer exists is skipped')

// undo must not overwrite later edits
t = setup(); r = await t.ops.applyOpWrite(fix, plug, op); t.hub.version.inputjson.inputFields[0].label = 'Edited after apply'; const before = t.hub.writes.length
u = await t.ops.undoOpWrite(fix, plug, op, r); ok(u.status === 'skipped' && /changed again/.test(u.reason) && t.hub.writes.length === before, 'undo refuses when the fields changed after the apply, protecting those edits')

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); process.exit(failed ? 1 : 0)
