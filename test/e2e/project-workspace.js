// [project workspace] In a real (invisible) window with a fake model, synthetic files and a local fixture server (nothing real is read or visited):
//  - create a project, add files (text, Word, PDF) and pinned pages from its page's API, set its defaults;
//  - a chat started in the project carries the instructions and the file index in its context and is offered project_files, which finds and reads a file;
//    a chat outside any project gets neither; a Lumen-owned CLI run gets the tool too, an outside MCP client never does;
//  - the name chip in the header, "Add this tab to the project" (tab menu and the + menu), the project's page (files, pages, defaults, search);
//  - memory saved in a project chat belongs to the project: its chats see it, other chats do not; it shows on the project's page;
//  - the project's connector and MCP switches; a project's plan default and defaults;
//  - delete with Undo (the files and memory come back), and the files are erased once the Undo time is over.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { makeDocx } = require('../fixtures/docx-fixture');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

function makePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Fixture ${req.url.slice(1)}</title><body><p>fixture ${req.url}</p></body>`); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-e2e-profile-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('aiMemory', true); });
    // The fake model records every request; project_files / memory are called when the message asks (the words below).
    await app.evaluate(() => {
      const fake = global.__fake = { requests: [], toolResults: [] };
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const last = params.messages[params.messages.length - 1];
        const blocks = Array.isArray(last?.content) ? last.content : [];
        const result = blocks.find((b) => b.type === 'tool_result');
        const typed = JSON.stringify(last?.content || '');
        fake.requests.push({ system: (params.system || []).map((s) => s.text).join('\n'), tools: (params.tools || []).map((t) => t.name), typed: typed.slice(0, 200) });
        let content; let stop = 'end_turn';
        if (result) { fake.toolResults.push(typeof result.content === 'string' ? result.content : JSON.stringify(result.content)); content = [{ type: 'text', text: 'Done.' }]; }
        else if (/ASKFILES/.test(typed)) { content = [{ type: 'tool_use', id: 'toolu_pf1', name: 'project_files', input: { action: 'search', query: 'budget dollars' } }]; stop = 'tool_use'; }
        else if (/READPDF/.test(typed)) { content = [{ type: 'tool_use', id: 'toolu_pf2', name: 'project_files', input: { action: 'read', name: 'bio.pdf' } }]; stop = 'tool_use'; }
        else if (/REMEMBER/.test(typed)) { content = [{ type: 'tool_use', id: 'toolu_mem1', name: 'memory', input: { action: 'add', text: 'The project code word is kiwi.', kind: 'note' } }]; stop = 'tool_use'; }
        else content = [{ type: 'text', text: 'Plain reply.' }];
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: stop, content, usage: { input_tokens: 10, output_tokens: 5 } };
        return { async *[Symbol.asyncIterator]() { if (content[0].type === 'text') yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content[0].text } }; }, finalMessage: async () => message };
      } } } });
    });
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const inPage = (code) => app.evaluate(async (_e, c) => {
      const t = global.__chatPage.tabs().find((x) => x.chat);
      if (!t) return null;
      try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
    }, code);
    await waitFor(async () => (await inPage('document.readyState')) === 'complete' && (await inPage("document.body.classList.contains('cp-booting')")) === false, 20000);
    const api = (call, ...args) => inPage(`window.assistant.chats.${call}(...${JSON.stringify(args)})`);
    const send = (text) => inPage(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
    const live = () => app.evaluate(() => global.__tabChats.runs().filter((r) => r.live).length);
    const settled = async () => { await waitFor(async () => (await live()) === 0, 15000); await sleep(300); };
    const fake = () => app.evaluate(() => global.__fake);
    const lastRequest = async () => { const f = await fake(); return f.requests[f.requests.length - 1]; };
    // "New chat here" in the rail, as a user does it
    const startIn = (pid) => inPage(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const find = () => [...document.querySelectorAll('.cp-pj-act')].find((b) => /New chat here/.test(b.textContent));
      if (!find()) { document.querySelector('.cp-pj[data-id="${pid}"]').click(); await wait(600); }
      find().click();
      await wait(900);
      return true;
    })()`);
    const bytesOf =(buf) => `Uint8Array.from(atob(${JSON.stringify(buf.toString('base64'))}), (c) => c.charCodeAt(0)).buffer`;

    // ======== create a project and add files ========
    const project = await api('saveProject', { name: 'Biology thesis', instructions: 'Answer in a formal tone.', folderMode: 'none' });
    check('create: a project with instructions', project?.id && project.instructions === 'Answer in a formal tone.', JSON.stringify(project));
    const add = await inPage(`window.assistant.chats.projectFilesAdd(${JSON.stringify(project.id)}, [
      { name: 'budget.md', bytes: new TextEncoder().encode('# Budget\\n\\n' + 'Filler words keep the index summary short of the figures. '.repeat(2) + '\\n\\nThe budget for the thesis is 4,000 dollars.\\n\\nThe deadline is in March.').buffer },
      { name: 'essay.docx', bytes: ${bytesOf(makeDocx(['Essay', 'Chloroplasts make sugar from light.']))} },
      { name: 'bio.pdf', bytes: ${bytesOf(makePdf(['Mitochondria make energy for the cell']))} },
      { name: 'run.exe', bytes: new TextEncoder().encode('MZ').buffer },
    ])`);
    check('add files: text, Word and PDF are read; an unknown type says why', add?.results?.filter((r) => r.ok).length === 3 && /can't read this kind/.test(add.results.find((r) => !r.ok)?.error || '') && add.files.length === 3, JSON.stringify(add));
    const got = await api('project', project.id);
    check('the page data: files with summaries, limits, no folder needed', got.files.length === 3 && got.files.some((f) => f.name === 'budget.md' && /Budget/.test(f.summary)) && got.limits.files === 40 && got.keychain === true, JSON.stringify(got.files.map((f) => [f.name, f.summary])));
    const link = await api('projectLink', project.id, { add: { url: `${base}/reference`, title: 'Reference page' } });
    const bad = await api('projectLink', project.id, { add: { url: 'javascript:alert(1)', title: 'x' } });
    check('pinned pages: a web page is kept; a javascript: address is refused', link?.links?.length === 1 && link.links[0].url === `${base}/reference` && bad?.error === 'invalid', JSON.stringify([link?.links, bad]));
    const found = await api('projectSearch', project.id, 'budget thesis dollars');
    check('search in the project\'s files', found.length === 1 && found[0].file === 'budget.md' && /4,000 dollars/.test(found[0].snippet), JSON.stringify(found));

    // ======== a chat in the project ========
    const view = await api('newInProject', project.id);
    check('a chat started in the project: the view names it', view?.project?.name === 'Biology thesis', JSON.stringify(view?.project));
    await startIn(project.id);
    const chip = await inPage("(() => { const c = document.getElementById('cp-project-chip'); return { hidden: c.hidden, text: c.textContent }; })()");
    check('the header shows the project name as a chip', chip && chip.hidden === false && chip.text === 'Biology thesis', JSON.stringify(chip));
    check('the + menu offers "Add this tab to the project"', (await inPage("document.getElementById('add-tab-to-project') && !document.getElementById('add-tab-to-project').hidden")) === true);
    await send('ASKFILES what is the budget?');
    await settled();
    const req = (await fake()).requests[0];
    check('the context carries the instructions and the file index, not a file\'s text', /<project_instructions>[\s\S]*formal tone/.test(req.system) && /<project_context>[\s\S]*1\. budget\.md[\s\S]*2\. essay\.docx/.test(req.system) && /Reference page/.test(req.system) && !/4,000 dollars/.test(req.system), JSON.stringify([/formal tone/.test(req.system), /1. budget.md/.test(req.system), /2. essay.docx/.test(req.system), /Reference page/.test(req.system), /4,000 dollars/.test(req.system)]) + req.system.slice(req.system.indexOf('<project_context>')));
    check('the project context stays small (instructions + index well under 7,000 characters)', req.system.slice(req.system.indexOf('<project_instructions>')).length < 7000, req.system.length);
    check('project_files is offered in the project chat', req.tools.includes('project_files'), req.tools.join());
    const results = (await fake()).toolResults;
    check('the tool found the file and its passage (wrapped as untrusted data)', results.length === 1 && /untrusted_file_content/.test(results[0]) && /budget\.md @0/.test(results[0]) && /4,000 dollars/.test(results[0]), results[0]);
    await send('READPDF please');
    await settled();
    check('the tool reads a PDF in chunks', /Mitochondria make energy/.test((await fake()).toolResults[1] || ''), JSON.stringify((await fake()).toolResults[1]));
    const asked = await inPage("document.getElementById('messages').textContent");
    check('the steps show plain labels', /Searching project files for|project files/i.test(asked), asked.slice(-300));

    // ======== a chat outside any project gets none of it ========
    await inPage("document.getElementById('new-chat').click()");
    await sleep(400);
    await send('hello there');
    await settled();
    const plain = await lastRequest();
    check('outside a project: no index, no instructions, no project_files', !/project_context|project_instructions/.test(plain.system) && !plain.tools.includes('project_files'), plain.tools.join());
    check('…and no chip', (await inPage("document.getElementById('cp-project-chip').hidden")) === true);

    // ======== memory scoped to the project ========
    await startIn(project.id);
    await send('REMEMBER the code word');
    await settled();
    const mem = await app.evaluate(() => global.__projectWorkspace.memoryEntries());
    check('memory saved in a project chat belongs to the project', mem.length === 1 && mem[0].project === project.id && /kiwi/.test(mem[0].text), JSON.stringify(mem));
    await startIn(project.id);
    await send('what next?');
    await settled();
    check('…and is in the next chat of that project, under its own heading', /kiwi/.test((await lastRequest()).system) && /Saved for this project/.test((await lastRequest()).system));
    await inPage("document.getElementById('new-chat').click()");
    await sleep(400);
    await send('plain question');
    await settled();
    check('a chat outside the project does not see it', !/kiwi/.test((await lastRequest()).system));
    const second = await api('saveProject', { name: 'Other project', folderMode: 'none' });
    await api('newInProject', second.id);
    await sleep(300);
    await send('another project question');
    await settled();
    check('another project\'s chat does not see it either', !/kiwi/.test((await lastRequest()).system));
    const shown = await api('project', project.id);
    check('the project page lists its memory', shown.memory.length === 1 && /kiwi/.test(shown.memory[0].text) && shown.memoryOn === true);

    // ======== the project's page ========
    await inPage(`(async () => { await new Promise((resolve) => { const s = document.createElement('script'); s.src = 'chat-project-page.js'; s.onload = resolve; document.body.append(s); }); })()`);
    const opened = await inPage(`(async () => {
      document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'chat-project-page.css' }));
      const models = [...document.querySelectorAll('#model option')].map((o) => ({ value: o.value, label: o.textContent }));
      const list = (await window.assistant.chats.list());
      await window.chatProjectPage.open({ api: window.assistant.chats, id: ${JSON.stringify(project.id)}, host: { chats: () => list.chats, projects: () => list.projects, openChat() {}, newChat() {}, editFolder() {}, moveChats() {}, undoToast() {}, toast() {}, models: () => models, closed() {}, refresh() {} } });
      return true;
    })()`);
    check('the page opens', opened === true && (await inPage("Boolean(document.getElementById('cp-project-page'))")) === true);
    const text = await inPage("document.getElementById('cp-project-page').innerText");
    check('the page shows instructions, the three files, the pinned page, defaults and memory', (await inPage("document.querySelector('#cp-project-page .pjp-title').value")) === 'Biology thesis' && /budget\.md/.test(text) && /essay\.docx/.test(text) && /bio\.pdf/.test(text) && /Reference page/.test(text) && /Defaults/.test(text) && /kiwi/.test(text), JSON.stringify([/Biology thesis/.test(text), /budget.md/.test(text), /essay.docx/.test(text), /bio.pdf/.test(text), /Reference page/.test(text), /Defaults/.test(text), /kiwi/.test(text)]));
    const instr = await inPage("document.querySelector('#cp-project-page textarea').value");
    check('the instructions are in their box', instr === 'Answer in a formal tone.', instr);
    await inPage("(async () => { const input = document.querySelector('.pjp-search-input'); input.value = 'dollars'; input.dispatchEvent(new Event('input')); })()");
    await waitFor(async () => /4,000 dollars/.test(await inPage("document.querySelector('.pjp-results').innerText") || ''), 6000);
    check('the page\'s search finds the file passage', /budget\.md/.test(await inPage("document.querySelector('.pjp-results').innerText")), await inPage("document.querySelector('.pjp-results').innerText"));
    await inPage("window.chatProjectPage.close()");
    check('closing the page brings the chat back', (await inPage("document.getElementById('chat-root').hidden")) === false && (await inPage("Boolean(document.getElementById('cp-project-page'))")) === false);

    // ======== defaults: plan first, connectors and MCP tools ========
    const defaults = await api('projectDefaults', project.id, { model: '', plan: true, connectors: false, mcp: false });
    check('defaults are saved on the project', defaults?.defaults?.plan === true && defaults.defaults.connectors === false && defaults.defaults.mcp === false, JSON.stringify(defaults?.defaults));
    const planView = await api('newInProject', project.id);
    check('a new chat in the project starts with plan first (the view says so)', planView?.project?.plan === true);
    await startIn(project.id);
    check('…and the Plan chip is on', (await inPage("document.getElementById('plan-chip')?.getAttribute('aria-pressed')")) === 'true');
    const allowed = await app.evaluate(async () => {
      const agent = global.__agent;
      const chat = agent.messages;
      const cid = global.__chats.id();
      const out = {};
      agent.messages.settings = { adhdMode: true, model: 'claude-opus-5', ...global.__projectWorkspace.settingsFor(cid) };
      out.connectors = agent.projectAllows('connectors');
      out.projectTools = chat.settings.projectTools === true;
      return out;
    });
    check('the project\'s chats have the project tool', allowed.projectTools === true);
    await api('projectDefaults', project.id, { plan: false, connectors: true, mcp: true });

    // ======== a Lumen-owned CLI run is offered project_files; an outside client is not ========
    const cli = await app.evaluate(async () => {
      const agent = global.__agent;
      const cid = global.__chats.id();
      agent.messages.settings = { model: 'claudecode:default', adhdMode: true, ...global.__projectWorkspace.settingsFor(cid) };
      const out = {};
      agent.claudeCodeTurn = async (_m, _t, _i, signal, emit) => {
        global.__fakeEngine = { owns: (t) => t === 'run-tag-2', active: { emit, signal, scope: agent.runScope } };
        const own = { engine: 'run-tag-2', approvedHosts: new Set(), clientName: 'Claude', controller: new AbortController() };
        const outside = { approvedHosts: new Set(), clientName: 'Some other app', controller: new AbortController() };
        out.listed = { own: global.__mcpToolsFor(own).includes('project_files'), outside: global.__mcpToolsFor(outside).includes('project_files') };
        const r = await global.__mcpCallTool('project_files', { action: 'list' }, own);
        out.list = (r.content || []).map((b) => b.text).join(' ');
        const o = await global.__mcpCallTool('project_files', { action: 'list' }, outside);
        out.outside = { isError: o.isError, text: (o.content || []).map((b) => b.text).join(' ') };
      };
      await new Promise((resolve) => agent.run('use the project', (e) => { if (e.type === 'done') resolve(); }));
      global.__fakeEngine = null;
      return out;
    });
    check('a CLI run in a project chat is offered the tool; an outside client is not', cli.listed?.own === true && cli.listed.outside === false, JSON.stringify(cli.listed));
    check('…it lists the files; the outside client is refused', /budget\.md/.test(cli.list) && cli.outside?.isError === true, JSON.stringify([cli.list, cli.outside]));

    // ======== Add this tab ========
    const tabId = await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); }); return t.id; }, `${base}/pinned-tab`);
    const menu = await app.evaluate((_e, id) => global.__projectWorkspace.menuItems(id), tabId);
    check('the tab menu has Add to project, with the projects', menu.length === 1 && menu[0].label === 'Add to project' && menu[0].items.includes('Biology thesis') && menu[0].enabled, JSON.stringify(menu));
    await waitFor(async () => /pinned-tab/.test((await app.evaluate((_e, id) => global.__projectWorkspace.info(id), tabId))?.url || ''));
    await sleep(500);
    const pinned = await app.evaluate((_e, { id, pid }) => global.__projectWorkspace.addTab(id, pid), { id: tabId, pid: project.id });
    const again = await app.evaluate((_e, { id, pid }) => global.__projectWorkspace.addTab(id, pid), { id: tabId, pid: project.id });
    check('Add this tab pins the page with its title; again says it is already there', pinned.ok && /Fixture pinned-tab/.test(pinned.title) && again.ok && again.already === true && (await api('project', project.id)).project.links.length === 2, JSON.stringify([pinned.ok, pinned.title, again, await app.evaluate((_e, id) => global.__projectWorkspace.info(id), tabId)]));

    // ======== delete with Undo ========
    const files = await api('project', project.id);
    const dir = path.join(profile, 'project-files', project.id);
    check('the files are encrypted on disk, not plain text', fs.existsSync(dir) && fs.readdirSync(dir).every((n) => !/dollars|Mitochondria/.test(fs.readFileSync(path.join(dir, n), 'utf8'))));
    const deleted = await api('removeProject', project.id);
    check('delete: the project is gone from the list, its memory with it', deleted === true && !(await api('list')).projects.some((p) => p.id === project.id) && (await app.evaluate(() => global.__projectWorkspace.memoryEntries())).length === 0);
    const restored = await api('restoreProject', project.id);
    const back = await api('project', project.id);
    check('Undo: the project, its files, pages and memory are back', restored?.id === project.id && back?.files.length === files.files.length && back.project.links.length === 2 && back.memory.length === 1, JSON.stringify(back && [back.files.length, back.project.links.length, back.memory.length]));
    await api('removeProject', project.id);
    await waitFor(() => !fs.existsSync(dir), 20000);
    check('once the Undo time is over the files are erased', !fs.existsSync(dir) && (await api('restoreProject', project.id)) === null);

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
