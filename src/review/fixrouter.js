import express from 'express'
import { writesEnabled } from '../devhubwrite.js'
import { createFixOps } from './fixops.js'

// Apply the review's wording fixes to a DRAFT version in Developer Hub, only after a person chose Improve and then
// pressed Apply. Each write is backed up first, checked by reading it back, restored if it does not match, and can
// be undone. Published versions are never edited.

const BUSY = new Set()

export function createFixRouter({ store, readRows }) {
  const router = express.Router()
  const { plugOf, previewOp, applyOpWrite, undoOpWrite } = createFixOps({ store })
  const wrap = (fn) => async (req, res) => { try { res.json(await fn(req)) } catch (error) { res.status(400).json({ error: error.message }) } }

  // Did a person choose Improve for this review? (the decision is recorded under "<review key>:improve")
  async function improved(key) {
    const rows = await readRows()
    return rows.some((r) => r.idempotency_key === `${key}:improve`)
  }

  router.get('/', wrap(async () => {
    const rows = await readRows().catch(() => [])
    const done = new Set(rows.filter((r) => r.idempotency_key).map((r) => r.idempotency_key))
    return { writesEnabled: writesEnabled(), fixes: store.list().map((f) => ({ ...f, eligible: done.has(`${f.key}:improve`) })) }
  }))

  router.post('/:id/preview', wrap(async (req) => {
    const fix = store.get(req.params.id); if (!fix) throw new Error('fix not found')
    const plug = await plugOf(fix)
    return { id: fix.id, ops: await Promise.all(fix.ops.map((op) => previewOp(plug, op))) }
  }))

  router.post('/:id/apply', wrap(async (req) => {
    if (!writesEnabled()) throw new Error('Writing to Developer Hub is switched off. Set DEVHUB_WRITES=1 to allow it.')
    if (req.body?.confirm !== true) throw new Error('Confirm that you want to write these changes to Developer Hub.')
    const fix = store.get(req.params.id); if (!fix) throw new Error('fix not found')
    if (fix.status !== 'proposed') throw new Error(`these fixes are already ${fix.status}`)
    if (!(await improved(fix.key))) throw new Error('Fixes can only be applied after a reviewer chose Improve for this review.')
    if (BUSY.has(fix.id)) throw new Error('already working on this one')
    BUSY.add(fix.id)
    try {
      const plug = await plugOf(fix)
      const results = []
      for (const op of fix.ops) results.push({ actionId: op.actionId, ...(await applyOpWrite(fix, plug, op)) })
      return store.update(fix.id, { status: results.some((r) => r.status === 'applied') ? 'applied' : 'nothing-applied', appliedAt: new Date().toISOString(), results })
    } finally { BUSY.delete(fix.id) }
  }))

  router.post('/:id/undo', wrap(async (req) => {
    if (!writesEnabled()) throw new Error('Writing to Developer Hub is switched off. Set DEVHUB_WRITES=1 to allow it.')
    const fix = store.get(req.params.id); if (!fix || fix.status !== 'applied') throw new Error('there is nothing applied to undo')
    if (BUSY.has(fix.id)) throw new Error('already working on this one')
    BUSY.add(fix.id)
    try {
      const plug = await plugOf(fix)
      const undone = []
      for (const result of fix.results.filter((r) => r.status === 'applied')) {
        const op = fix.ops.find((o) => o.actionId === result.actionId)
        undone.push({ actionId: result.actionId, ...(await undoOpWrite(fix, plug, op, result)) })
      }
      return store.update(fix.id, { status: undone.every((u) => u.status === 'undone') ? 'undone' : 'applied', undoneAt: new Date().toISOString(), undo: undone })
    } finally { BUSY.delete(fix.id) }
  }))

  router.post('/:id/dismiss', wrap((req) => { const fix = store.get(req.params.id); if (!fix || fix.status !== 'proposed') throw new Error('nothing to dismiss'); return store.update(fix.id, { status: 'dismissed' }) }))

  return router
}
