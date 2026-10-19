import express from 'express'
import { listOptions, listConnections } from '../viasocket.js'
import { GALLERY, KINDS, normalizeSpec } from './spec.js'
import { specFromWords, gallerySpec, assess } from './analyze.js'
import { createAddonService } from './build.js'
import { recentRuns, staleness } from './monitor.js'

const SEND_MESSAGE_VERSION = 'rowj2u3wc8h5'

export function createAddonsRouter({ loadState, loadSettings, dataDir, reviewerId }) {
  const router = express.Router()
  const svc = createAddonService({ loadState, loadSettings, dataDir, reviewerId })
  const ctx = () => ({ state: loadState(), settings: loadSettings(), reviewerId })

  // A spec sent by the browser is never trusted: it is re-validated and must be a kind we can build.
  function buildableSpec(body) {
    const { spec } = normalizeSpec(body?.spec)
    if (!Object.keys(KINDS).includes(spec.kind)) throw new Error('this request cannot be built')
    if (spec.writes_to_other_app) throw new Error('writing to other apps is not supported yet')
    return spec
  }

  async function validChannel(channelId) {
    const authId = loadState().rowbu58rc?.authId
    const channels = await listOptions(reviewerId, SEND_MESSAGE_VERSION, 'destination.channel_id', {}, authId).catch(() => [])
    if (!channels.some((c) => c.value === channelId)) throw new Error('that Slack channel is not available to the connected account')
  }

  const wrap = (fn) => async (req, res) => { try { res.json(await fn(req)) } catch (error) { res.status(400).json({ error: error.message }) } }

  router.get('/gallery', (req, res) => res.json(GALLERY.map(({ id, title, description }) => ({ id, title, description }))))

  // Understand the request and report what can be built. Creates nothing.
  router.post('/analyze', wrap(async (req) => {
    const { text, galleryId } = req.body || {}
    let spec
    if (galleryId) { spec = gallerySpec(galleryId); if (!spec) throw new Error('unknown ready-made add-on') }
    else {
      if (!text || String(text).trim().length < 8) throw new Error('describe what you want in a sentence')
      spec = (await specFromWords(String(text).slice(0, 1000))).spec
    }
    return assess(spec, ctx())
  }))

  router.post('/preview', wrap(async (req) => ({ ...(await svc.preview(buildableSpec(req.body))) })))
  router.post('/test', wrap(async (req) => { await validChannel(req.body?.params?.channelId); return svc.sendTest(buildableSpec(req.body), req.body.params) }))
  router.post('/enable', wrap(async (req) => { await validChannel(req.body?.params?.channelId); return svc.enable(buildableSpec(req.body), req.body.params) }))

  router.get('/', wrap(async () => svc.list().map((item) => ({ ...item, stale: staleness(item, loadState()) }))))
  router.post('/pause-all', wrap(() => svc.pauseAll()))
  router.post('/:id/:action(pause|resume)', wrap((req) => svc.setStatus(req.params.id, req.params.action)))
  router.delete('/:id', wrap((req) => svc.setStatus(req.params.id, 'delete')))
  router.get('/:id/diagnose', wrap(async (req) => {
    const item = svc.list().find((x) => x.id === req.params.id)
    if (!item) throw new Error('add-on not found')
    const state = loadState()
    const probes = {
      connections: () => listConnections(reviewerId),
      channels: async () => (await listOptions(reviewerId, SEND_MESSAGE_VERSION, 'destination.channel_id', {}, state.rowbu58rc?.authId)).map((c) => c.value),
      tables: async () => (await listOptions(reviewerId, 'rowtzrowrz8v', 'table', {}, state.rowe71n93?.authId)).map((t) => t.value)
    }
    const runs = await recentRuns({ proxyToken: await svc.proxyToken(), scriptId: item.scriptId, probes })
    return { runs, stale: staleness(item, loadState()) }
  }))

  return router
}
