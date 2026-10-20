// Offline tests for the R3/R4 code checks and the read-only guarantee of the Developer Hub module.
//   node scripts/codecheck-test.mjs
import { readFileSync } from 'node:fs'
import { codeChecks, definitionFromBundle, catalogShape } from '../src/review/codechecks.js'
import { schemaChecks } from '../src/review/checks.js'

let failed = 0
const ok = (cond, name, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) failed++ }

const ERR = { rowid: 'cERR', function_name: 'errorComponent' }, LIST = { rowid: 'cLIST', function_name: 'fetchLists' }
const field = (key, o = {}) => ({ key, type: 'string', label: key, help: 'Enter ' + key + '.', placeholder: 'Enter ' + key, required: false, ...o })
const op = (o) => ({ action: { type: o.type || 'action', name: o.name || 'Create Item', description: 'd' }, version: { versionid: 'V1', status: 'drafted', perform: '', performlist: '', performsubscribe: '', performunsubscribe: '', modifytriggerdata: '', transferoption: '', ...(o.code || {}) }, inputjson: { blocks: Object.fromEntries((o.fields || []).map((f) => [f.key, f])) }, mappings: (o.mapped || ['cERR']).map((id) => ({ component_id: id })) })
const run = (o, components = [ERR, LIST]) => codeChecks({ plug: { name: 'T' }, components, operations: [op(o)] })
const ids = (r) => r.findings.map((f) => f.criterion).sort().join(',')
const GOOD = `try {\n  const { title } = context?.inputData\n  if (!title) { throw new Error('Title is required.') }\n  const r = await axios.post('https://api.example.com/items', { title })\n  return r.data\n} catch (error) {\n  await errorComponent(error)\n}`

let r = run({ code: { perform: GOOD }, fields: [field('title', { required: true })] })
ok(r.findings.length === 0, 'a clean action has no findings', JSON.stringify(r.findings.map((f) => f.detail)))

// ---- R3
r = run({ code: { perform: `const r = await axios.get('https://x.io/a')\nreturn r.data` } }); ok(ids(r).includes('R3') && r.findings.some((f) => /not called/.test(f.detail)), 'no errorComponent call at all -> R3')
r = run({ code: { perform: `try {\n await axios.get('https://x.io/a')\n} catch (e) {\n throw e\n}` } }); ok(r.findings.some((f) => f.criterion === 'R3' && /not called/.test(f.detail)), 'try/catch that rethrows instead of calling errorComponent -> R3')
r = run({ code: { perform: `try {\n await axios.get('https://x.io/a')\n} catch (e) {\n console.log(e)\n}\nawait errorComponent({})` } }); ok(r.findings.some((f) => f.criterion === 'R3' && /not awaited in the catch/.test(f.detail)), 'errorComponent called outside the catch -> R3 (not awaited in the catch)')
r = run({ code: { perform: GOOD }, fields: [field('title', { required: true })], mapped: [] }); ok(r.findings.some((f) => f.criterion === 'R3' && /not mapped/.test(f.detail) && /errorComponent/.test(f.evidence)), 'errorComponent called but not mapped -> R3')
r = run({ code: { perform: GOOD.replace('const r =', 'await fetchLists()\n  const r =') }, fields: [field('title', { required: true })] }); ok(r.findings.some((f) => f.criterion === 'R3' && /fetchLists/.test(f.evidence)), 'another component used but not mapped -> R3')
r = run({ code: { perform: GOOD.replace('const r =', 'await fetchLists()\n  const r =') }, fields: [field('title', { required: true })], mapped: ['cERR', 'cLIST'] }); ok(r.findings.length === 0, 'a mapped component is fine')
r = run({ code: { perform: `// await errorComponent(error)\nconst r = await axios.get('https://x.io')\nreturn r.data` } }); ok(r.findings.some((f) => /not called/.test(f.detail)), 'errorComponent only in a comment does not count')

