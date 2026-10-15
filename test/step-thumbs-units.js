// Plain Node: the Browser card's thumbnail scheduling (features/step-thumbs.js), with a fake capture and short timers.
const { createThumbs, isNavigation } = require('../src/features/step-thumbs');
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig(opts = {}) {
  const sent = [];
  let n = 0;
  let inflightMax = 0;
  let inflight = 0;
  const flags = { light: false, visible: true, same: false };
  const thumbs = createThumbs({
    capture: async () => { inflight++; inflightMax = Math.max(inflightMax, inflight); await sleep(5); inflight--; return { data: flags.same ? 'SAME' : `frame${++n}`, url: 'http://x/', title: 't', tabId: 1 }; },
    send: (e) => sent.push(e),
    light: () => flags.light, visible: () => flags.visible, intervalMs: 40, settleMs: 10, ...opts,
  });
  return { thumbs, sent, flags, inflightMax: () => inflightMax };
}

(async () => {
  {
    const r = rig();
    r.thumbs.activity();
    await sleep(200);
    r.thumbs.stop();
    await sleep(30); // (a capture already under way still lands, as the last frame)
    const after = r.sent.length;
    check('a run refreshes on a clock, starting with a first frame', after >= 3 && r.sent[0].type === 'thumb' && r.sent[0].tabId === 1, String(after));
    await sleep(120);
    check('after stop nothing more is captured', r.sent.length === after, `${r.sent.length} vs ${after}`);
    check('never two captures at once', r.inflightMax() === 1, String(r.inflightMax()));
  }
  {
    const r = rig({ intervalMs: 5000 });
    r.thumbs.activity();
    await sleep(60);
    const first = r.sent.length;
    r.thumbs.settled(false);
    await sleep(60);
    check('a finished step refreshes the frame soon after (a click or a load)', first === 1 && r.sent.length === 2, `${first} -> ${r.sent.length}`);
    r.thumbs.stop();
  }
  {
    const r = rig();
    r.flags.visible = false;
    r.thumbs.activity();
    await sleep(150);
    check('hidden or scrolled away: nothing is captured, not even a first frame', r.sent.length === 0, String(r.sent.length));
    r.flags.visible = true;
    await sleep(120);
    check('…and it resumes when the card is seen again', r.sent.length >= 1, String(r.sent.length));
    r.thumbs.stop();
  }
  {
    const r = rig();
    r.flags.light = true;
    r.thumbs.activity();
    await sleep(150);
    const first = r.sent.length;
    check('Light graphics: the first frame only, never the clock', first === 1, String(first));
    r.thumbs.settled(false);
    await sleep(60);
    check('Light graphics: a click that did not change the page adds nothing', r.sent.length === first, String(r.sent.length));
    r.thumbs.settled(true);
    await sleep(60);
    check('Light graphics: a navigation refreshes it', r.sent.length === first + 1, String(r.sent.length));
    r.thumbs.stop();
  }
  {
    const r = rig();
    r.flags.same = true;
    r.thumbs.activity();
    await sleep(200);
    check('a frame equal to the last one is not sent again', r.sent.length === 1, String(r.sent.length));
    r.thumbs.stop();
  }
  {
    const sent = [];
    const t = createThumbs({ capture: async () => { throw new Error('tab gone'); }, send: (e) => sent.push(e), intervalMs: 20, settleMs: 5 });
    t.activity();
    await sleep(100);
    check('a failed capture is skipped quietly and tried again', sent.length === 0, String(sent.length));
    t.stop();
  }
  check('navigation tools are told apart from clicks', isNavigation('navigate') && isNavigation('go_back') && isNavigation('mcp__lumen__open_tab') && !isNavigation('click') && !isNavigation('read_page'), '');

  // wiring: main starts it per run, gates it on the chat's report, and the chat reports visibility
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
  const main = read('src/main.js');
  check('main notes every run event for the thumbnailer and stops it at done', /noteThumbs\(run, msg,/.test(main) && /msg\.type === 'done'\) run\.thumbs\?\.stop\(\)/.test(main), '');
  check('Light graphics and software drawing refresh on navigation only', /light: \(\) => graphicsMode\.light\(\) \|\| app\.isHardwareAccelerationEnabled\?\.\(\) === false/.test(main), '');
  check('the thumbnail respects the sites the AI may not read', /aiSites\.isOff\(url\)/.test(main), '');
  check('the new calls are gated (UI and chat page only)', /'agent:thumbs-visible', 'agent:open-preview'/.test(main) && /'agent:thumbs-visible', 'agent:open-preview'/.test(read('src/features/chat-page.js')), '');
  check('both preloads expose openPreview and thumbsVisible', ['src/preload/preload.js', 'src/features/chat-preload.js'].every((f) => /openPreview/.test(read(f)) && /thumbsVisible/.test(read(f))), '');
  const ui = read('src/renderer/step-ui.js');
  check('the chat reports a card on screen with an IntersectionObserver and the page visibility', /IntersectionObserver/.test(ui) && /visibilitychange/.test(ui) && /thumbsVisible/.test(ui), '');
  check('a saved chat keeps one small final frame (≤ 60 KB as base64 text)', /THUMB_CHARS = 90000/.test(read('src/features/chat-branches.js')) && /maxBytes = 45000/.test(read('src/features/tab-capture.js')), '');
  check('chats saved before cards fall back to the old rows', /item\.cards && window\.stepUI/.test(read('src/renderer/chat-actions.js')), '');

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
