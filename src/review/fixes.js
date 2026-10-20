// Applying the review's wording fixes to a field definition. Pure functions, no network, so every rule here is
// tested offline before anything can write to Developer Hub.
//   - only label, placeholder and help are ever changed
//   - a value is only replaced if it still says exactly what it said at review time (nothing changed since)
//   - anything that needs a person (turning a text field into a dropdown) is reported, never applied

export const ALLOWED_PROPS = ['label', 'placeholder', 'help']
const clone = (o) => JSON.parse(JSON.stringify(o ?? {}))

/** Visit every authored field, nested ones included, with their full dotted key (group.child). */
function walk(fields, prefix, visit) {
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f !== 'object' || !f.key) continue
    const full = prefix ? `${prefix}.${f.key}` : String(f.key)
    visit(f, full)
    if (Array.isArray(f.fields)) walk(f.fields, full, visit)
  }
}

export function findField(inputFields, fullKey) {
  let hit = null
  walk(inputFields, '', (f, key) => { if (!hit && key === fullKey) hit = f })
  return hit
}

/** Stable JSON (sorted keys), so "same definition" does not depend on key order. */
export function stableJson(value) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v)
  return JSON.stringify(sort(value))
}

/**
 * Apply patch entries ({ field, set, was }) to an inputjson. Returns a changed copy plus what was applied and what
 * was skipped and why. The engine's own copy under `blocks` is kept in step so the two never disagree.
 */
export function applyPatch(inputjson, entries) {
  const next = clone(inputjson)
  const applied = [], skipped = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const set = entry?.set || {}
    for (const prop of ALLOWED_PROPS) {
      if (!(prop in set)) continue
      const to = String(set[prop])
      const field = findField(next.inputFields, entry.field)
      if (!field) { skipped.push({ field: entry.field, prop, reason: 'the field is no longer in the action' }); continue }
      const current = field[prop] == null ? '' : String(field[prop])
      const expected = entry.was && prop in entry.was ? String(entry.was[prop]) : ''
      if (current !== expected) { skipped.push({ field: entry.field, prop, reason: 'it was changed after the review' }); continue }
      if (current === to) { skipped.push({ field: entry.field, prop, reason: 'it already says that' }); continue }
      field[prop] = to
      if (next.blocks && next.blocks[entry.field]) next.blocks[entry.field][prop] = to
      applied.push({ field: entry.field, prop, from: current, to })
    }
    if (set.suggestion) skipped.push({ field: entry.field, prop: 'dropdown', reason: 'needs a person: a dropdown needs a list source from the app' })
  }
  return { inputjson: next, applied, skipped }
}

/** After a write: do the saved definitions really say what was applied? Returns the mismatches. */
export function verifyApplied(inputjson, applied) {
  const bad = []
  for (const a of applied) {
    const field = findField(inputjson?.inputFields, a.field)
    const now = field && field[a.prop] != null ? String(field[a.prop]) : ''
    if (now !== a.to) bad.push({ field: a.field, prop: a.prop, expected: a.to, found: now })
  }
  return bad
}

/** Group a flat patch by operation, tied to the version each operation was reviewed on. */
export function groupByOperation(operations, patch) {
  return operations
    .map((op) => ({ actionId: op.action.rowid, actionName: op.action.name, type: op.action.type, versionId: op.version.rowid, versionLabel: `${op.version.versionid} ${op.version.status}`, entries: patch.filter((p) => p.operation === op.action.name) }))
    .filter((g) => g.entries.length)
}