// ---- R4
r = run({ code: { perform: `const r = await axios.get('https://x.io/a')\nawait errorComponent(r)\nreturn r.data` } }); ok(r.findings.some((f) => f.criterion === 'R4' && /No try\/catch/.test(f.detail)), 'no try/catch -> R4')
r = run({ code: { perform: GOOD.replace("  if (!title) { throw new Error('Title is required.') }\n", '') }, fields: [field('title', { required: true })] }); ok(r.findings.some((f) => f.criterion === 'R4' && /not validated/.test(f.detail) && /title/.test(f.evidence)), 'required field with no guard -> R4')
r = run({ code: { perform: GOOD.replace("if (!title)", "if (!title || !body)").replace('{ title }', '{ title, body }') }, fields: [field('title', { required: true }), field('body', { required: true })] }); ok(r.findings.length === 0, 'two required fields guarded in one condition -> fine')
r = run({ code: { perform: `try {\n const { title } = context?.inputData\n const r = await axios.post('https://x.io', { title })\n if (!title) { throw new Error('x') }\n return r.data\n} catch (error) {\n await errorComponent(error)\n}` }, fields: [field('title', { required: true })] }); ok(r.findings.some((f) => /not validated/.test(f.detail)), 'a guard placed after the request does not count')
r = run({ code: { perform: GOOD.replace("if (!title) { throw new Error('Title is required.') }", "await assertRequired({ title })") }, fields: [field('title', { required: true })] }); ok(r.findings.length === 0, 'assertRequired({ title }) counts as a guard')
r = run({ code: { perform: GOOD.replace("if (!title)", "if (title === undefined || title === '')") }, fields: [field('title', { required: true })] }); ok(r.findings.length === 0, 'explicit undefined/empty comparison counts as a guard')
r = run({ code: { perform: GOOD.replace("  if (!title) { throw new Error('Title is required.') }\n", '') }, fields: [field('title', { required: true, visibilityCondition: "context?.inputData?.mode === 'x'" })] }); ok(r.findings.length === 0, 'a conditionally shown required field is not demanded')
r = run({ code: { perform: GOOD.replace("  if (!title) { throw new Error('Title is required.') }\n", '') }, fields: [field('title', { required: false })] }); ok(r.findings.length === 0, 'an optional field needs no guard')
r = run({ code: { perform: `try {\n const r = await axios.get('https://x.io' ,\n} catch (error) {\n await errorComponent(error)\n}` } }); ok(r.findings.length === 1 && r.findings[0].criterion === 'R4' && /does not parse/.test(r.findings[0].detail), 'code that does not parse -> one R4 finding')
r = run({ code: { perform: GOOD.replace('const { title } = context?.inputData', 'const { title, color } = context?.inputData') }, fields: [field('title', { required: true })] }); ok(r.findings.some((f) => /no field defines/.test(f.detail) && /color/.test(f.evidence)), 'reading an input no field defines -> R4')
r = run({ code: { perform: GOOD.replace("{ title })", "{ title, n: context?.inputData?.hookUrl })") }, fields: [field('title', { required: true })] }); ok(r.findings.length === 0, 'platform inputs such as hookUrl are known')
r = run({ code: { perform: GOOD.replace("{ title })", "{ title }, { headers: { Authorization: `Bearer ${context?.authData?.token}` } })") }, fields: [field('title', { required: true })] }); ok(r.findings.some((f) => f.criterion === 'R4' && /handles authentication/.test(f.detail)), 'building auth in code -> R4')
r = run({ code: { perform: GOOD.replace('context?.inputData', 'context.inputData') }, fields: [field('title', { required: true })] }); ok(ids(r) === 'I4', 'context.inputData without optional chaining -> I4 only (improve, not reject)')

// ---- URLs and comments must not confuse the checks
r = run({ code: { perform: GOOD.replace("const r = await axios.post('https://api.example.com/items', { title })", "const r = await axios.post('https://api.example.com/items', { title }) // the endpoint") }, fields: [field('title', { required: true })] }); ok(r.findings.length === 0, 'a URL and a trailing comment do not confuse the checks')


