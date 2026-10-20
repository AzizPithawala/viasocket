// A reversible live test of the write path on ONE throwaway draft. Run it only on a plug you do not mind touching.
//   DEVHUB_WRITES=1 node --env-file=.env scripts/fixes-live-test.mjs <pluginRowId> "<action name>"
// It snapshots the version, does a no-op write, applies the real fixes, verifies, undoes, and verifies the restore.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPlugs, getPlugBundle, forgetCache } from '../src/devhub.js'
import { saveVersionInputjson, writesEnabled } from '../src/devhubwrite.js'
import { schemaChecks } from '../src/review/checks.js'
import { catalogShape } from '../src/review/codechecks.js'
import { groupByOperation, stableJson } from '../src/review/fixes.js'
import { createFixStore } from '../src/review/fixstore.js'
import { createFixOps } from '../src/review/fixops.js'

if (!writesEnabled()) { console.log('Writes are off. Run with DEVHUB_WRITES=1.'); process.exit(2) }
const [pluginId, actionName] = process.argv.slice(2)
const dir = mkdtempSync(join(tmpdir(), 'fixlive-')), store = createFixStore({ dataDir: dir }), ops = createFixOps({ store })
const plug = (await getPlugs()).find((p) => p.rowid === pluginId); if (!plug) { console.log('plug not found'); process.exit(1) }
const read = async (op) => { forgetCache(); const b = await getPlugBundle(plug, { actionId: op.action.rowid, versionId: op.version.rowid }); return b.operations[0] }

const all = await getPlugBundle(plug)
const target = all.operations.find((o) => o.action.name === actionName); if (!target) { console.log('action not found'); process.exit(1) }
console.log(`target: ${plug.name} › ${target.action.name} | version ${target.version.versionid} ${target.version.status} | plug status ${plug.status}`)
if (target.version.status !== 'drafted') { console.log('not a draft: refusing'); process.exit(1) }

// 0. snapshot everything about the version, to restore by hand if anything goes wrong
const snap = await read(target)
const columns = ['perform', 'performlist', 'performsubscribe', 'performunsubscribe', 'modifytriggerdata', 'transferoption', 'sampledata', 'authid', 'status', 'triggertype']
const fingerprint = (op) => stableJson(Object.fromEntries(columns.map((c) => [c, op.version[c] ?? null])))
const snapFile = join(dir, 'full-snapshot.json'); writeFileSync(snapFile, JSON.stringify({ version: snap.version, action: target.action }, null, 2))
console.log('snapshot saved:', snapFile)
const baseline = fingerprint(snap), baseFields = stableJson(snap.inputjson.inputFields)

// 1. a no-op write: same inputjson back. Proves a partial save leaves every other column alone.
await saveVersionInputjson(target.version.rowid, snap.inputjson)
const afterNoop = await read(target)
console.log('no-op write: other columns unchanged:', fingerprint(afterNoop) === baseline, '| fields unchanged:', stableJson(afterNoop.inputjson.inputFields) === baseFields, '| blocks keys:', Object.keys(afterNoop.inputjson.blocks || {}).length, 'before', Object.keys(snap.inputjson.blocks || {}).length)
if (fingerprint(afterNoop) !== baseline) { console.log('STOP: a partial save changed other columns. Snapshot is in', snapFile); process.exit(1) }

// 2. the real fixes
const patch = schemaChecks(catalogShape({ plug, authType: null, operations: [snap] })).patch
const op = groupByOperation([snap], patch)[0]
if (!op) { console.log('no wording fixes proposed for this action'); process.exit(0) }
const fix = { id: 'fx_livetest', pluginId }
const preview = await ops.previewOp(plug, op)
console.log('\nPREVIEW:', preview.state); for (const a of preview.applied) console.log(`  ${a.field}.${a.prop}: "${a.from}" -> "${a.to}"`)
const result = await ops.applyOpWrite(fix, plug, op)
console.log('\nAPPLY:', result.status, '| applied', (result.applied || []).length, '| skipped', (result.skipped || []).length)
if (result.status !== 'applied') { console.log(JSON.stringify(result).slice(0, 400)); process.exit(1) }

// 3. what really changed in Developer Hub
const afterApply = await read(target)
console.log('after apply: other columns unchanged:', fingerprint(afterApply) === baseline)
for (const a of result.applied) { const f = (afterApply.inputjson.inputFields || []).find((x) => x.key === a.field); const blk = afterApply.inputjson.blocks?.[a.field]; console.log(`  saved ${a.field}.${a.prop} = "${f?.[a.prop]}" | engine copy = "${blk?.[a.prop]}"`) }
const required = (snap.inputjson.inputFields || []).map((f) => f.required).join() === (afterApply.inputjson.inputFields || []).map((f) => f.required).join()
console.log('  required flags, types, keys untouched:', required && (snap.inputjson.inputFields || []).map((f) => f.key + f.type).join() === (afterApply.inputjson.inputFields || []).map((f) => f.key + f.type).join())

// 4. undo, and check it is exactly what it was
const undo = await ops.undoOpWrite(fix, plug, op, result)
console.log('\nUNDO:', undo.status, undo.reason || '')
const restored = await read(target)
console.log('restored: fields identical to the snapshot:', stableJson(restored.inputjson.inputFields) === baseFields, '| other columns unchanged:', fingerprint(restored) === baseline)
console.log('backup files kept in:', dir)
