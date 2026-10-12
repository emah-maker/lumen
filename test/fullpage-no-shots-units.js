// The full-page chat (lumen://chat) never sends a screenshot on its own, plain Node (no Electron, no network): a stubbed provider,
// a fake browser with a GitHub tab, a docs tab and the chat tab. The side panel keeps attaching the tab's picture when the words
// point at the screen; the screenshot tool in a full-page run needs a named tab and never takes the chat tab.
const providers = require('../src/ai/providers');
const { Agent } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const J = JSON.stringify;

const CHAT_URL = 'file:///C:/Lumen/resources/app/src/renderer/chat-page.html';
const urls = { 1: 'https://github.com/emah-maker/lumen', 2: 'https://docs.test/guide', 3: CHAT_URL };
const captured = []; // every capturePage() call: which tab was photographed
const fakeImage = { isEmpty: () => false, getSize: () => ({ width: 100, height: 50 }), resize() { return this; }, toJPEG: () => Buffer.from('jpeg-bytes'), toPNG: () => Buffer.from('png-bytes') };
const tabOf = (id) => ({
  id,
  webContents: {
    id: 100 + id, isDestroyed: () => false, getURL: () => urls[id], getTitle: () => `title ${id}`, getZoomFactor: () => 1,
    capturePage: async () => { captured.push(id); return fakeImage; },
    executeJavaScript: async () => ({ innerWidth: 100, innerHeight: 50, scrollX: 0, scrollY: 0 }),
    executeJavaScriptInIsolatedWorld: async () => ({ innerWidth: 100, innerHeight: 50, scrollX: 0, scrollY: 0 }),
  },
});
const state = { active: 3, openPages: [1, 2, 3] };
// (The real browser also keeps the chat tab away from the agent, main.js agentTabById; the guard in agent.js must hold without it.)
const browser = {
  activeTab: () => tabOf(state.active), tabById: (id) => (state.openPages.includes(id) ? tabOf(id) : null), listTabs: () => state.openPages.map((id) => ({ id, url: urls[id], title: `title ${id}` })),
  effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0, autoModel: () => false,
};
const make = () => {
  const agent = new Agent(browser, () => null, () => ({ model: 'openai:gpt-5.6', adhdMode: true, pageContext: true }), () => 'sk-test');
  agent.closeSignedInTabs = () => {};
  agent.newActionLog = () => ({});
  agent.undoSummary = () => null;
  agent.ensureAllowed = async () => {};
  agent.describeStep = async () => null;
  agent.pageContextFor = async () => '';
  return agent;
};
const hasImage = (req) => J(req).includes('image_url') || J(req).includes('"type":"image"') || J(req).includes('base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64').toString('base64');

