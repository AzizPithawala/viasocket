import express from 'express'
import { CRITERIA } from './criteria.js'

export function createLearningRouter({ learning }) {
  const router = express.Router()
  const wrap = (fn) => async (req, res) => { try { res.json(await fn(req)) } catch (error) { res.status(400).json({ error: error.message }) } }

  // Score, outcomes, pending feedback and lessons. Reading it first picks up any new decisions.
  router.get('/', wrap(async () => ({ ...(await learning.sync().catch(() => learning.summary())), criteria: CRITERIA })))
  router.post('/feedback', wrap((req) => learning.feedback(String(req.body?.key || ''), { correct: Boolean(req.body?.correct), shouldBe: req.body?.shouldBe, note: req.body?.note })))
  router.post('/lessons/:id', wrap((req) => learning.setLesson(req.params.id, Boolean(req.body?.active))))
  return router
}
