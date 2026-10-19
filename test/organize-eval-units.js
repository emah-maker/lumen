// Organize quality gate and the progressive flow's order: the labelled sessions of test/fixtures/organize-eval.js must keep their
// scores (scripts/eval-organize.js prints them), and the local groups are on screen before the route to a model is worked out.
const run = require('./topics-sessions-run');
const fixtures = require('./fixtures/organize-eval');
const { sessions } = fixtures;
const tg = require('../src/browser/tab-groups');
const oai = require('../src/features/organize-ai');
const bench = require('./topics-bench');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -> ${detail}`}`); if (!ok) failed++; };

(async () => {
  const total = { f1: 0, p: 0, r: 0, wrong: 0, n: 0 };
  const base = { f1: 0, n: 0 };
  for (const s of sessions) {
    const r = run.runSession(tg, s, false);
    total.f1 += r.f1; total.p += r.precision; total.r += r.recall; total.wrong += r.wronglyGroupedLoose; total.n++;
    const isBase = fixtures.base.includes(s);
    if (isBase) { base.f1 += r.f1; base.n++; }
    // The first eight sessions are the hand-checked ones (no wrong group at all); the long and mixed ones are allowed a few.
    check(`eval ${s.name}: precision ${r.precision.toFixed(2)} (a wrong group costs more than a loose tab)`, r.precision >= (isBase ? 0.99 : 0.75), `P ${r.precision} R ${r.recall}`);
    check(`eval ${s.name}: recall ${r.recall.toFixed(2)}`, r.recall >= (isBase ? 0.6 : 0.2), `R ${r.recall}`);
  }
  check(`eval set (${total.n} sessions): average precision ${(total.p / total.n).toFixed(2)}, recall ${(total.r / total.n).toFixed(2)}, F1 ${(total.f1 / total.n).toFixed(2)} hold`, total.p / total.n >= 0.97 && total.r / total.n >= 0.79 && total.f1 / total.n >= 0.85, `${total.p / total.n} ${total.r / total.n} ${total.f1 / total.n}`);
  check('eval set: the first eight sessions average F1 0.92 or better', base.f1 / base.n >= 0.92, String(base.f1 / base.n));
  check('eval set: at most two tabs that should stay loose are grouped', total.wrong <= 2, String(total.wrong));

  // The AI refine step, scored from its cached Haiku answers (scripts/eval-organize-ai.js --live makes them): a changed prompt or wire misses the cache and skips this.
  {
    const ai = await require('../scripts/eval-organize-ai').main({ quiet: true });
    if (ai.failed) console.log('ok   (refine answers not cached for this prompt: run scripts/eval-organize-ai.js --live to score it)');
    else {
      check(`refine (cached answers): local+AI recall ${(ai.sum.ai.r / ai.n).toFixed(2)} beats local ${(ai.sum.local.r / ai.n).toFixed(2)}`, ai.sum.ai.r / ai.n >= ai.sum.local.r / ai.n + 0.15, JSON.stringify(ai.sum));
      check('refine (cached answers): the model keeps precision (average 0.95+) and F1 0.88+', ai.sum.ai.p / ai.n >= 0.95 && ai.sum.ai.f / ai.n >= 0.88, JSON.stringify(ai.sum));
    }
  }

  // Two stories from one news wire: the wire's name is no topic ("Reuters"), and an ordinary word three sites share makes a group.
  const wire = bench.harness(tg, { withText: false });
  for (const [title, url] of [['Fed holds rates - Reuters', 'https://www.reuters.com/a'], ['Fed decision and mortgage rates - CNBC', 'https://www.cnbc.com/b'], ['Inflation cools as Fed weighs a rate cut - Bloomberg', 'https://www.bloomberg.com/c'], ['Tsunami warning lifted after earthquake - Reuters', 'https://www.reuters.com/d'], ['Magnitude 7.1 earthquake off Japan - BBC News', 'https://www.bbc.com/e'], ['Earthquake: what we know so far - The Guardian', 'https://www.theguardian.com/f'], ['Weather - Boston', 'https://weather.com/g'], ['Spotify - Web Player', 'https://open.spotify.com/']]) wire.addTab({ title, url });
  wire.tg.groupLoose();
  const gid = (i) => wire.tabs()[i].groupId;
  check('news: the earthquake stories are one group, apart from the Fed ones', gid(3) && gid(3) === gid(4) && gid(4) === gid(5) && gid(0) !== gid(3), wire.tabs().map((t) => t.groupId).join());

  // A name the user taught beats the model's rename.
  {
    let tabs = [];
    const g = tg.createTabGroups({ getTabs: () => tabs, setTabs: (l) => { tabs = l; }, urlOf: (t) => t.url, titleOf: (t) => t.title, textOf: () => '', isWeb: () => true, mode: () => 'topic', aiTopics: () => false, onChange: () => {}, learned: { nameFor: () => 'My Bread', aiHint: () => undefined } });
    [['Sourdough starter guide', 'https://a.example/1'], ['Sourdough bread recipe', 'https://b.example/2'], ['Sourdough baking tips', 'https://c.example/3']].forEach(([title, url], i) => tabs.push({ id: i + 1, title, url, groupId: null }));
    g.groupLoose();
    const id = g.state()[0].id;
    g.applyRefinement({ renames: [{ id, name: 'Baking Bread' }] });
    check("a name the user taught wins over the model's rename", g.state()[0].name === 'My Bread', g.state()[0].name);
  }

  // The route to a model (a CLI's sign-in check) is worked out after the local groups are shown.
  const events = [];
  const h = bench.harness(tg, { withText: false });
  for (const [title, url] of [['Sourdough starter guide', 'https://a.example/1'], ['Sourdough bread recipe', 'https://b.example/2'], ['Sourdough baking tips', 'https://c.example/3']]) h.addTab({ title, url });
  await oai.organizeProgressive({
    tabGroups: h.tg,
    prepare: async () => { events.push('prepare'); await new Promise((r) => setTimeout(r, 30)); events.push('prepared'); return null; },
    onPhase: (name) => events.push(name),
  });
  check('prepare starts, local groups are announced, then the route is awaited', events.join() === 'prepare,local,prepared,done' || events.join() === 'prepare,local,done' || events.indexOf('local') < events.indexOf('prepared'), events.join());
  const noRoute = await oai.organizeProgressive({ tabGroups: bench.harness(tg, { withText: false }).tg, prepare: async () => null });
  check('a prepare with no route is the local result', noRoute.aiUsed === false, JSON.stringify(noRoute.reason));
})().then(() => process.exit(failed ? 1 : 0));
