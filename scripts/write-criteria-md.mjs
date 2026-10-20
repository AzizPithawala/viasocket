// criteria.md is generated from src/review/criteria.js, the single source of truth.
import { writeFileSync } from 'node:fs'
import { CRITERIA, criteriaText } from '../src/review/criteria.js'
const table = CRITERIA.map((c) => `| ${c.id} | ${c.level} | ${c.title} | ${c.method} | ${c.judgement ? 'judgement (lessons may adjust)' : 'hard rule'} |`).join('\n')
writeFileSync('criteria.md', `# Plug review criteria\n\nGenerated from \`src/review/criteria.js\`. Edit that file, then run \`node scripts/write-criteria-md.mjs\`.\n\n| id | outcome | criterion | checked by | kind |\n| --- | --- | --- | --- | --- |\n${table}\n\n## Text the reviewer AI reads\n\n\`\`\`\n${criteriaText()}\n\`\`\`\n`)
console.log('criteria.md written')
