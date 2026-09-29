// Measures "Organize Tabs with AI" against a FAKE model with a configurable latency profile. No
// network, no tokens: the model is a function that waits (first-token delay + tokens/second) and
// answers from what the local organizer found. Reports, per session size, for the old way (the model
// places every tab) and the new way (local first, the model only refines): input tokens, output
// tokens, time to the first visible change and time to the final result.
//   node scripts/measure-organize.js [--ttft 1.2] [--tps 60] [--sizes 10,40,80,200] [--prefill 40]
const bench = require('../test/topics-bench');
const tg = require('../tab-groups');
const oai = require('../features/organize-ai');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const TTFT = Number(arg('ttft', 1.2)) * 1000; // ms until the first token
const TPS = Number(arg('tps', 60)); // output tokens per second
const PREFILL = Number(arg('prefill', 40)); // ms per 1000 input tokens
const SIZES = String(arg('sizes', '10,40,80,200')).split(',').map(Number);
const LEGACY_CAP = 80; // main.js used to send at most this many tabs
const LEGACY_PROMPT = 'Group these browser tabs by topic or task. Each tab has an id, title, host and path words; "group" is the name of the group it is in now. Where tabs already belong together in a group, reuse that exact group name for them. The tab marked "active" is what the user is doing right now: keep it with its related tabs. Make 2 to 8 groups of at least 2 tabs each. Name each group specifically in 1-3 words (Title Case), like "Flights to Tokyo" or "React docs", never just a website. A tab belongs to at most one group; leave out tabs that fit nowhere. Use only the ids given. Reply with JSON only: {"groups":[{"name":"...","tab_ids":[1,2]}]}.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

// ---------- a realistic session of n tabs: topics across sites, plus some noise ----------
const TOPICS = ['sourdough starter', 'kayak rental', 'tokyo itinerary', 'lisbon hotels', 'react query', 'noise cancelling headphones', 'standing desk', 'fed interest rates', 'rtx gpu benchmarks', 'marathon training plan', 'kombucha brewing', 'tax brackets', 'solar panels cost', 'python asyncio', 'rust ownership', 'espresso machines', 'piano chords', 'japanese grammar', 'hiking boots', 'mortgage refinance', 'electric cars', 'linear algebra', 'bird watching', 'watercolor painting'];
const SITES = [['Wikipedia', 'en.wikipedia.org/wiki'], ['Reddit', 'www.reddit.com/r/all/comments'], ['YouTube', 'www.youtube.com/watch'], ['Medium', 'medium.com/@writer'], ['Stack Overflow', 'stackoverflow.com/questions'], ['Wirecutter', 'www.nytimes.com/wirecutter/reviews'], ['Healthline', 'www.healthline.com/health'], ['The Verge', 'www.theverge.com/2026'], ['Forbes', 'www.forbes.com/advisor'], ['Investopedia', 'www.investopedia.com/terms']];
const TEMPLATES = [(t) => `${t} guide for beginners`, (t) => `Best ${t} of 2026`, (t) => `How ${t} works: what to know`, (t) => `${t}: tips and common mistakes`, (t) => `${t} explained`, (t) => `Is ${t} worth it? A review`];
const NOISE = [['Inbox (4) - you@example.com', 'https://mail.google.com/mail/u/0/#inbox'], ['Spotify - Web Player', 'https://open.spotify.com/'], ['Weather - Boston', 'https://weather.com/weather/today/l/boston'], ['Netflix', 'https://www.netflix.com/browse'], ['Sign in to your account', 'https://login.microsoftonline.com/common/oauth2/authorize'], ['Chase Online Banking', 'https://secure.chase.com/web/auth/dashboard'], ['Just a moment...', 'https://example.org/challenge']];
function session(n, seed = 7) {
  const r = rng(seed);
  const tabs = [];
  const topics = Math.max(2, Math.min(TOPICS.length, Math.round(n / 5)));
  for (let i = 0; i < n; i++) {
    if (r() < 0.12) { const [title, url] = NOISE[Math.floor(r() * NOISE.length)]; tabs.push({ title: `${title}`, url: `${url}${tabs.length % 3 ? `?${i}` : ''}`, text: '' }); continue; }
    const topic = TOPICS[Math.floor(r() * topics)];
    const [site, base] = SITES[Math.floor(r() * SITES.length)];
    const title = TEMPLATES[Math.floor(r() * TEMPLATES.length)](topic);
    tabs.push({ title: `${title} - ${site}`, url: `https://${base}/${topic.replace(/ /g, '-')}-${i}`, text: i % 2 ? `${title}. A practical overview of ${topic}.` : '' });
  }
  return tabs;
}

