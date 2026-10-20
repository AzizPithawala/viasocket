// Offline tests for finding API docs: domain trust, stored links, and the web-search path with stand-ins.
//   node scripts/docs-test.mjs
import { registrableDomain, checkDocUrl, storedDocLinks, pickStored, findDocs } from '../src/review/docs.js'

let failed = 0
const ok = (cond, name, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); if (!cond) failed++ }

ok(registrableDomain('developers.notion.com') === 'notion.com', 'a docs subdomain reduces to the provider domain')
ok(registrableDomain('www.twilio.com') === 'twilio.com', 'www is dropped')
ok(registrableDomain('docs.example.co.uk') === 'example.co.uk', 'two-level suffixes such as co.uk are handled')
ok(checkDocUrl('https://developers.notion.com/reference/post-page', 'notion.com').ok, 'docs on a provider subdomain are trusted')
ok(checkDocUrl('https://www.twilio.com/docs/messaging', 'twilio.com').ok, 'docs on the provider domain are trusted')
ok(!checkDocUrl('https://some-blog.example.org/notion-api-guide', 'notion.com').ok, 'a third-party page is not trusted', checkDocUrl('https://some-blog.example.org/x', 'notion.com').reason)
ok(!checkDocUrl('http://developers.notion.com/x', 'notion.com').ok, 'plain http is not trusted')
ok(!checkDocUrl('https://developers.notion.com/x', '').ok, 'no plug domain means nothing to compare against')
ok(!checkDocUrl('notaurl', 'notion.com').ok, 'garbage is rejected')

const plug = { name: 'Twilio', domain: 'twilio.com', metadata: JSON.stringify({ aiContext: { docs: ['https://www.twilio.com/docs/messaging/api/message-resource', 'https://www.twilio.com/docs/voice/api/call'], note: 'see https://viasocket.com/x' } }) }
const links = storedDocLinks(plug); ok(links.length === 2 && links.every((l) => !/viasocket/.test(l)), 'stored doc links are collected without viaSocket links', links.length + ' links')
ok(pickStored(links, { name: 'Send Message', description: 'Send an SMS' })?.url.endsWith('message-resource'), 'the stored link that matches the action name wins')
ok(pickStored(links, { name: 'Make Call', description: 'Place a call' })?.url.endsWith('/call'), 'a different action picks a different stored link')
ok(pickStored(links, { name: 'Do Something Else' }) === null, 'two stored links and no match: not guessed')
ok(pickStored(['https://x.io/docs'], { name: 'Anything' })?.confidence === 'medium', 'a single stored link is used with medium confidence')

const never = async () => { throw new Error('the AI must not be asked when a stored link matches') }
let r = await findDocs({ plug, operation: { name: 'Send Message', description: 'x' }, askJson: never }); ok(r.source === 'developer hub' && r.confidence === 'high', 'a matching stored link is used without any web search')

const bare = { name: 'Notion', domain: 'notion.com', metadata: {} }
const ask = (out) => async () => out
r = await findDocs({ plug: bare, operation: { name: 'Create Page' }, askJson: ask({ url: 'https://developers.notion.com/reference/post-page', confidence: 'high', reason: 'endpoint page' }), reachable: async () => true }); ok(r.source === 'web search' && r.confidence === 'high', 'web search on the provider domain, reachable -> high', r.note)
r = await findDocs({ plug: bare, operation: { name: 'Create Page' }, askJson: ask({ url: 'https://random-blog.dev/notion-api', confidence: 'high' }), reachable: async () => true }); ok(r.confidence === 'low' && /not trusted/.test(r.note), 'a third-party page is low confidence however sure the AI is', r.note)
r = await findDocs({ plug: bare, operation: { name: 'Create Page' }, askJson: ask({ url: 'https://developers.notion.com/reference/post-page', confidence: 'high' }), reachable: async () => false }); ok(r.confidence === 'low' && /did not answer/.test(r.note), 'a page that does not answer is low confidence')
r = await findDocs({ plug: bare, operation: { name: 'Create Page' }, askJson: ask({ url: 'https://developers.notion.com/reference/post-page', confidence: 'low' }), reachable: async () => true }); ok(r.confidence === 'low', 'when the AI itself is unsure the result stays low')
r = await findDocs({ plug: bare, operation: { name: 'Create Page' }, askJson: ask({ url: '', confidence: 'low' }) }); ok(r.url === null && /no official/.test(r.note), 'nothing found is reported plainly')
r = await findDocs({ plug: bare, operation: { name: 'Create Page' }, askJson: async () => { throw new Error('offline') } }); ok(r.url === null && /failed/.test(r.note), 'a failed search never throws into the review')
r = await findDocs({ plug: { name: 'X', domain: '', metadata: {} }, operation: { name: 'Y' }, askJson: never }); ok(r.url === null && /no website/.test(r.note), 'a plug without a website is not searched for at all')

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED'); process.exit(failed ? 1 : 0)
