// Every "Ask AI" surface follows the model the user picked, at once and exactly:
//  - the sidebar composer (placeholder + picker), in this window and in a second one,
//  - the lumen://chat page (placeholder + picker),
//  - the new-tab page's Search | Ask AI box (who it asks, and which model),
// and the next ask from each of them (new-tab box, sidebar, chat page, second window) reaches the
// model the user picked. The pick is changed every way the app has: the sidebar's picker, the
// Settings picker, the chat page's picker, a second window's picker, and a stand-in during a usage
// limit (fallback), plus a pick made while a reply is streaming and a pick that is no longer connected.
// What the next ask used is read from the fake engines (Claude client + providers.streamTurn).
// Each surface must show the change within 200 ms of the change being accepted.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const { openSettingsTab } = require('./settings-tab');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(50); } return v; };
const LIMIT_MS = 200;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-askai-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-openai-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  app.process().stderr?.on('data', (d) => { const t = String(d); if (/Error|Uncaught|exception/i.test(t) && !/MaxListeners/.test(t)) console.log(`  [main stderr] ${t.trim().slice(0, 400)}`); });
  app.process().on('exit', (code, signal) => console.log(`  [main exit] code=${code} signal=${signal}`));
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  // Fake engines: the Claude client and the OpenAI-style provider call record the model they get.
  await app.evaluate(() => {
    const fake = global.__fake = { used: [], gate: null, n: 0 };
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      fake.used.push(`anthropic:${params.model}`);
      const message = { role: 'assistant', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: `Reply ${++fake.n}.` }], usage: { input_tokens: 10, output_tokens: 5 } };
      return {
        async *[Symbol.asyncIterator]() { if (fake.gate) await fake.gate; yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message.content[0].text } }; },
        finalMessage: async () => message,
      };
    } } } });
    global.__providers.streamTurn = async ({ provider, model, emit }) => {
      fake.used.push(`${provider}:${model}`);
      if (fake.gate) await fake.gate;
      emit({ type: 'text', text: 'Reply.' });
      return { content: [{ type: 'text', text: `Reply ${++fake.n}.` }], stop_reason: 'end_turn', model: `${provider}:${model}`, usage: null };
    };
  });
  const used = () => app.evaluate(() => global.__fake.used.slice());
  const hold = () => app.evaluate(() => { global.__fake.release = null; global.__fake.gate = new Promise((r) => { global.__fake.release = r; }); });
  const release = () => app.evaluate(() => { const f = global.__fake; f.gate = null; f.release?.(); });

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  const opts = await ui.$$eval('#model option', (os) => os.map((o) => o.value));
  const OPUS = 'claude-opus-5-5';
  const HAIKU = 'claude-haiku-4-5';
  const GPT = opts.find((o) => o.startsWith('openai:') && !o.endsWith(':auto'));
  check('the picker lists Claude and OpenAI models', opts.includes(OPUS) && opts.includes(HAIKU) && Boolean(GPT), JSON.stringify(opts));

  // ---- surfaces -----------------------------------------------------------------------------
  // The Settings tab is reopened if something closed it (a restored window, the full-page chat).
  let settingsRun = await openSettingsTab(app);
  const inSettings = async (code) => {
    let r = await settingsRun(code);
    if (typeof r === 'string' && /executeJavaScript/.test(r)) { settingsRun = await openSettingsTab(app); await waitFor(async () => (await settingsRun("Boolean(document.getElementById('ai-model'))")) === true); r = await settingsRun(code); }
    return r;
  };
  await waitFor(async () => (await inSettings("Boolean(document.getElementById('ai-model'))").catch(() => false)) === true);

  await app.evaluate(() => global.__chatPage.open());
  const chatWc = (code) => app.evaluate(async (_e, c) => {
    const t = global.__chatPage.tabs().find((x) => x.chat);
    if (!t) return 'NO CHAT TAB';
    try { return await global.__chatPage.contents(t.id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
  }, code);
  await waitFor(async () => (await chatWc("Boolean(document.getElementById('model')?.value) && document.readyState === 'complete'")) === true);

  // A new-tab page (in the Ask AI mode) open for the whole run, in this window (made before the second one exists).
  const newTab = () => app.evaluate(async () => {
    const t = global.__agent.browser.openTab();
    // Ready when the page's own script has run (its Ask AI switch exists); the load event may already have passed.
    const end = Date.now() + 8000;
    for (;;) {
      const ready = await Promise.race([t.webContents.executeJavaScript("document.readyState === 'complete' && Boolean(document.getElementById('mode-ask'))", true).catch(() => false), new Promise((r) => setTimeout(() => r(false), 300))]);
      if (ready || Date.now() > end) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    global.__homeTab = t;
    return t.id;
  });
  const home = (code) => app.evaluate((_e, c) => Promise.race([
    global.__homeTab.webContents.executeJavaScript(c, true),
    new Promise((_r, reject) => setTimeout(() => { const w = global.__homeTab.webContents; reject(new Error(`new-tab page did not answer: loading=${w.isLoading()} crashed=${w.isCrashed()} destroyed=${w.isDestroyed()} url=${w.getURL().slice(0, 60)}`)); }, 5000)),
  ]), code);
  await newTab();
  await home("document.getElementById('mode-ask').click()");

  // A second window.
  await app.evaluate(() => global.__basics.openNewWindow());
  const ui2 = await waitFor(async () => app.windows().find((p) => p !== ui && p.url().includes('index.html')));
  await ui2.waitForSelector('.tab', { state: 'attached' });
  await ui2.evaluate(() => document.getElementById('toggle-sidebar').click());

  const GROUP = (id) => (id.startsWith('claude-') ? 'Claude' : 'ChatGPT');
  const sidebarState = (page) => page.evaluate(() => ({ model: document.getElementById('model').value, placeholder: document.getElementById('prompt').placeholder }));
  const surfaces = {
    'sidebar (window 1)': () => sidebarState(ui),
    'sidebar (window 2)': () => sidebarState(ui2),
    'chat page': () => chatWc("({ model: document.getElementById('model').value, placeholder: document.getElementById('prompt').placeholder })"),
    'new-tab Ask AI box': async () => ({ model: await home("document.getElementById('mode-ask').dataset.model || ''"), placeholder: await home("document.getElementById('q').placeholder") }),
  };
  const expectedPlaceholder = (id, name) => (name === 'new-tab Ask AI box' ? `Ask ${GROUP(id)}…` : null);

  // The chat page is a tab: bring it back if something closed it.
  const ensureChatPage = async () => {
    if ((await chatWc("document.readyState")) === 'NO CHAT TAB') await app.evaluate(() => global.__chatPage.open());
    await waitFor(async () => (await chatWc("Boolean(document.getElementById('model')?.value) && document.readyState === 'complete'")) === true);
  };
  // Polls every surface at once until each shows `id` (or the limit passes); each one's own time is checked.
  // `homeId`: the new-tab box starts a NEW chat, so it shows the saved default, not the model of the chat open in the sidebar.
  async function followed(id, from, label, homeId = id) {
    await ensureChatPage();
    const start = Date.now();
    const watch = async (name, read) => {
      let last = null;
      const want = name === 'new-tab Ask AI box' ? homeId : id;
      while (Date.now() - start < 1500) {
        const s = await read().then((r) => (r && typeof r === 'object' ? r : { model: 'ERR', placeholder: String(r) })).catch((e) => ({ model: 'ERR', placeholder: String(e.message) }));
        last = s;
        const placeholderOk = name === 'new-tab Ask AI box' ? s.placeholder === expectedPlaceholder(want, name) : (GROUP(want) === 'Claude' ? /Claude/.test(s.placeholder) : !/Claude/.test(s.placeholder));
        if (s.model === want && placeholderOk) return { ms: Date.now() - start };
        await sleep(2);
      }
      return { last };
    };
    const results = await Promise.all(Object.entries(surfaces).map(([name, read]) => watch(name, read)));
    const homeDebug = results.some((r) => r.ms === undefined || r.ms > LIMIT_MS) ? await home("JSON.stringify({ hidden: document.hidden, hashModel: JSON.parse(decodeURIComponent(location.hash.slice(1))).assistant, mode: document.getElementById('mode-ask').dataset.model })").catch((e) => String(e)) : '';
    const settingsSelect = homeDebug ? await inSettings("document.getElementById('ai-model')?.value").catch(() => 'x') : '';
    const chatTabsDebug = homeDebug ? await app.evaluate(async () => Promise.all(global.__chatPage.tabs().filter((t) => t.chat).map(async (t) => [t.id, await global.__chatPage.contents(t.id).executeJavaScript("[document.getElementById('model')?.value, document.visibilityState, document.hasFocus()].join('/')")]))).catch((e) => String(e)) : '';
    const mainModel = homeDebug ? await ui.evaluate(() => window.assistant.getSettings().then((s) => s.model)).catch((e) => String(e.message)) : '';
    Object.keys(surfaces).forEach((name, i) => {
      const r = results[i];
      if (r.last) r.last = { ...r.last, chatTabsDebug, settingsSelect, mainModel };
      check(`${label}: ${name} shows ${name === 'new-tab Ask AI box' ? homeId : id} within ${LIMIT_MS} ms (${r.ms === undefined ? 'never' : `${r.ms} ms`})`,r.ms !== undefined && r.ms <= LIMIT_MS, r.ms === undefined ? `never; last ${JSON.stringify(r.last)}` : `${r.ms} ms (from ${from})`);
    });
  }

  // The sidebar may be folded away (the chat page, a full-page chat): drive the composer through the DOM.
  // A sidebar that was folded away can miss a run's end and keep its Stop button; Send as a button would then stop instead of send.
  const typeAndSend = async (page, text) => {
    await page.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar')?.click(); }); // (the sidebar is open or closed tab by tab)
    await page.waitForFunction(() => !document.body.classList.contains('sidebar-hidden'), null, { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => document.getElementById('prompt').focus());
    await page.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 4000 }).catch(() => {});
    return page.evaluate((t) => { const p = document.getElementById('prompt'); p.value = t; p.dispatchEvent(new Event('input', { bubbles: true })); p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }, text); // (Enter, as a user sends: with a stale Stop showing it first asks main what the chat is doing, where the button would stop)
  };
  async function nextAsk(id, how) {
    await ensureChatPage();
    // The one before has finished (nothing running or waiting): its reply must not count as this ask's.
    await waitFor(async () => { await sleep(150); return (await app.evaluate(() => !global.__agent.running)) && (await ui.evaluate(() => !document.getElementById('send').classList.contains('stop'))); });
    const before = (await used()).length;
    if (how === 'sidebar') await typeAndSend(ui, `ask ${before} from the sidebar`);
    else if (how === 'window 2') await typeAndSend(ui2, `ask ${before} from window 2`);
    else if (how === 'chat page') { await chatWc(`(() => { const p = document.getElementById('prompt'); p.value = 'ask ${before} from the chat page'; p.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('send').click(); })()`); }
    else if (how === 'new tab') {
      await home("document.getElementById('mode-ask').click()"); // the same new-tab page every time (a tab opened now would land in whichever window is in front)
      await home(`(() => { const q = document.getElementById('q'); q.value = 'ask ${before} from the new tab'; q.form.requestSubmit(); })()`);
    }
    const got = await waitFor(async () => (await used()).length > before && (await used()).slice(before));
    check(`next ask (${how}) used ${id}`, Boolean(got) && got[0] === (id.includes(':') ? id : `anthropic:${id}`), JSON.stringify(got));
    await sleep(400); // let the reply end
  }

  // ---- ways to change the model -------------------------------------------------------------
  const changes = {
    'sidebar picker': (id) => ui.evaluate((v) => { const s = document.getElementById('model'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, id),
    'Settings picker': (id) => inSettings(`(() => { const s = document.getElementById('ai-model'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`),
    'chat page picker': (id) => chatWc(`(() => { const s = document.getElementById('model'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`),
    'window 2 picker': (id) => ui2.evaluate((v) => { const s = document.getElementById('model'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, id),
  };
  const asks = ['new tab', 'sidebar', 'chat page', 'window 2'];
  let current = OPUS;
  const sequence = [HAIKU, GPT, OPUS, GPT, HAIKU, OPUS];
  let n = 0;
  for (const [via, change] of Object.entries(changes)) {
    for (const target of [sequence[n % sequence.length], sequence[(n + 1) % sequence.length]]) {
      if (target === current) continue;
      const from = current;
      await ensureChatPage();
      const r = await change(target);
      if (typeof r === 'string') console.log(`  (${via} returned ${r})`);
      await followed(target, from, `${via}`);
      await nextAsk(target, asks[n % asks.length]);
      current = target;
      n++;
    }
  }

  // ---- a stand-in while the picked model is out of usage (fallback) -------------------------
  await ui.evaluate((v) => { const s = document.getElementById('model'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, OPUS);
  await followed(OPUS, current, 'back to the default');

  await app.evaluate((_e, id) => {
    const fb = global.__aiFallback;
    fb.shared.mark(id, fb.classify(Object.assign(new Error('You have hit your usage limit'), { status: 429 })));
    global.__modelsChanged();
  }, OPUS);
  const standIn = await ui.evaluate(() => window.assistant.getSettings().then((s) => s.model));
  check('a usage limit puts a stand-in in the picker', standIn !== OPUS, standIn);
  await sleep(50);
  await followed(standIn, OPUS, 'usage-limit stand-in');
  await app.evaluate((_e, id) => { global.__aiFallback.shared.clear(id); global.__modelsChanged(); }, OPUS);
  await followed(OPUS, standIn, 'stand-in ends');

  // ---- a pick made while a reply is streaming ------------------------------------------------
  await hold();
  await typeAndSend(ui, 'a long one');
  await waitFor(async () => (await used()).length && (await ui.evaluate(() => document.getElementById('send').classList.contains('stop'))));
  const midBefore = (await used()).slice();
  await changes['Settings picker'](HAIKU);
  await followed(HAIKU, OPUS, 'mid-reply (Settings picker)');
  check('the running reply keeps its model', midBefore[midBefore.length - 1] === `anthropic:${OPUS}`, JSON.stringify(midBefore));
  await release();
  await waitFor(async () => !(await ui.evaluate(() => document.getElementById('send').classList.contains('stop'))));
  await nextAsk(HAIKU, 'new tab');


  // ---- each chat keeps its own model: opening another chat moves the pickers and the placeholders to it ----
  // The chat open now is on Haiku. Begin a new chat on Opus, then go back to the Haiku one and on to a new chat.
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await changes['sidebar picker'](OPUS);
  await followed(OPUS, HAIKU, 'new chat, then picked Opus');
  await nextAsk(OPUS, 'sidebar');
  // (the most recent chat begun from the new-tab box is the one the Haiku reply above went to)
  const haikuChat = await ui.evaluate(() => window.assistant.chats.list().then((l) => l.chats.find((c) => /from the new tab/.test(c.title))?.id));
  check('the earlier chat is in the list with its model', Boolean(haikuChat), haikuChat);
  await ui.evaluate((id) => window.assistant.chats.open(id), haikuChat);
  await followed(HAIKU, OPUS, 'opened the Haiku chat', OPUS); // (the new-tab box stays on the saved default: it starts a new chat)
  await nextAsk(HAIKU, 'sidebar');
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await followed(OPUS, HAIKU, 'a new chat after the Haiku one', OPUS);
  await nextAsk(OPUS, 'chat page');
  current = OPUS;

  // ---- a pick that is not connected any more ------------------------------------------------
  await changes['sidebar picker'](GPT);
  await followed(GPT, current, 'before the key goes');
  await app.evaluate(() => { delete process.env.OPENAI_API_KEY; global.__modelsChanged(); });
  const fellBack = await ui.evaluate(() => window.assistant.getSettings().then((s) => s.model));
  check('a model that is gone falls back to a connected one', fellBack !== GPT && !fellBack.startsWith('openai:'), fellBack);
  await sleep(50);
  await followed(fellBack, GPT, 'the model is no longer connected');
  await nextAsk(fellBack, 'sidebar');

  check('no page errors', errors.length === 0, errors.join(' | '));
  await app.close();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* temp */ }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall ask-ai-model checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