// ---------- the fake model ----------
function fakeModel() {
  const usage = { calls: 0, inTokens: 0, outTokens: 0 };
  // answer(): the JSON a decent model would return; its size sets how long it "generates".
  const call = async (inText, answer) => {
    const inTokens = oai.estimateTokens(inText);
    const out = JSON.stringify(answer());
    const outTokens = oai.estimateTokens(out);
    usage.calls++; usage.inTokens += inTokens; usage.outTokens += outTokens;
    await sleep(TTFT + (inTokens / 1000) * PREFILL + (outTokens / TPS) * 1000);
    return JSON.parse(out);
  };
  return { usage, call };
}

function freshHarness(tabsIn) {
  const h = bench.harness(tg, { withText: true });
  for (const t of tabsIn) h.addTab(t);
  return h;
}

// The old flow: ask the model to place every tab (capped at 80), apply once at the end.
async function measureOld(tabsIn) {
  const h = freshHarness(tabsIn);
  const model = fakeModel();
  const entries = h.tg.candidates().slice(0, LEGACY_CAP);
  const t0 = Date.now();
  const list = oai.legacyWire(entries);
  // What a good model answers: the groups the local organizer finds (names included).
  const oracle = tg.topicClusters(entries).map((c) => ({ name: c.name, tab_ids: c.ids }));
  const proposal = (await model.call(`${LEGACY_PROMPT}\n\nTabs:\n${JSON.stringify(list)}`, () => ({ groups: oracle }))).groups;
  h.tg.organizeByTopic(proposal);
  const total = Date.now() - t0;
  return { ...model.usage, firstMs: total, finalMs: total, groups: h.tg.state().length, model };
}

// The new flow. `cache` is shared across calls to show re-organizing.
async function measureNew(tabsIn, cache, { h = freshHarness(tabsIn) } = {}) {
  const model = fakeModel();
  const t0 = Date.now();
  let firstMs = null;
  // The fake model: names every group whose local name is vague, places each leftover in the group
  // sharing most words with its title, and leaves the rest.
  const ask = (wire) => model.call(`${oai.REFINE_PROMPT}\n${JSON.stringify(wire)}`, () => {
    const ans = { n: [], p: [], g: [], m: [] };
    for (const g of wire.g) if (g.x.split(' ').length > 2 || g.n >= 6) ans.n.push({ i: g.i, s: g.w.split(' ').slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || g.x });
    for (const [, tabs] of Object.entries(wire.u || {})) for (const [id, title] of tabs) {
      const words = String(title).toLowerCase().split(/\W+/);
      const hit = wire.g.map((g) => ({ g, n: g.w.split(' ').filter((w) => words.includes(w)).length })).sort((a, b) => b.n - a.n)[0];
      if (hit && hit.n >= 1) ans.p.push({ t: id, i: hit.g.i });
    }
    return ans;
  });
  const stats = await oai.organizeProgressive({
    tabGroups: h.tg, ask, cache,
    onPhase: (name) => { if (name === 'local' && firstMs == null) firstMs = Date.now() - t0; },
  });
  const total = Date.now() - t0;
  return { ...model.usage, firstMs, finalMs: total, groups: h.tg.state().length, stats, h };
}

const secs = (ms) => `${(ms / 1000).toFixed(2)}s`;
const row = (label, r) => `${label.padEnd(22)} in ${String(r.inTokens).padStart(5)} tok   out ${String(r.outTokens).padStart(4)} tok   first change ${secs(r.firstMs).padStart(6)}   final ${secs(r.finalMs).padStart(6)}   calls ${r.calls}   groups ${r.groups}`;

async function main() {
  console.log(`fake model: first token ${TTFT / 1000}s, ${TPS} tok/s, prefill ${PREFILL}ms per 1k input tokens\n`);
  const table = [];
  for (const n of SIZES) {
    const tabs = session(n);
    const old = await measureOld(tabs);
    const cache = oai.createRefineCache();
    const cold = await measureNew(tabs, cache);
    const warm = await measureNew(tabs, cache); // the same tabs again: answers come from the cache
    const more = await measureNew([...tabs, ...session(3, 99).map((t, i) => ({ ...t, title: `${t.title} extra ${i}` }))], cache); // 3 new tabs
    console.log(`--- ${n} tabs`);
    console.log(row('before (all tabs)', old));
    console.log(row('after, first time', cold));
    console.log(row('after, again', warm));
    console.log(row('after, +3 tabs', more));
    table.push({ n, old, cold, warm, more });
  }
  console.log('\n| tabs | before first/final | after first / final (first run) | after re-run | tokens in/out before -> after |');
  console.log('|---|---|---|---|---|');
  for (const { n, old, cold, warm } of table) console.log(`| ${n} | ${secs(old.firstMs)} / ${secs(old.finalMs)} | ${secs(cold.firstMs)} / ${secs(cold.finalMs)} | ${secs(warm.firstMs)} / ${secs(warm.finalMs)} | ${old.inTokens}/${old.outTokens} -> ${cold.inTokens}/${cold.outTokens} |`);
}

module.exports = { session, fakeModel, measureOld, measureNew };
if (require.main === module) main();
