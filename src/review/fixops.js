import { getPlugs as realGetPlugs, getPlugBundle as realGetPlugBundle, forgetCache as realForgetCache } from '../devhub.js'
import { saveVersionInputjson as realSave } from '../devhubwrite.js'
import { applyPatch, verifyApplied, stableJson } from './fixes.js'

// The per-operation work behind "apply the fixes": read the version fresh, back it up, write, read it back, restore if
// it does not match; or undo from the backup. Writes only happen through src/devhubwrite.js (off unless enabled).

/** `io` lets a test stand in for Developer Hub; in the app it is always the real read and write modules. */
export function createFixOps({ store, io = {} }) {
  const getPlugs = io.getPlugs || realGetPlugs, getPlugBundle = io.getPlugBundle || realGetPlugBundle
  const forgetCache = io.forgetCache || realForgetCache, saveVersionInputjson = io.saveVersionInputjson || realSave
  async function plugOf(fix) {
    const plug = (await getPlugs()).find((p) => p.rowid === fix.pluginId)
    if (!plug) throw new Error('the plug is no longer in this Developer Hub org')
    return plug
  }

  async function readOp(plug, op) {
    forgetCache()
    const bundle = await getPlugBundle(plug, { actionId: op.actionId, versionId: op.versionId })
    return bundle.operations[0] || null
  }

  async function previewOp(plug, op) {
    const cur = await readOp(plug, op)
    if (!cur) return { actionName: op.actionName, state: 'gone', note: 'This action is no longer in the plug.', applied: [], skipped: [] }
    if (cur.version.rowid !== op.versionId) return { actionName: op.actionName, state: 'gone', note: 'The version that was reviewed no longer exists. Submit it for review again.', applied: [], skipped: [] }
    const { applied, skipped } = applyPatch(cur.inputjson, op.entries)
    const draft = cur.version.status === 'drafted'
    return { actionName: op.actionName, versionLabel: `${cur.version.versionid} ${cur.version.status}`, state: draft ? 'ready' : 'published', note: draft ? '' : 'Published versions are never edited. Copying to a new draft is not built yet.', applied, skipped }
  }

  async function applyOpWrite(fix, plug, op) {
    const cur = await readOp(plug, op)
    if (!cur || cur.version.rowid !== op.versionId) return { actionName: op.actionName, status: 'skipped', reason: 'the reviewed version is no longer there' }
    if (cur.version.status !== 'drafted') return { actionName: op.actionName, status: 'skipped', reason: 'it is published, and published versions are never edited' }
    const { inputjson: after, applied, skipped } = applyPatch(cur.inputjson, op.entries)
    if (!applied.length) return { actionName: op.actionName, status: 'nothing', skipped }

    // 1. back up exactly what is there now
    const backup = store.saveBackup(`${fix.id}-${op.versionId}-${Date.now()}`, { fixId: fix.id, pluginId: fix.pluginId, actionId: op.actionId, versionId: op.versionId, actionName: op.actionName, at: new Date().toISOString(), inputjson: cur.inputjson })
    // 2. write, 3. read it back from Developer Hub and check it says what was applied
    await saveVersionInputjson(op.versionId, after)
    const saved = await readOp(plug, op)
    const mismatches = saved ? verifyApplied(saved.inputjson, applied) : [{ expected: 'the version', found: 'nothing' }]
    if (mismatches.length) {
      // 4. it did not save as intended: put the original back
      await saveVersionInputjson(op.versionId, cur.inputjson)
      return { actionName: op.actionName, status: 'failed', reason: 'the saved definition did not match, so the original was restored', mismatches, backup }
    }
    // Developer Hub records a save entry on the version itself; the agent keeps its own backup and log in the fix record.
    return { actionName: op.actionName, status: 'applied', applied, skipped, backup, afterFingerprint: stableJson(saved.inputjson.inputFields) }
  }

  async function undoOpWrite(fix, plug, op, result) {
    const backup = store.readBackup(result.backup)
    const cur = await readOp(plug, op)
    if (!cur) return { actionName: op.actionName, status: 'skipped', reason: 'the action is no longer there' }
    // Only undo if nothing else changed since: otherwise this would overwrite someone's later edits.
    if (stableJson(cur.inputjson.inputFields) !== result.afterFingerprint) return { actionName: op.actionName, status: 'skipped', reason: 'the fields changed again after the fixes were applied, so nothing was undone to protect those edits' }
    await saveVersionInputjson(op.versionId, backup.inputjson)
    const back = await readOp(plug, op)
    if (!back || stableJson(back.inputjson.inputFields) !== stableJson(backup.inputjson.inputFields)) return { actionName: op.actionName, status: 'failed', reason: 'the restored fields do not match the backup' }
    return { actionName: op.actionName, status: 'undone' }
  }

  return { plugOf, readOp, previewOp, applyOpWrite, undoOpWrite }
}
