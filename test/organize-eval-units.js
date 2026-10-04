// Organize quality gate and the progressive flow's order: the labelled sessions of test/fixtures/organize-eval.js must keep their
// scores (scripts/eval-organize.js prints them), and the local groups are on screen before the route to a model is worked out.
const run = require('./topics-sessions-run');
const { sessions } = require('./fixtures/organize-eval');
const tg = require('../src/browser/tab-groups');
const oai = require('../src/features/organize-ai');
const bench = require('./topics-bench');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -> ${detail}`}`); if (!ok) failed++; };

(async () => {
  let f1 = 0; let precision = 0; let wrong = 0;
  for (const s of sessions) {
    const r = run.runSession(tg, s, false);
    f1 += r.f1; precision += r.precision; wrong += r.wronglyGroupedLoose;
    check(`eval ${s.name}: precision ${r.precision.toFixed(2)} (a wrong group costs more than a loose tab)`, r.precision >= 0.99, `P ${r.precision} R ${r.recall}`);
    check(`eval ${s.name}: recall ${r.recall.toFixed(2)}`, r.recall >= 0.6, `R ${r.recall}`);
  }
  check('eval set: average F1 holds', f1 / sessions.length >= 0.88, String(f1 / sessions.length));
  check('eval set: no tab that should stay loose is grouped', wrong === 0, String(wrong));
  void precision;

  // Two stories from one news wire: the wire's name is no topic ("Reuters"), and an ordinary word three sites share makes a group.
  const wire = bench.harness(tg, { withText: false });
  for (const [title, url] of [['Fed holds rates - Reuters', 'https://www.reuters.com/a'], ['Fed decision and mortgage rates - CNBC', 'https://www.cnbc.com/b'], ['Inflation cools as Fed weighs a rate cut - Bloomberg', 'https://www.bloomberg.com/c'], ['Tsunami warning lifted after earthquake - Reuters', 'https://www.reuters.com/d'], ['Magnitude 7.1 earthquake off Japan - BBC News', 'https://www.bbc.com/e'], ['Earthquake: what we know so far - The Guardian', 'https://www.theguardian.com/f'], ['Weather - Boston', 'https://weather.com/g'], ['Spotify - Web Player', 'https://open.spotify.com/']]) wire.addTab({ title, url });
  wire.tg.groupLoose();
  const gid = (i) => wire.tabs()[i].groupId;
  check('news: the earthquake stories are one group, apart from the Fed ones', gid(3) && gid(3) === gid(4) && gid(4) === gid(5) && gid(0) !== gid(3), wire.tabs().map((t) => t.groupId).join());

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
