// "Look at this": the screenshot a message carries when it points at what the user is looking at (ai/screen-context.js and
// the agent's use of it), plain Node: when it is attached, what is attached for a model that sees and one that doesn't,
// where it is never attached, the camera button's override both ways, one picture per message, the saved chat and the
// chip's ×, and the prompt budget. Fake tab, fake image, fake model turns: no window, no network.
const fs = require('fs');
const path = require('path');
const sc = require('../src/ai/screen-context');
const { Agent, transcriptFor, systemFor } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const J = JSON.stringify;

// A NativeImage stand-in that remembers what was done to it.
function fakeImage(width, height, log = []) {
  return {
    getSize: () => ({ width, height }),
    resize(o) { const w = o.width || Math.round(width * (o.height / height)); const h = o.height || Math.round(height * (o.width / width)); log.push(['resize', o]); return fakeImage(w, h, log); },
    toJPEG(q) { log.push(['jpeg', q]); return Buffer.from(`jpeg-${width}x${height}-q${q}`); },
  };
}

const WEB = 'https://example.com/report';
const base = { text: 'what is this', url: WEB, vision: true };

(async () => {
  // ---- plan: when it fires
  {
    const p = sc.plan(base);
    check('words: "what is this" on a web page captures an image', p.capture && p.how === 'image' && /^words:/.test(p.why), J(p));
    check('no pointer, no capture: a plain question', !sc.plan({ ...base, text: 'write a haiku about rain' }).capture && sc.plan({ ...base, text: 'write a haiku about rain' }).why === 'no-intent');
    check('"this is wrong, try again" is not a capture', !sc.plan({ ...base, text: 'this is wrong, try again', lastTurns: [{ role: 'assistant', text: 'The answer is 5.' }] }).capture);
    check('a model that cannot see images gets the page text instead', (() => { const q = sc.plan({ ...base, vision: false }); return q.capture && q.how === 'text'; })());
    check('an unknown model (vision null) is treated as able to see', sc.plan({ ...base, vision: null }).how === 'image');
  }
  // ---- the button, both ways
  {
    check('button on: captures a message with no pointer in it', (() => { const q = sc.plan({ ...base, text: 'hello there', mode: 'on' }); return q.capture && q.why === 'button' && q.how === 'image'; })());
    check('button off: a clear pointer is left alone', (() => { const q = sc.plan({ ...base, text: 'what is this', mode: 'off' }); return !q.capture && q.why === 'off'; })());
    check('button on, text-only model: the text, not an image', sc.plan({ ...base, text: 'hello', mode: 'on', vision: false }).how === 'text');
    check('button on overrides the words-only rules (setting, payment page)', sc.plan({ ...base, text: 'hello', mode: 'on', pageContext: false, url: 'https://shop.example.com/checkout' }).capture);
  }
  // ---- where it is never captured
  {
    check('per-site AI off: never, whatever the button says', !sc.plan({ ...base, aiOff: true }).capture && !sc.plan({ ...base, aiOff: true, mode: 'on' }).capture && sc.plan({ ...base, aiOff: true, mode: 'on' }).why === 'ai-off');
    check('private window: never, whatever the button says', !sc.plan({ ...base, privateWindow: true }).capture && !sc.plan({ ...base, privateWindow: true, mode: 'on' }).capture);
    check('no tab: nothing', !sc.plan({ ...base, hasTab: false, url: '' }).capture && !sc.plan({ ...base, hasTab: false, url: '', mode: 'on' }).capture);
    const internal = ['file:///C:/app/src/renderer/settings.html', 'file:///C:/app/src/renderer/passwords.html', 'lumen://settings', 'lumen://chat', 'about:blank', 'chrome://settings', 'chrome-extension://abcdefghijklmnop/popup.html', 'data:text/html,hi', 'devtools://devtools/bundled/inspector.html', 'view-source:https://example.com', 'file:///C:/Users/me/notes.txt', 'blob:https://example.com/1234', 'ftp://example.com/x', 'javascript:alert(1)', 'not a url'];
    for (const url of internal) {
      check(`internal page, words: not captured (${url})`, !sc.plan({ ...base, url }).capture);
      check(`internal page, button on: still not captured (${url})`, !sc.plan({ ...base, url, mode: 'on' }).capture && sc.plan({ ...base, url, mode: 'on' }).why === 'internal');
    }
    check('a local PDF is captured', sc.plan({ ...base, url: 'file:///C:/Users/me/paper.pdf' }).capture);
    check('Lumen\'s slide viewer is captured', sc.plan({ ...base, url: 'file:///C:/app/src/renderer/slides.html?u=x', viewer: true }).capture);
    check('http pages are captured', sc.plan({ ...base, url: 'http://example.com/' }).capture);
    for (const url of ['https://shop.example.com/checkout', 'https://example.com/billing/cards', 'https://pay.example.com/', 'https://example.com/account/password', 'https://example.com/2fa/verify', 'https://example.com/settings/otp']) {
      check(`payment / password / one-time-code address: not captured by words alone (${url})`, !sc.plan({ ...base, url }).capture && sc.plan({ ...base, url }).why === 'sensitive');
    }
    check('an ordinary address is not "sensitive"', !sc.sensitiveAddress('https://example.com/blog/paying-attention-to-prices') && !sc.sensitiveAddress('https://news.example.com/payments-industry-news-roundup'.replace('payments-industry', 'industry')));
    check('the setting "attach the current page" off: the words alone attach nothing', !sc.plan({ ...base, pageContext: false }).capture && sc.plan({ ...base, pageContext: false }).why === 'setting');
  }
  // ---- shrink and capture
  {
    let log = [];
    const wide = sc.shrink(fakeImage(3200, 1800, log));
    check('a wide capture is shrunk to a 1568 px long edge', wide.width === 1568 && log[0][0] === 'resize' && log[0][1].width === 1568, J(log));
    const tall = sc.shrink(fakeImage(1000, 4000, []));
    check('a tall capture is shrunk by its height', tall.height === 1568 && tall.width === 392, J([tall.width, tall.height]));
    const small = sc.shrink(fakeImage(1200, 800, log = []));
    check('a small capture is left at its size', small.width === 1200 && !log.some((l) => l[0] === 'resize'));
    check('it is a JPEG at quality 70', small.media_type === 'image/jpeg' && log.some((l) => l[0] === 'jpeg' && l[1] === 70) && Buffer.from(small.data, 'base64').toString().endsWith('q70'));
    const made = await sc.capture({}, { title: 'Q3 "report" <draft>', url: WEB, capture: async () => fakeImage(2560, 1440) });
    check('capture: a marker block, then one image block', made.blocks.length === 2 && made.blocks[0].type === 'text' && made.blocks[1].type === 'image' && made.blocks[1].source.media_type === 'image/jpeg', J(made.blocks.map((b) => b.type)));
    check('capture: the marker round-trips a title with quotes and angle brackets', sc.parseMarker(made.blocks[0].text)?.title === 'Q3 "report" <draft>' && sc.parseMarker(made.blocks[0].text)?.id === made.chip.id, made.blocks[0].text);
    check('capture: the chip has a small thumbnail data URL', /^data:image\/jpeg;base64,/.test(made.chip.thumb) && Buffer.from(made.chip.thumb.split(',')[1], 'base64').toString().includes('240x135'), made.chip.thumb.slice(0, 80));
    check('capture: the image is small enough to be sane (well under 1 MB)', made.image.data.length < 1_000_000);
    check('capture: a failing capture rejects (the agent then sends the text only)', await sc.capture({}, { capture: async () => { throw new Error('no'); } }).then(() => false, () => true));
    check('markers are unique', sc.textMarker({ title: 'a', url: 'b' }).chip.id !== sc.textMarker({ title: 'a', url: 'b' }).chip.id);
  }

  // ---- the agent: a message through runTask
  const SEES = 'claude-opus-5-5';
  const BLIND = 'openai:gpt-3.5-turbo'; // known text-only in ai/fallback.js CAPS
  function makeAgent({ aiOff = () => false, pageContext = true, options = [] } = {}) {
    const log = { events: [], pageReads: 0, ccImages: null, tools: [] };
    const agent = Object.assign(Object.create(Agent.prototype), {
      scopes: new Set(), runs: new Map(), approvedHosts: new Set(),
      browser: { fallbackOptions: () => options, autoFallback: () => false, maxSteps: () => 0, aiOff, noTabReason: () => 'No tab open.', claudeCodeFullAccess: () => false },
      engines: { claudecode: { warm() {}, release() {} } },
      getOptions: () => ({ pageContext }),
      isExternalTool: () => false,
      async describeStep() { return 'step'; },
      async ensureAllowed() {},
      closeSignedInTabs() {},
      guardRedirects: () => null,
      async runTool(name) { log.tools.push(name); return 'ok'; },
      async pageContextFor() { log.pageReads++; return '<untrusted_page_content>page text</untrusted_page_content>\n\n'; },
      newActionLog: () => ({}), undoSummary: () => null,
      async claudeTurn(messages) { return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: messages.settings.model }; },
      async otherTurn(messages) { return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: messages.settings.model }; },
      async claudeCodeTurn(messages, prompt, images) { log.ccImages = images; },
      captured: 0,
      async screenCapture(tab) { this.captured++; return sc.capture(tab.webContents, { title: tab.webContents.getTitle(), url: tab.webContents.getURL(), capture: async () => fakeImage(1920, 1080) }); },
    });
    agent.execute = (name, input) => Agent.prototype.executeGuarded.call(agent, name, input);
    return { agent, log };
  }
  const tabAt = (url, title = 'Quarterly report') => ({ id: 7, webContents: { getURL: () => url, getTitle: () => title, isDestroyed: () => false } });
  const fresh = (model, prior = []) => { const m = [...prior]; m.settings = { model }; return m; };
  const ask = async (agent, log, messages, text, { tab = tabAt(WEB), images = [], extra = {} } = {}) => {
    const controller = new AbortController();
    log.events.length = 0;
    await agent.inTask(tab?.id, controller.signal, () => agent.runTask(messages, tab, text, images, controller, (e) => log.events.push(e), extra), messages, null, {});
  };
  const userBlocks = (messages) => messages.find((m) => m.role === 'user').content;
  const shots = (messages) => userBlocks(messages).filter((b) => b.type === 'image');
  const chipOf = (log) => log.events.find((e) => e.type === 'screen_attached');

  {
    // a model that sees
    const { agent, log } = makeAgent();
    const messages = fresh(SEES);
    await ask(agent, log, messages, 'what is this chart showing?');
    const content = userBlocks(messages);
    check('vision: the message carries the marker, one image, then the text', content.map((b) => b.type).join() === 'text,image,text' && sc.parseMarker(content[0].text) && /what is this chart showing/.test(content[2].text), J(content.map((b) => b.type)));
    check('vision: the text part still has the tab\'s title and address', /Title: Quarterly report/.test(content[2].text) && /URL: https:\/\/example\.com\/report/.test(content[2].text), content[2].text.slice(0, 200));
    check('vision: the image is a JPEG', content[1].source.media_type === 'image/jpeg' && content[1].source.type === 'base64');
    check('vision: the sidebar is told (a chip with the title and a thumbnail)', chipOf(log)?.title === 'Quarterly report' && chipOf(log)?.kind === 'image' && /^data:image\/jpeg/.test(chipOf(log)?.thumb || '') && /^words:/.test(chipOf(log)?.words || ''), J(chipOf(log)).slice(0, 200));
    check('vision: the page text goes along too (a question about the page is not "simple")', log.pageReads === 1);
  }
  {
    // a model that can't see
    const { agent, log } = makeAgent();
    const messages = fresh(BLIND);
    await ask(agent, log, messages, 'what is this?');
    const content = userBlocks(messages);
    check('text-only model: no image block, the page text is attached instead', !content.some((b) => b.type === 'image') && log.pageReads === 1 && content.some((b) => b.type === 'text' && /page text/.test(b.text)), J(content.map((b) => b.type)));
    check('text-only model: the chip says it is the text', chipOf(log)?.kind === 'text' && chipOf(log)?.thumb === '', J(chipOf(log)));
    check('text-only model: nothing was captured', agent.captured === 0);
  }
  {
    // no pointer: nothing, and not "attach on every message"
    const { agent, log } = makeAgent();
    const messages = fresh(SEES);
    await ask(agent, log, messages, 'tell me a joke');
    check('a message with no pointer carries no screenshot and no capture is taken', shots(messages).length === 0 && agent.captured === 0 && !chipOf(log));
    await ask(agent, log, messages, 'is this a scam?');
    check('the next message that points at the screen gets exactly one', messages.filter((m) => m.role === 'user').flatMap((m) => m.content).filter((b) => b.type === 'image').length === 1 && agent.captured === 1);
  }
  {
    // the button
    const a = makeAgent();
    const on = fresh(SEES);
    await ask(a.agent, a.log, on, 'hello', { extra: { screen: 'on' } });
    check('button on: "hello" carries the screenshot', shots(on).length === 1 && a.log.events.some((e) => e.type === 'screen_attached' && e.words === 'button'));
    const b = makeAgent();
    const off = fresh(SEES);
    await ask(b.agent, b.log, off, 'what is this error?', { extra: { screen: 'off' } });
    check('button off: "what is this error?" carries none', shots(off).length === 0 && b.agent.captured === 0 && !chipOf(b.log) && !b.log.events.some((e) => e.type === 'notice'));
    const c = makeAgent();
    const both = fresh(SEES);
    await ask(c.agent, c.log, both, 'explain this screenshot of my screen', { extra: { screen: 'on' }, images: [{ media_type: 'image/png', data: 'AAAA' }] });
    check('one screenshot per message: the user\'s own picture plus the screenshot, never two screenshots', shots(both).length === 2 && c.agent.captured === 1 && userBlocks(both).filter((b) => b.type === 'text' && sc.parseMarker(b.text)).length === 1, `${shots(both).length} images, ${c.agent.captured} captures`);
  }
  {
    // never captured
    const { agent, log } = makeAgent({ aiOff: () => true });
    const messages = fresh(SEES);
    await ask(agent, log, messages, 'what is this?');
    check('AI off for the site (words): no capture, no chip, no notice, title and address not shared', agent.captured === 0 && shots(messages).length === 0 && !chipOf(log) && !log.events.some((e) => e.type === 'notice') && !/Quarterly report|example\.com/.test(J(userBlocks(messages))), J(log.events.map((e) => e.type)));
    await ask(agent, log, messages, 'what is this?', { extra: { screen: 'on' } });
    check('AI off for the site (button on): not captured, and the user is told why', agent.captured === 0 && log.events.some((e) => e.type === 'notice' && /turned off AI on this site/.test(e.text)), J(log.events));
  }
  {
    const { agent, log } = makeAgent();
    const messages = fresh(SEES);
    await ask(agent, log, messages, 'what is this?', { tab: tabAt('file:///C:/app/src/renderer/passwords.html', 'Passwords'), extra: { screen: 'on' } });
    check('Lumen\'s own pages: not captured even with the button on, and the user is told', agent.captured === 0 && shots(messages).length === 0 && log.events.some((e) => e.type === 'notice' && /own pages/.test(e.text)), J(log.events));
    const w = makeAgent();
    const m2 = fresh(SEES);
    await ask(w.agent, w.log, m2, 'what is this?', { tab: tabAt('https://shop.example.com/checkout', 'Checkout') });
    check('a checkout page: not captured by the words', w.agent.captured === 0 && shots(m2).length === 0);
    const n = makeAgent({ pageContext: false });
    const m3 = fresh(SEES);
    await ask(n.agent, n.log, m3, 'what is this?');
    check('"attach the current page" off: the words attach nothing', n.agent.captured === 0 && shots(m3).length === 0);
    const q = makeAgent();
    const m4 = fresh(SEES);
    await ask(q.agent, q.log, m4, 'what is this?', { tab: null });
    check('no tab open: nothing, no error', q.agent.captured === 0 && !q.log.events.some((e) => e.type === 'error'));
  }
  {
    // a capture that fails: the message still goes (with the page text), the user is told only if they asked
    const { agent, log } = makeAgent();
    agent.screenCapture = async () => { throw new Error('gpu'); };
    const messages = fresh(SEES);
    await ask(agent, log, messages, 'what is this?');
    check('capture fails (words): the message goes with the page text, silently', shots(messages).length === 0 && log.pageReads === 1 && !log.events.some((e) => e.type === 'notice' || e.type === 'error'), J(log.events.map((e) => e.type)));
    const m2 = fresh(SEES);
    await ask(agent, log, m2, 'hello', { extra: { screen: 'on' } });
    check('capture fails (button): a notice says so', log.events.some((e) => e.type === 'notice' && /could not be taken/.test(e.text)) && !log.events.some((e) => e.type === 'error'));
  }
  {
    // CLI engines: the screenshot rides as an attached picture
    const { agent, log } = makeAgent();
    const messages = fresh('claudecode:default');
    await ask(agent, log, messages, 'what is this?');
    check('Claude Code: the screenshot goes with the message as an attached image', Array.isArray(log.ccImages) && log.ccImages.length === 1 && log.ccImages[0].media_type === 'image/jpeg', J(log.ccImages));
    const { agent: a2, log: l2 } = makeAgent();
    await ask(a2, l2, fresh('claudecode:default'), 'tell me a joke');
    check('Claude Code: nothing extra when the words do not point at the screen', Array.isArray(l2.ccImages) && l2.ccImages.length === 0);
  }

  // ---- the saved chat and the chip's ×
  {
    const { agent, log } = makeAgent();
    const messages = fresh(SEES);
    await ask(agent, log, messages, 'what is this chart showing?', { images: [{ media_type: 'image/png', data: 'AAAA' }] });
    const items = transcriptFor(messages, messages.settings);
    const user = items.find((i) => i.role === 'user');
    check('restored chat: the user\'s own picture stays an attachment, the screenshot does not', user.images.length === 1 && user.images[0].startsWith('data:image/png'), J(user.images.map((i) => i.slice(0, 20))));
    check('restored chat: the screenshot comes back as a chip (title, kind, picture)', user.screen?.title === 'Quarterly report' && user.screen.kind === 'image' && /^data:image\/jpeg/.test(user.screen.image) && user.screen.id === chipOf(log).id, J(user.screen).slice(0, 200));
    check('restored chat: the marker text is not shown as the message', user.text === 'what is this chart showing?', user.text);
    // × : the picture leaves the chat, the question stays
    const id = user.screen.id;
    check('x removes the screenshot (one image block turned into a note)', sc.dropFrom(messages, id) === 1 && shots(messages).length === 1, J(userBlocks(messages).map((b) => b.type)));
    const after = transcriptFor(messages, messages.settings).find((i) => i.role === 'user');
    check('x: nothing of it comes back in the restored chat, the text stays', !after.screen && after.text === 'what is this chart showing?' && after.images.length === 1, J(after).slice(0, 200));
    check('x twice is harmless', sc.dropFrom(messages, id) === 0 && sc.dropFrom(messages, 'nope') === 0 && sc.dropFrom(null, id) === 0);
  }
  {
    // the history handed to an engine that starts mid-chat has no screenshots in it
    const { agent, log } = makeAgent();
    const messages = fresh(SEES);
    await ask(agent, log, messages, 'what is this?');
    const items = transcriptFor(messages, messages.settings);
    check('handoff history: a screenshot is not resent as an earlier user picture', items.every((i) => !i.images.length));
  }

  // ---- prompt budget and guidance
  {
    const sys = systemFor({ model: SEES });
    check('the system prompt tells the model to screenshot when the user says "this"', /screenshot first/.test(sys) && /never ask the user to describe/.test(sys));
    check('the rule is one short line (under 160 characters)', (sys.split('\n').find((l) => /screenshot first/.test(l)) || '').length < 160, sys.split('\n').find((l) => /screenshot first/.test(l)));
    check('the CLI engines get the rule through the same prompt', /screenshot first/.test(require('../src/ai/agent').cliSystemPrompt({ model: 'grokbuild:default', adhdMode: true }, 'grokbuild')) && /screenshot first/.test(require('../src/ai/agent').cliSystemPrompt({ model: 'claudecode:default' }, 'claudecode')));
    const mcp = fs.readFileSync(path.join(__dirname, '..', 'src', 'automation', 'mcp.js'), 'utf8');
    check('the MCP instructions tell outside agents to call screenshot for "this" / "here"', /instructions: '[^']*"this"[^']*call screenshot instead of asking/.test(mcp));
  }
  // ---- wiring (strings only: main and the preloads are Electron files)
  {
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    check('main: agent:ask takes the button\'s choice and hands it to the agent', /'agent:ask', \(event, text, runId, images = \[\], tabIds = \[\], fileRefs = \[\], screenMode = null\)/.test(read('src/main.js')) && /screen: screenMode === 'on' \|\| screenMode === 'off'/.test(read('src/main.js')));
    check('the sidebar and chat-page preloads pass it on, and expose the chip\'s ×', /screen\) => ipcRenderer\.send\('agent:ask'.*screen\)/.test(read('src/preload/preload.js')) && /screen\) => ipcRenderer\.send\('agent:ask'.*screen\)/.test(read('src/features/chat-preload.js')) && /dropScreen/.test(read('src/preload/preload.js')) && /dropScreen/.test(read('src/features/chat-preload.js')));
    check('agent:screen-drop is allowed for the sidebar and the chat page only', /'agent:screen-drop'/.test(read('src/main.js').split('const UI_ONLY_IPC')[1].split(']);')[0]) && /'agent:screen-drop'/.test(read('src/features/chat-page.js')));
    check('both composers have the camera button and load the detector', ['src/renderer/index.src.html', 'src/renderer/chat-page.html'].every((f) => /id="screen-btn"/.test(read(f)) && /ai\/screen-intent\.js/.test(read(f))));
    const en = JSON.parse(read('src/locales/en.json'));
    check('the strings exist', ['composer.screen.idle', 'composer.screen.auto', 'composer.screen.on', 'composer.screen.off', 'composer.screen.label', 'chat.screen.image', 'chat.screen.text', 'chat.screen.remove', 'chat.screen.removed', 'chat.screen.untitled'].every((k) => typeof en[k] === 'string' && en[k]));
  }

  // ---- the composer's camera button and the chip (renderer/chat-core.js, its own section run against a tiny fake DOM)
  {
    const vm = require('vm');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'chat-core.js'), 'utf8').replace(/\r\n/g, '\n');
    const section = src.split('// ---------- screen context:')[1].split('// ---------- attachments:')[0];
    class El {
      constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.classes = new Set(); this.disabled = false; this.parent = null; }
      get classList() { const c = this.classes; return { add: (n) => c.add(n), contains: (n) => c.has(n) }; }
      set className(v) { this.classes = new Set(String(v).split(' ')); }
      setAttribute(k, v) { this.attrs[k] = v; }
      append(...n) { for (const x of n) { if (x && typeof x === 'object') x.parent = this; this.children.push(x); } }
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
      querySelector(sel) { const want = sel.replace('.', ''); const walk = (e) => { for (const c of e.children) { if (c && c.classes?.has(want)) return c; const r = c?.children && walk(c); if (r) return r; } return null; }; return walk(this); }
      focus() { this.focused = true; }
    }
    const screenBtn = new El('button');
    const bubble = new El('div');
    const calls = [];
    const ctx = {
      optional: () => screenBtn,
      messages: { querySelectorAll: () => [] },
      prompt: new El('textarea'),
      running: false,
      t: (k, v = {}) => k + (v.title ? ':' + v.title : ''),
      document: { createElement: (tag) => new El(tag) },
      Object, Boolean, String, Promise,
      window: { screenIntent: require('../src/ai/screen-intent'), assistant: { dropScreen: async (id) => { calls.push(id); return id !== 'bad'; } } },
    };
    ctx.prompt.value = '';
    vm.createContext(ctx);
    vm.runInContext('//' + section + ';\nthis.api = { renderScreenBtn, takeScreenMode, screenChip, getMode: () => screenMode };', ctx);
    const { renderScreenBtn, takeScreenMode, screenChip } = ctx.api;
    const type = (v) => { ctx.prompt.value = v; renderScreenBtn(); };
    type(''); check('button: idle when nothing is typed', screenBtn.dataset.state === 'idle' && screenBtn.attrs['aria-pressed'] === 'false');
    type('what is this error?'); check('button: lit (auto) as the user types a pointer', screenBtn.dataset.state === 'auto' && screenBtn.attrs['aria-pressed'] === 'true' && /composer.screen.auto/.test(screenBtn.title));
    type('this is wrong, try again'); check('button: stays idle for "this is wrong"', screenBtn.dataset.state === 'idle');
    type('what is this error?'); screenBtn.onclick(); check('button: a click on the lit button turns it off for the next message', screenBtn.dataset.state === 'off' && ctx.api.getMode() === 'off');
    check('button: sending passes "off" once, then it is back to the words', takeScreenMode() === 'off' && ctx.api.getMode() === null && screenBtn.dataset.state === 'auto');
    type('hello'); screenBtn.onclick(); check('button: a click on the dark button forces it on', screenBtn.dataset.state === 'on' && takeScreenMode() === 'on');
    type('hello'); check('button: no choice and no pointer sends nothing special', takeScreenMode() === undefined);
    screenChip(bubble, { id: 's1', kind: 'image', title: 'Report', thumb: 'data:image/jpeg;base64,AA' });
    const chip = bubble.querySelector('.msg-screen');
    check('chip: "Included a screenshot of <title>" with a thumbnail and an x', chip && /chat.screen.image:Report/.test(chip.children[0].textContent) && chip.querySelector('.msg-screen-thumb') && chip.querySelector('.msg-screen-x'));
    screenChip(bubble, { id: 's2', kind: 'image', title: 'Again' });
    check('chip: one per message', bubble.children.length === 1);
    const x = chip.querySelector('.msg-screen-x');
    await x.onclick();
    check('chip: x asks main to drop it, then the chip says it is removed and loses its thumbnail', calls[0] === 's1' && chip.classes.has('removed') && /chat.screen.removed/.test(chip.children[0].textContent) && !chip.querySelector('.msg-screen-thumb') && !chip.querySelector('.msg-screen-x'));
    const b2 = new El('div'); screenChip(b2, { id: 'bad', kind: 'text', title: '' });
    const x2 = b2.querySelector('.msg-screen-x'); await x2.onclick();
    check('chip: a refused x (a run is going) leaves the chip as it was', !b2.querySelector('.msg-screen').classes.has('removed') && !x2.disabled && /chat.screen.text:chat.screen.untitled/.test(b2.querySelector('.msg-screen').children[0].textContent), b2.querySelector('.msg-screen').children[0].textContent);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
