// The review criteria. One definition feeds the verdict, the AI prompt and the dashboard.
// "judgement" criteria depend on reading the API docs or on taste, so lessons may adjust them.
// The others are hard rules: code decides them and no lesson can soften them.

export const CRITERIA = [
  { id: 'R1', level: 'reject', title: 'A live run fails because of our side', judgement: false, method: 'live run',
    text: 'A live run fails because of the plug: bad request, wrong endpoint, wrong auth handling, or an error in the plug code. A failure on the SaaS side (5xx, rate limit, outage, plan or account limits) is NOT counted.' },
  { id: 'R2', level: 'reject', title: 'A documented field is missing from the action', judgement: true, method: 'API docs',
    text: "A parameter the API docs list for this operation is missing from the action's fields." },
  { id: 'R3', level: 'reject', title: 'The error component is not imported', judgement: false, method: 'plug code (Developer Hub)',
    text: 'The error component is not imported or mapped in the action or trigger code.' },
  { id: 'R4', level: 'reject', title: 'Code validation is not handled', judgement: false, method: 'plug code (Developer Hub)',
    text: 'Code validation is not handled: no required-field checks, no try/catch around requests, or unvalidated inputs.' },
  { id: 'I1', level: 'improve', title: 'A label or placeholder is missing', judgement: false, method: 'schema',
    text: 'A field has no label, or no placeholder where its type needs one.' },
  { id: 'I2', level: 'improve', title: 'Help is missing or badly written', judgement: false, method: 'schema',
    text: 'Help is missing, or does not start with Enter (text fields) or Select (choices), or is long or technical.' },
  { id: 'I3', level: 'improve', title: 'A text field should be a dropdown', judgement: true, method: 'schema + judgement',
    text: 'A free-text string field holds something the user would otherwise copy from the app (an ID) or choose from fixed values, so it should be a dropdown.' },
  { id: 'I4', level: 'improve', title: 'Other UX / UI problems', judgement: true, method: 'judgement',
    text: 'Other UX or UI problems: naming, field order, grouping, long descriptions, unclear wording.' }
]

export const LEVEL = Object.fromEntries(CRITERIA.map((c) => [c.id, c.level]))
export const JUDGEMENT_IDS = CRITERIA.filter((c) => c.judgement).map((c) => c.id)
export const HARD_IDS = CRITERIA.filter((c) => !c.judgement).map((c) => c.id)
export const REJECT_IDS = CRITERIA.filter((c) => c.level === 'reject').map((c) => c.id)

/** The text the AI reads: the criteria, the verdict rules, and any lessons learned from being overruled. */
export function criteriaText(lessons = []) {
  const line = (c) => `${c.id} ${c.title}: ${c.text}`
  const active = lessons.filter((l) => l.active)
  return [
    'REJECT if any of these is found, with evidence:',
    ...CRITERIA.filter((c) => c.level === 'reject').map(line),
    '',
    'IMPROVE if any of these is found (and no reject criterion):',
    ...CRITERIA.filter((c) => c.level === 'improve').map(line),
    '',
    'APPROVE only when nothing above is found and every reject criterion was actually checked.',
    'Report findings only for R2, I3 and I4; the rest are checked by code. Every finding needs a short quote or fact from the docs or the plug as evidence. Do not choose the verdict yourself.',
    ...(active.length ? ['', 'Corrections from past reviews (the reviewer overruled earlier verdicts; apply these when judging R2, I3, I4):', ...active.map((l) => `- [${l.criterion}] ${l.guidance}`)] : [])
  ].join('\n')
}
