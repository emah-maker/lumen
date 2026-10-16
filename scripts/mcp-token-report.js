// What an MCP client pays in tokens for Lumen's tools. Tokens are approximated as chars / 4, plus ~ (width x height) / 750 for an image.
//
//   node scripts/mcp-token-report.js --static            the tools/list payload only (plain Node, no Electron)
//   node scripts/mcp-token-report.js --json out.json     everything: tools/list, then typical outputs on local fixture pages
//   node scripts/mcp-token-report.js --compare a.json b.json   before / after table
//   --root <dir>  measure another checkout of Lumen (a "before" run on origin/main)
//
// The full run starts Lumen hidden on a throwaway profile (LUMEN_TEST_BACKGROUND, CLAUDE_BROWSER_TEST) and speaks MCP to it through the
// real bridge, over fixture pages served from 127.0.0.1. No network. Run it under the Electron lock:
//   node scripts/e2e-lock.js run --owner mcp-tokens -- timeout 600 node scripts/mcp-token-report.js --json after.json
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const root = path.resolve(opt('--root') || path.join(__dirname, '..'));
const tokens = (chars) => Math.ceil(chars / 4);
const imageTokens = (w, h) => Math.ceil((w * h) / 750);

// ---------------------------------------------------------------- compare
if (args.includes('--compare')) {
  const i = args.indexOf('--compare');
  const [a, b] = [args[i + 1], args[i + 2]].map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const names = [...new Set([...Object.keys(a.items), ...Object.keys(b.items)])];
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('item', 46)}${pad('before', 9)}${pad('after', 9)}change`);
  let ta = 0; let tb = 0;
  for (const n of names) {
    const x = a.items[n]?.tokens ?? 0; const y = b.items[n]?.tokens ?? 0;
    ta += x; tb += y;
    console.log(`${pad(n, 46)}${pad(x, 9)}${pad(y, 9)}${x ? `${Math.round(((y - x) / x) * 100)}%` : ''}`);
  }
  console.log(`${pad('TOTAL', 46)}${pad(ta, 9)}${pad(tb, 9)}${ta ? `${Math.round(((tb - ta) / ta) * 100)}%` : ''}`);
  process.exit(0);
}

// ---------------------------------------------------------------- (a) tools/list, plain Node
async function staticReport() {
  const { EXTERNAL_TOOLS } = require(path.join(root, 'src', 'ai', 'agent'));
  const mcp = require(path.join(root, 'src', 'automation', 'mcp'));
  const sent = [];
  const session = mcp.createSession({ tools: EXTERNAL_TOOLS, callTool() {}, enabled: () => true, onEvent() {}, send: (o) => sent.push(o) });
  await session.handle({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } });
  await session.handle({ id: 2, method: 'tools/list' });
  const init = JSON.stringify(sent[0].result);
  const list = sent[1].result.tools;
  const per = list.map((t) => ({ name: t.name, description: t.description.length, schema: JSON.stringify(t.inputSchema).length, tokens: tokens(JSON.stringify(t).length) })).sort((x, y) => y.tokens - x.tokens);
  return { init, listChars: JSON.stringify(sent[1].result).length, count: list.length, per };
}

// ---------------------------------------------------------------- fixtures
const links = (n, prefix) => Array.from({ length: n }, (_, i) => `<a href="/${prefix}${i}">${prefix} link number ${i} with a longer label</a>`).join(' ');
const para = (i) => `<p>Paragraph ${i}. ${'The quick brown fox jumps over the lazy dog while the committee reviews the long running proposal. '.repeat(3)}<a href="/ref${i}">Reference ${i}</a> and <a href="/more${i}">more reading ${i}</a>.</p>`;
const PAGES = {
  '/article': `<!doctype html><title>Long article</title><body>
<div role="dialog" aria-label="Cookie consent"><p>We use cookies to improve your experience. By continuing you agree to our use of cookies.</p><button>Accept all</button><button>Reject all</button><button>Manage preferences</button></div>
<header><nav aria-label="Main">${links(25, 'nav')}</nav></header>
<main><article><h1>An article about foxes</h1>${Array.from({ length: 40 }, (_, i) => (i % 8 === 0 ? `<h2>Section ${i / 8 + 1}</h2>` : '') + para(i)).join('')}
<table><tr><th>Name</th><th>Value</th></tr>${Array.from({ length: 12 }, (_, i) => `<tr><td>Row ${i}</td><td>${i * 7}</td></tr>`).join('')}</table></article>
<aside><h2>Related</h2><ul>${Array.from({ length: 25 }, (_, i) => `<li><a href="/rel${i}">Related story ${i}: foxes and other animals</a></li>`).join('')}</ul></aside></main>
<footer><nav aria-label="Footer">${links(45, 'foot')}</nav><p>Copyright 2026 Example Corp. All rights reserved. Privacy policy. Terms of use.</p></footer></body>`,
  '/app': `<!doctype html><title>Dashboard</title><body>
