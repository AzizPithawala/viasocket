// Concrete wording for fixing I1 and I2 findings, so Improve comes with a ready-to-apply patch.

const CHOICE = new Set(['dropdown', 'multiselect', 'boolean'])
const titleCase = (s) => String(s).replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().replace(/\b\w/g, (c) => c.toUpperCase())
const lower = (s) => String(s).charAt(0).toLowerCase() + String(s).slice(1)
// Sentence case for help and placeholders: "Sample Labels" -> "sample labels", but acronyms such as "ID" stay.
const sentence = (s) => lower(String(s).trim().split(/\s+/).map((w) => (/^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w)).join(' '))

export function proposeLabel(field) { return titleCase(String(field.key).split('.').pop()) }
export function proposePlaceholder(field) {
  const label = field.label || proposeLabel(field)
  return CHOICE.has(field.type) ? `Select ${label}` : `Enter ${sentence(label)}`
}
export function proposeHelp(field) {
  const label = sentence(field.label || proposeLabel(field))
  return CHOICE.has(field.type) ? `Select the ${label}.` : `Enter the ${label}.`
}
/** Fix a help text that exists but starts wrongly, keeping what it says. */
export function fixHelpWording(field) {
  const verb = CHOICE.has(field.type) ? 'Select' : 'Enter'
  const rest = String(field.help || '').trim().replace(/^(please\s+)?(select|enter|choose|provide|type|input|specify|add|pick)\s+(the\s+)?/i, '')
  return `${verb} ${rest ? sentence(rest) : 'the ' + sentence(field.label || proposeLabel(field))}`.replace(/\s+/g, ' ').replace(/[.]*$/, '.')
}
