// [agent cursors] features/agent-tags.js: which helper or sub-agent made a browser tool call (its cursor color and name on the page),
// and page-scripts.js agentCursor / readPage's stable ids as scripts (their page behavior: test/e2e/agent-cursors.js).
const T = require('../../src/features/agent-tags');
const scripts = require('../../src/ai/page-scripts');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

(async () => {
  let t = 1000;
  const tags = T.createTags({ now: () => t });
  tags.note('mcp__lumen__click', { element_id: 4, text: 'Save' }, 'cc:toolu_A');
  tags.note('type_text', { element_id: 9, text: 'hi' }, 'cx:thread-B');
  check('a call nobody noted is the lead agent\'s: no tag', tags.take('click', { element_id: 5 }) === null);
  const b = tags.take('type_text', { text: 'hi', element_id: 9 });
  check('matched by tool name and arguments, whatever the key order', b && b.key === 'cx:thread-B', JSON.stringify(b));
  const a = tags.take('click', { text: 'Save', element_id: 4 });
  check('the mcp__lumen__ prefix of the stream\'s name is ignored', a && a.key === 'cc:toolu_A', JSON.stringify(a));
  check('each agent gets its own number, label and color', b.n === 1 && a.n === 2 && b.label === 'Helper 1' && a.label === 'Helper 2' && a.color !== b.color, JSON.stringify([a, b]));
  check('a match is used once', tags.take('click', { text: 'Save', element_id: 4 }) === null);
  tags.note('click', { element_id: 7 }, 'cc:toolu_A');
  check('the same agent keeps its number', tags.take('click', { element_id: 7 })?.n === 2);
  tags.note('click', { element_id: 8 }, 'cc:toolu_C');
  t += 30000;
  check('a noted call that never arrived is dropped after a while', tags.take('click', { element_id: 8 }) === null && tags.size() === 0);
  tags.note('click', { element_id: 1 }, null);
  check('a call with no agent is not noted', tags.size() === 0);

  check('colors: six, all different, hex', T.COLORS.length === 6 && new Set(T.COLORS).size === 6 && T.COLORS.every((c) => /^#[0-9a-f]{6}$/i.test(c)));
  check('the seventh agent wraps to the first color', T.colorOf(7) === T.colorOf(1));

  // run / current: a call made inside run(tag) is that agent's, across awaits; outside it is nobody's
  const tag = T.tagOf('h:1', 3);
  const seen = await T.run(tag, async () => { await new Promise((r) => setTimeout(r, 5)); return T.current(); });
  check('run carries the tag across awaits', seen && seen.key === 'h:1' && seen.label === 'Helper 3');
  check('outside run there is no tag', T.current() === null);
  check('run(null) just calls fn', T.run(null, () => 42) === 42);

  // the scripts parse, and what goes into them is escaped
  const evil = { key: '"); alert(1); ("', label: '</style><script>x</script>', color: 'red;background:url(x)' };
  let ok = true;
  try { new Function(scripts.agentCursor(3, evil)); new Function(scripts.readPage(0, 0)); new Function(scripts.readPage(0, 0, { list: false, frames: false })); } catch (e) { ok = false; }
  check('agentCursor and readPage give valid scripts, whatever the tag says', ok);
  const src = scripts.agentCursor(3, evil);
  check('a color that is not #rrggbb falls back to the default', !src.includes('url(x)') && src.includes('#ff375f'));
  check('readPage keeps the ids of a page read before (stable ids)', /const kept = window\.__claudeEls;/.test(scripts.readPage(0, 0)) && /gone: true/.test(scripts.readPage(0, 0)));

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
