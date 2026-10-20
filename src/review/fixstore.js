import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'

/** Proposals ("fixes ready to apply") and the backups taken before any write. Plain JSON files in DATA_DIR. */
export function createFixStore({ dataDir, suffix = '' }) {
  const file = `${dataDir}/fixes${suffix}.json`, backups = `${dataDir}/devhub-backups${suffix}`
  mkdirSync(dataDir, { recursive: true })
  const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [])
  const save = (items) => { writeFileSync(`${file}.tmp`, JSON.stringify(items, null, 2)); renameSync(`${file}.tmp`, file) }

  return {
    list: load,
    get: (id) => load().find((x) => x.id === id) || null,
    /** One proposal per review key. A new review replaces an old one that was never applied. */
    upsert(proposal) {
      const items = load()
      const same = items.find((x) => x.key === proposal.key)
      if (same && same.status !== 'proposed') return same // applied or undone: keep the record, do not overwrite history
      const next = { id: same?.id || `fx_${Date.now().toString(36)}`, status: 'proposed', createdAt: new Date().toISOString(), ...proposal }
      save(same ? items.map((x) => (x.id === same.id ? next : x)) : [next, ...items].slice(0, 200))
      return next
    },
    update(id, changes) { const items = load(); const i = items.findIndex((x) => x.id === id); if (i < 0) throw new Error('fix not found'); items[i] = { ...items[i], ...changes }; save(items); return items[i] },
    saveBackup(name, data) { mkdirSync(backups, { recursive: true }); const path = `${backups}/${name}.json`; writeFileSync(path, JSON.stringify(data, null, 2)); return path },
    readBackup: (path) => JSON.parse(readFileSync(path, 'utf8'))
  }
}