// ---- precision rules learned from real plugs
r = run({ type: 'trigger', name: 'Sample', code: { performlist: `return {\n  viasocket_help: 'sample',\n  id: 'a1'\n}` } }); ok(r.findings.length === 0, 'a block that only returns a constant sample is not asked for try/catch')
r = run({ code: { perform: GOOD.replace("'https://api.example.com/items'", "`https://api.example.com/${context?.authData?.account_sid}/items`") }, fields: [field('title', { required: true })] }); ok(r.findings.length === 0, 'authData inside a URL path is allowed (the platform fills it in)')
r = run({ code: { perform: GOOD.replace("{ title })", "{ title }, { headers: { Authorization: `Bearer ${context?.authData?.access_token}` } })") }, fields: [field('title', { required: true })] }); ok(r.findings.some((f) => f.criterion === 'R4' && /credentials/.test(f.evidence)), 'authData in an Authorization header is flagged')
r = run({ code: { perform: GOOD.replace("  if (!title) { throw new Error('Title is required.') }\n", '') }, fields: [field('title', { required: true, type: 'dropdown', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] })] }); ok(r.findings.length === 0, 'a required fixed-choice dropdown needs no code guard')
r = run({ code: { perform: GOOD.replace("  if (!title) { throw new Error('Title is required.') }\n", '') }, fields: [field('title', { required: true, type: 'dropdown', source: 'return []' })] }); ok(r.findings.some((f) => /not validated/.test(f.detail)), 'a required dynamic dropdown (an ID from the app) still needs a guard')

// ---- dynamic dropdown sources
const dyn = (source) => field('list', { type: 'dropdown', source, optionsGenerator: source })
const goodSrc = `try {\n  return await fetchLists()\n} catch (error) {\n  await errorComponent(error)\n}`
r = run({ code: { perform: GOOD }, fields: [field('title', { required: true }), dyn(goodSrc)], mapped: ['cERR', 'cLIST'] }); ok(r.findings.length === 0, 'a dropdown source with try/catch + errorComponent is fine')
r = run({ code: { perform: GOOD }, fields: [field('title', { required: true }), dyn(`return await fetchLists()`)], mapped: ['cERR', 'cLIST'] }); ok(ids(r) === 'R3,R4', 'a dropdown source without try/catch or errorComponent -> R3 and R4', ids(r))

// ---- triggers
const hook = { type: 'trigger', name: 'New Thing', code: { performsubscribe: GOOD.replace('title', 'x'), performunsubscribe: `try { await axios.delete('https://x.io/h') } catch (e) { throw e }`, modifytriggerdata: GOOD.replace('title', 'y') } }
r = run(hook); ok(r.findings.some((f) => f.criterion === 'R3' && /performunsubscribe/.test(f.evidence)), 'each trigger code block is checked (performunsubscribe flagged)')
ok(r.findings.every((f) => !/performsubscribe\b(?!un)/.test(f.evidence || '') || f.criterion !== 'R3'), 'the clean trigger blocks are not flagged')

// ---- converters
const bundle = { plug: { name: 'Draft' }, authType: 'Auth2.0', components: [ERR], operations: [op({ code: { perform: GOOD }, fields: [field('title', { required: true }), field('note', { label: '' })] })] }
const sc = schemaChecks(catalogShape(bundle)); ok(sc.findings.some((f) => f.criterion === 'I1'), 'catalogShape lets the schema checks run on a draft plug (missing label -> I1)')
const def = definitionFromBundle(bundle); ok(def.actions.length === 1 && def.actions[0].inputs.length === 2 && def.auth.type === 'Auth2.0', 'definitionFromBundle gives the review AI the draft plug', JSON.stringify(def.actions[0].inputs.map((i) => i.key)))

// ---- the Developer Hub module can only read
const src = readFileSync(new URL('../src/devhub.js', import.meta.url), 'utf8')
ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(src) && /method:\s*'GET'/.test(src), 'devhub.js only issues GET requests')
ok(!/\bbody:/.test(src), 'devhub.js never sends a request body')
const mod = await import('../src/devhub.js'); ok(!Object.keys(mod).some((k) => /^(create|update|delete|save|put|post|publish|merge|copy|write)/i.test(k)), 'devhub.js exports no write-sounding function', Object.keys(mod).join(', '))

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); process.exit(failed ? 1 : 0)
