// What Lumen's MCP tools cost an outside agent in tokens (plain Node: no Electron, no network). The numbers for typical outputs on real
// pages come from scripts/mcp-token-report.js; this suite holds the shapes that keep them small:
//   - tools/list stays within its budget (the list is paid for in every session)
//   - list_tabs rows carry only what is set, with a title and address cut to size
//   - what follows navigate does not repeat the title and address navigate's own line already gave
//   - a long since_last diff lists its first lines and counts the rest
const { EXTERNAL_TOOLS, slimTabRow } = require('../src/ai/agent');
const mcp = require('../src/automation/mcp');
const snap = require('../src/ai/snapshot');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const tokens = (chars) => Math.ceil(chars / 4);

(async () => {
  // tools/list, exactly as the server answers it.
  const sent = [];
  const session = mcp.createSession({ tools: EXTERNAL_TOOLS, callTool() {}, enabled: () => true, onEvent() {}, send: (o) => sent.push(o) });
  await session.handle({ id: 1, method: 'tools/list' });
  const listed = sent[0].result.tools;
  const listTokens = tokens(JSON.stringify(sent[0].result).length);
  console.log(`tools/list: ${listed.length} tools, ${listTokens} tokens`);
  check('tools/list stays within 3,160 tokens (3,140 before the compaction; +20 for open_tab / switch_tab keep, the tabs the AI leaves open when it finishes; adding a tool means trimming another)', listTokens <= 3160, String(listTokens));
  check('no tool description is over 330 characters', listed.every((t) => t.description.length <= 330), listed.filter((t) => t.description.length > 330).map((t) => t.name).join());
  check('every tool still has a description and an object schema', listed.every((t) => t.description && t.inputSchema?.type === 'object'), '');

  // list_tabs rows.
  const full = { id: 7, title: 'T'.repeat(200), url: `https://example.com/${'p'.repeat(300)}`, active: false, group: null };
  const row = slimTabRow(full);
  check('list_tabs row: no "active":false and no "group":null', !('active' in row) && !('group' in row), JSON.stringify(row));
  check('list_tabs row: title cut to 60 and address to 120 characters', row.title.length === 60 && row.url.length === 120 && row.title.endsWith('…'), JSON.stringify(row));
  const shown = slimTabRow({ id: 1, title: 'A', url: 'https://a.test/', active: true, group: 'Research', in_front: true, off_limits: 'read-only' });
  check('list_tabs row: active, group, in_front and off_limits kept when set', shown.active === true && shown.group === 'Research' && shown.in_front === true && shown.off_limits === 'read-only', JSON.stringify(shown));
  check('list_tabs row: an AI-off tab is its id (and the flag) only', JSON.stringify(slimTabRow({ id: 4, active: false, ai_off: true })) === '{"id":4,"ai_off":true}', JSON.stringify(slimTabRow({ id: 4, active: false, ai_off: true })));
  check('list_tabs row: a blank new tab keeps url ""', slimTabRow({ id: 5, url: '', active: false }).url === '', JSON.stringify(slimTabRow({ id: 5, url: '', active: false })));
  const twenty = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: `Page ${i} of the example site`, url: `https://example.com/section/${i}`, active: i === 0, group: null }));
  const before = JSON.stringify(twenty).length;
  const after = JSON.stringify(twenty.map(slimTabRow)).length;
  check('list_tabs with 20 tabs is at least 15% smaller', after <= before * 0.85, `${after} vs ${before}`);

  // The page-side outline is stubbed: what runScript returns is what the page would have walked.
  let lines = ['Shop (https://a.test/)', '# Checkout', '[1] button "Add"'];
  const wc = { id: 951, isDestroyed: () => false, getURL: () => 'https://a.test/', getTitle: () => 'Shop' };
  const agent = { requireTab: () => wc, browser: { aiOff: () => false } };
  const h = { scripts: { readPage: () => '' }, dedupe: () => false, runScript: async () => ({ lines: [...lines], totalLines: lines.length, elements: 1, startLine: 0, clipped: false }) };
  const withTitle = await snap.head(agent, wc, h);
  const noTitle = await snap.head(agent, wc, h, { noTitle: true });
  check('head: by default the first line is the title and address', withTitle.includes('Shop (https://a.test/)') && withTitle.includes('# Checkout'), withTitle);
  check('head after navigate: no second copy of the title and address, the rest is kept', !noTitle.includes('Shop (https://a.test/)') && noTitle.includes('# Checkout') && noTitle.includes('[1] button "Add"'), noTitle);
  const outlineNo = await snap.outline(agent, wc, h, { noTitle: true });
  check('outline after navigate read:true: same, without the title line', !outlineNo.includes('Shop (https://a.test/)') && outlineNo.includes('# Checkout'), outlineNo);
  // The title line stays in the baseline the next since_last compares with (a noTitle read does not change what was read).
  const diff = await snap.execute(agent, 'read_page', { mode: 'compact', since_last: true }, h);
  check('since_last after a noTitle read compares against the whole page', /No changes since your last read/.test(diff), diff);

  // A long diff.
  const base = ['Shop (https://a.test/)', ...Array.from({ length: 5 }, (_, i) => `row ${i}`)];
  const wc2 = { id: 952, isDestroyed: () => false, getURL: () => 'https://a.test/' };
  const agent2 = { requireTab: () => wc2, browser: { aiOff: () => false } };
  lines = base;
  await snap.execute(agent2, 'read_page', { mode: 'compact' }, h);
  lines = [...base, ...Array.from({ length: 60 }, (_, i) => `new line ${i}`)];
  const big = await snap.execute(agent2, 'read_page', { mode: 'compact', since_last: true }, h);
  check('since_last: a long diff lists 25 lines and counts the rest', /\(\+60 \/ -0 lines\)/.test(big) && (big.match(/new line \d+/g) || []).length === 25 && /… 35 more added lines/.test(big), big);
  lines = [...base, 'new line a', 'new line b'];
  await snap.execute(agent2, 'read_page', { mode: 'compact' }, h);
  lines = [...base, 'new line a', 'new line b', 'new line c'];
  const small = await snap.execute(agent2, 'read_page', { mode: 'compact', since_last: true }, h);
  check('since_last: a short diff is listed whole', /\(\+1 \/ -0 lines\)/.test(small) && small.includes('new line c') && !/more added lines/.test(small), small);

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