(async () => {
  const realStream = providers.streamTurn;
  const sent = [];
  providers.streamTurn = async (opts) => { sent.push(opts); return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }; };
  try {
    const turn = async (text, { fullPage, images = [], active = 1, screen } = {}) => {
      const agent = make();
      state.active = active;
      const screenCalls = [];
      agent.screenCapture = async (tab) => {
        screenCalls.push(tab.id);
        return { image: { media_type: 'image/jpeg', data: 'c2hvdA==' }, blocks: [{ type: 'text', text: '<screen_capture id="s1" kind="image" title="t" url="u">x</screen_capture>' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'c2hvdA==' } }], chip: { id: 's1', kind: 'image', title: 'title', thumb: '' } };
      };
      const events = [];
      sent.length = 0;
      await agent.run(text, (e) => events.push(e), images, { screen, ...(fullPage ? { fullPage: true } : {}) });
      return { events, screenCalls, request: sent[0] || null };
    };

    // ---- full-page chat: no screenshot on any message, whatever the words or the camera button said
    for (const words of ['what is this?', 'fix this error on screen', 'what do you see here?']) {
      const r = await turn(words, { fullPage: true });
      check(`full page, "${words}": no capture, no picture in the request, no chip`, r.screenCalls.length === 0 && r.request && !hasImage(r.request.messages) && !r.events.some((e) => e.type === 'screen_attached'), J({ calls: r.screenCalls, events: r.events.map((e) => e.type) }));
    }
    {
      const r = await turn('what is this?', { fullPage: true, screen: 'on' });
      check('full page: even a "camera on" request attaches nothing', r.screenCalls.length === 0 && !hasImage(r.request.messages) && !r.events.some((e) => e.type === 'screen_attached'));
    }
    {
      const r = await turn('what is this?', { fullPage: true, active: 3 });
      check('full page, chat tab in front: the chat tab is not captured', r.screenCalls.length === 0 && captured.length === 0, J(r.screenCalls));
    }
    {
      const r = await turn('summarise our chat so far', { fullPage: true, images: [{ media_type: 'image/png', data: PNG }] });
      check('full page: a picture the user attached still goes', hasImage(r.request.messages) && r.screenCalls.length === 0, J(r.request.messages).slice(0, 200));
    }
    {
      const r = await turn('hello', { fullPage: true });
      const text = J(r.request.messages);
      check('full page: the turn says no screenshot is attached and that a named tab can be asked for', /full-page chat/.test(text) && /tab_id/.test(text), text.slice(0, 300));
    }

    // ---- side panel: unchanged
    {
      const r = await turn('what is this?', { fullPage: false });
      check('side panel, "what is this?": the tab\'s screenshot is captured and goes along with its chip', r.screenCalls.join() === '1' && hasImage(r.request.messages) && r.events.some((e) => e.type === 'screen_attached'), J({ calls: r.screenCalls, events: r.events.map((e) => e.type) }));
      check('side panel: no full-page note in the turn', !/full-page chat/.test(J(r.request.messages)));
    }
    {
      const r = await turn('what is this?', { fullPage: false, screen: 'off' });
      check('side panel: the camera button off still keeps it out', r.screenCalls.length === 0 && !hasImage(r.request.messages));
    }
    {
      const r = await turn('tell me a joke', { fullPage: false });
      check('side panel: a message with no pointing words carries no screenshot', r.screenCalls.length === 0 && !hasImage(r.request.messages));
    }

    // ---- the screenshot tool
    const inRun = (agent, fullPage, fn, tabId = 1) => agent.inTask(tabId, new AbortController().signal, fn, [], {}, { fullPage });
    {
      const agent = make();
      let err = null;
      await inRun(agent, true, async () => { try { await agent.runTool('screenshot', {}); } catch (e) { err = e; } });
      check('full page: screenshot with no tab_id is refused (no default reflex), and says how to ask', err && /needs tab_id/.test(err.message) && /list_tabs/.test(err.message), err?.message);
      check('full page: nothing was photographed for it', captured.length === 0, J(captured));
    }
    {
      const agent = make();
      let err = null;
      await inRun(agent, true, async () => { try { await agent.runTool('screenshot', { tab_id: 3 }); } catch (e) { err = e; } });
      check('full page: tab_id of the lumen://chat tab is refused', err && /chat page itself/.test(err.message), err?.message);
      check('full page: the chat tab was never photographed', !captured.includes(3), J(captured));
    }
    {
      const agent = make();
      let out = null;
      await inRun(agent, true, async () => { out = await agent.runTool('screenshot', { tab_id: 1 }); });
      check('full page: a tab the user named (tab_id) is photographed, and only that one', Array.isArray(out) && out[0]?.type === 'image' && captured.join() === '1', J({ out: out && out.map((b) => b.type), captured }));
      captured.length = 0;
    }
    {
      const agent = make();
      let err = null;
      await inRun(agent, false, async () => { try { await agent.runTool('screenshot', {}); } catch (e) { err = e; } }, 3);
      check('even outside full page, a run whose own tab is the chat page never captures it', err && /chat page itself/.test(err.message) && captured.length === 0, err?.message);
    }
    {
      const agent = make();
      let out = null;
      await inRun(agent, false, async () => { out = await agent.runTool('screenshot', {}); }, 2);
      check('side panel: screenshot with no tab_id still takes the run\'s tab', Array.isArray(out) && out[0]?.type === 'image' && captured.join() === '2', J(captured));
      captured.length = 0;
    }
  } finally { providers.streamTurn = realStream; }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