<div role="toolbar">${Array.from({ length: 24 }, (_, i) => `<button aria-label="Tool ${i}">T${i}</button>`).join('')}</div>
<nav aria-label="Sidebar"><ul>${Array.from({ length: 18 }, (_, i) => `<li><a href="#s${i}">Section ${i}</a></li>`).join('')}</ul></nav>
<main><h1>Orders</h1><input aria-label="Search orders" placeholder="Search orders"><select aria-label="Status"><option>All</option><option>Open</option><option>Closed</option></select>
<table>${Array.from({ length: 40 }, (_, i) => `<tr><td>#${1000 + i}</td><td>Customer ${i}</td><td>${(i * 13.7).toFixed(2)} USD</td><td><button>View</button> <button>Refund</button> <input type="checkbox" aria-label="Select ${i}"></td></tr>`).join('')}</table>
<button id="add" onclick="document.getElementById('log').insertAdjacentHTML('beforeend','<p>Added order</p>')">Add order</button><div id="log"></div></main></body>`,
  '/form': `<!doctype html><title>Sign up</title><body><main><h1>Create your account</h1><form onsubmit="event.preventDefault();document.getElementById('out').textContent='submitted'">
${['First name', 'Last name', 'Email', 'Phone', 'Street', 'City', 'Postal code'].map((l) => `<label>${l} <input aria-label="${l}"></label>`).join('')}
<label>Country <select aria-label="Country"><option>Canada</option><option>France</option><option>Japan</option></select></label>
<label><input type="checkbox" aria-label="Subscribe"> Subscribe to the newsletter</label><label><input type="checkbox" aria-label="Terms"> I accept the terms</label>
<button>Create account</button></form><p id="out"></p></main></body>`,
};
const tabPage = (i) => `<!doctype html><title>Tab ${i}: an example page title that is fairly long</title><body><h1>Tab ${i}</h1><p>Body text of tab ${i}. ${'Some words. '.repeat(40)}</p></body>`;

// ---------------------------------------------------------------- (b) typical outputs, through the real bridge
async function liveReport(out) {
  const { _electron: electron } = require(path.join(root, 'node_modules', 'playwright-core'));
  const { spawn } = require('child_process');
  const electronBin = require(path.join(root, 'node_modules', 'electron'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mcptok-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', LUMEN_AGENT_WINDOW_GRACE_MS: '1500' };
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    res.setHeader('Content-Type', 'text/html');
    const tab = /^\/tab\/(\d+)$/.exec(url);
    res.end(tab ? tabPage(Number(tab[1])) : PAGES[url] || '<!doctype html><title>Not found</title><p>none</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const app = await electron.launch({ args: [root], env });
  let bridge;
  const done = async (code) => { try { bridge?.kill(); } catch {} try { await app.close(); } catch {} server.close(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} return code; };
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => globalThis.assistant.setMcpEnabled(true));
    bridge = spawn(electronBin, [path.join(root, 'mcp.js')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const waiting = new Map();
    bridge.stdout.setEncoding('utf8');
    bridge.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        waiting.get(msg.id)?.(msg); waiting.delete(msg.id);
      }
    });
    let nextId = 1;
    const request = (method, params, ms = 60000) => new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, resolve);
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => reject(new Error(`timeout: ${method}`)), ms);
    });
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '1.0' } });
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    // One call -> { chars, tokens, imageBytes? }. The wire cost is what the client puts in its context: the text blocks, and an image by size.
    const measure = (label, r) => {
      const content = r.result?.content || [];
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const img = content.find((c) => c.type === 'image');
      let t = tokens(text.length);
      const item = { chars: text.length, isError: Boolean(r.result?.isError || r.error) };
      if (img) {
        const m = /(\d+)x(\d+) px/.exec(text);
        item.imageBytes = Buffer.byteLength(img.data, 'base64');
        item.image = m ? `${m[1]}x${m[2]}` : '?';
        t += m ? imageTokens(Number(m[1]), Number(m[2])) : Math.ceil(img.data.length / 1500);
      }
      item.tokens = t;
      item.sample = text.slice(0, 160).replace(/\s+/g, ' ');
      out[label] = item;
      return text;
    };
    const call = async (label, name, a = {}) => measure(label, await request('tools/call', { name, arguments: a }));
    const quiet = (name, a = {}) => request('tools/call', { name, arguments: a }); // a setup call that is not measured
    const textOf = (r) => (r.result?.content || []).map((c) => c.text || '').join('\n');
    const ref = (text, re) => Number((re.exec(text) || [])[1]);

    // The tools/list answer as the client sees it, and the initialize reply.
    const listed = await request('tools/list', {});
    out['tools/list'] = { chars: JSON.stringify(listed.result).length, tokens: tokens(JSON.stringify(listed.result).length), count: listed.result.tools.length };

    // Pages: long article, dense app, form.
    await quiet('navigate', { url: `${base}/article`, read: false });
    await call('read_page article (default)', 'read_page');
    await call('read_page article compact since_last (unchanged)', 'read_page', { mode: 'compact', since_last: true });
    await call('read_page article outline', 'read_page', { mode: 'outline' });
    await call('read_page article full', 'read_page', { mode: 'full' });
    await call('read_page article full elements', 'read_page', { mode: 'full', elements: true });
    await call('read_page article extract links', 'read_page', { extract: 'links' });
    await call('read_page article extract tables', 'read_page', { extract: 'tables' });
    await call('find article', 'find', { query: 'privacy' });
    await call('find article (common word)', 'find', { query: 'paragraph' });
    await call('screenshot article (default)', 'screenshot');
    await call('scroll article', 'scroll', { direction: 'down' });

    await quiet('navigate', { url: `${base}/app`, read: false });
    await call('read_page app (default)', 'read_page');
    await call('read_page app full', 'read_page', { mode: 'full' });
    await call('find app', 'find', { query: 'refund' });
    const app1 = textOf(await quiet('read_page', { mode: 'compact' }));
    await call('click app (plain)', 'click', { element_id: ref(app1, /\[(\d+)\] button "Add order"/) });
    await call('read_page app since_last after click', 'read_page', { mode: 'compact', since_last: true });
    await call('click app observe:true', 'click', { text: 'Add order', observe: true });

    await call('navigate form (head)', 'navigate', { url: `${base}/form` });
    const form = await call('read_page form (default)', 'read_page');
    const r = (re) => ref(form, re);
    await call('type_text form', 'type_text', { element_id: r(/\[(\d+)\] textbox "First name"/), text: 'Ada' });
    await call('type_text form observe:true', 'type_text', { element_id: r(/\[(\d+)\] textbox "Last name"/), text: 'Lovelace', observe: true });
    await call('fill_form', 'fill_form', { fields: [{ label: 'Email', value: 'ada@example.com' }, { label: 'City', value: 'London' }, { label: 'Subscribe', value: 'true' }] });
    await call('batch form (4 steps + diff)', 'batch', { steps: [
      { do: 'type', ref: r(/\[(\d+)\] textbox "Phone"/), text: '555' },
      { do: 'select', ref: r(/\[(\d+)\] select "Country"/), text: 'France' },
      { do: 'click', ref: r(/\[(\d+)\] checkbox "Terms"/) },
      { do: 'click', text: 'Create account' },
    ] });
    await call('read_page form since_last after batch', 'read_page', { mode: 'compact', since_last: true });
    await call('navigate (read:true)', 'navigate', { url: `${base}/article`, read: true });

    // Tabs: 20 of them.
    for (let i = 0; i < 20; i++) await quiet('open_tab', { url: `${base}/tab/${i}`, read: false });
    const tabsText = await call('list_tabs (24 tabs)', 'list_tabs');
    let ids = [];
    try { ids = JSON.parse(tabsText).map((t) => t.id); } catch { ids = [...tabsText.matchAll(/\bid\W+(\d+)/g)].map((m) => Number(m[1])); }
    await call('read_tabs (3 tabs)', 'read_tabs', { ids: ids.slice(-3) });
    await call('switch_tab', 'switch_tab', { tab_id: ids[ids.length - 1] });
    await call('wait_for', 'wait_for', { text: 'Tab 19', seconds: 3 });
    await call('hover', 'hover', { element_id: 1 });
    await call('press_key', 'press_key', { key: 'End' });
    await call('go_back', 'go_back');
    return done(0);
  } catch (err) {
    console.error(err);
    return done(1);
  }
}

(async () => {
  const stat = await staticReport();
  console.log(`tools/list: ${stat.count} tools, ${stat.listChars} chars = ${tokens(stat.listChars)} tokens (initialize reply ${tokens(stat.init.length)} tokens)`);
  console.log('biggest tools (tokens): ' + stat.per.slice(0, 8).map((t) => `${t.name} ${t.tokens}`).join(', '));
  if (args.includes('--static')) {
    if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ root, items: { 'tools/list': { tokens: tokens(stat.listChars) }, 'initialize reply': { tokens: tokens(stat.init.length) } } }, null, 2));
    return;
  }
  const items = { 'initialize reply': { chars: stat.init.length, tokens: tokens(stat.init.length) } };
  const code = await liveReport(items);
  if (code) process.exit(code);
  const rows = Object.entries(items).sort((a, b) => b[1].tokens - a[1].tokens);
  const total = rows.reduce((s, [, v]) => s + v.tokens, 0);
  console.log('\nitem'.padEnd(48) + 'tokens   chars    note');
  for (const [name, v] of rows) console.log(`${name.padEnd(47)} ${String(v.tokens).padEnd(8)} ${String(v.chars ?? '').padEnd(8)} ${v.image ? `image ${v.image} (${v.imageBytes} bytes)` : v.isError ? `ERROR ${v.sample}` : ''}`);
  console.log(`\nTOTAL ${total} tokens`);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ root, total, items }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
