// The verdict is decided here, by rule, from findings. It is a pure function with no imports so the very
// same source can be embedded into the review automation (Function#toString) and tested in the backend.

export function decideVerdict(findings, coverage) {
  const LEVEL = { R1: 'reject', R2: 'reject', R3: 'reject', R4: 'reject', I1: 'improve', I2: 'improve', I3: 'improve', I4: 'improve' }
  const all = Array.isArray(findings) ? findings : []
  // A finding only counts when it names a known criterion and carries evidence.
  const valid = all.filter((f) => LEVEL[f.criterion] && f.evidence && String(f.evidence).trim().length >= 3)
  const rejects = valid.filter((f) => LEVEL[f.criterion] === 'reject')
  const improves = valid.filter((f) => LEVEL[f.criterion] === 'improve')
  const dropped = all.length - valid.length
  if (rejects.length) return { verdict: 'reject', counted: rejects.concat(improves), dropped }
  if (improves.length) return { verdict: 'improve', counted: improves, dropped }
  if (coverage && coverage.complete) return { verdict: 'approve', counted: [], dropped }
  const missing = coverage && coverage.notAssessed ? coverage.notAssessed.join(', ') : 'unknown'
  return { verdict: 'incomplete', counted: [], dropped, reason: 'Nothing wrong was found, but these were not assessed: ' + missing }
}
