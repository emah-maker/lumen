// Hidden run: an AI reply with an inline SVG is drawn as a picture, in the full-page chat (lumen://chat), with a stubbed provider
// (no CLI, no network, no key). The stub streams the exact diagram from the bug report in a ```svg fence:
//   - while </svg> has not arrived it is code (no picture), then it swaps to an <img> with a data: URL, natural size 240x240, pixels drawn
//   - the Code toggle shows the source and brings the picture back; Copy and PNG are there; clicking the picture opens the viewer
//   - a raw <svg>…</svg> in the text (no fence) is drawn too
//   - a hostile SVG (<script>, onload, foreignObject with onerror, external image) runs nothing: no global, no console line, nothing inline
//   - the picture sits on a light panel in dark mode; svg-view.js is not loaded before the first SVG
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DIAGRAM, EVIL } = require('./_svg-fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
const FENCE = '```';

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-svgview-'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-svgview-tmp-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', TEMP: temp, TMP: temp, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, [diagram, evil]) => {
      const a = global.__agent;
      global.__svgHold = false;
      a.runTask = async (messages, _tab, text, _i, controller, emit) => {
        messages.push({ role: 'user', content: text });
        emit({ type: 'turn_start' });
        let said = '';
        const say = async (bit, wait = 0) => { said += bit; emit({ type: 'text', text: bit }); if (wait) await new Promise((r) => setTimeout(r, wait)); };
        emit({ type: 'text_block' });
        if (/STREAMED/.test(text)) {
          const body = `Here is the diagram:\n\n${'```'}svg\n${diagram}\n${'```'}\n\nThat is the element.\n`;
          const cut = body.indexOf('<line');
          for (let i = 0; i < cut; i += 30) await say(body.slice(i, Math.min(cut, i + 30)), 25);
          while (global.__svgHold) await new Promise((r) => setTimeout(r, 50)); // (the test looks at the half-written block)
          for (let i = cut; i < body.length; i += 30) await say(body.slice(i, Math.min(body.length, i + 30)), 25);
        } else if (/EVILFENCE/.test(text)) await say(`Look:\n\n${'```'}svg\n${evil}\n${'```'}\n`);
        else if (/EVILRAW/.test(text)) await say(`Look:\n${evil}\nOK.`);
        else if (/RAW/.test(text)) await say(`Here it is, as raw markup:\n${diagram}\nDone.`);
        else await say(`Answered: ${text}`);
        messages.push({ role: 'assistant', content: [{ type: 'text', text: said }] });
        a.runs.get(messages).settling = true;
        emit({ type: 'reply_complete' });
      };
    }, [DIAGRAM, EVIL]);
    await app.evaluate(() => global.__chatPage.open());
    let tabId;
    for (let i = 0; i < 50 && !tabId; i++) { tabId = await app.evaluate(() => global.__chatPage.tabs().find((x) => x.chat)?.id); if (!tabId) await sleep(200); }
    check('the full-page chat opened', Boolean(tabId), tabId);
    const inPage = (code) => app.evaluate(async (_e, [id, c]) => global.__chatPage.contents(id).executeJavaScript(c, true), [tabId, code]);
    await waitFor(() => inPage(`Boolean(document.getElementById('prompt')) && document.readyState === 'complete'`));
    const send = (text) => inPage(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('send').click(); })()`);
    const idle = () => waitFor(() => inPage(`!document.getElementById('send').classList.contains('stop') && !document.querySelector('.msg.assistant.streaming')`), 20000);
    await sleep(1500);
    // every console line and every pageerror of the chat page, kept apart from what the assertions read
    await inPage(`(() => { window.__lines = []; for (const k of ['log', 'info', 'warn', 'error']) { const o = console[k].bind(console); console[k] = (...a) => { window.__lines.push(a.join(' ')); o(...a); }; } window.addEventListener('error', (e) => window.__lines.push('ERR ' + e.message)); return true; })()`);
    check('svg-view.js is not loaded before the first SVG', await inPage(`typeof window.svgView === 'undefined'`), '');

    // ---- streamed in a ```svg fence
    await inPage(`window.__imgsAdded = 0; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches?.('.svg-view img') || n.querySelector?.('.svg-view img'))) window.__imgsAdded++; }).observe(document.getElementById('messages'), { childList: true, subtree: true }); true`);
    await app.evaluate(() => { global.__svgHold = true; });
    await send('STREAMED please');
    const half = await waitFor(() => inPage(`(() => { const c = document.querySelector('.msg.assistant.streaming .code-block pre code'); return c && c.textContent.includes('<rect') && !c.textContent.includes('</svg>') ? c.textContent.length : 0; })()`), 15000);
    check('while the SVG is half written it is code', Boolean(half), half);
    const mid = await inPage(`({ pic: document.querySelectorAll('.svg-view, .svg-view img').length, lang: document.querySelector('.msg.assistant .code-lang')?.textContent, pre: getComputedStyle(document.querySelector('.msg.assistant .code-block pre')).display })`);
    check('no picture yet; the block says svg and shows its code', mid.pic === 0 && mid.lang === 'svg' && mid.pre !== 'none', JSON.stringify(mid));
    await app.evaluate(() => { global.__svgHold = false; });
    const pic = await waitFor(() => inPage(`document.querySelector('.msg.assistant .svg-view img') ? true : false`), 15000);
    check('once </svg> arrives it swaps to the picture', Boolean(pic), pic);
    await idle();
    await sleep(500);
    const shown = await inPage(`(async () => {
      const img = document.querySelector('.msg.assistant .svg-view img');
      if (!img) return null;
      await img.decode().catch(() => {});
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let drawn = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) drawn++;
      const box = img.closest('.code-block');
      return { src: img.src.slice(0, 28), nw: img.naturalWidth, nh: img.naturalHeight, drawn, pre: getComputedStyle(box.querySelector('pre')).display, buttons: [...box.querySelectorAll('.code-head button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.textContent.trim()), count: document.querySelectorAll('.msg.assistant .svg-view').length, inline: document.querySelectorAll('.msg.assistant .svg-view svg').length };
    })()`);
    check('it is an <img> with a data: SVG source', shown && /^data:image\/svg\+xml/.test(shown.src), JSON.stringify(shown));
    check('natural size is 240 x 240', shown && shown.nw === 240 && shown.nh === 240, JSON.stringify(shown));
    check('pixel probe: the picture has drawn pixels', shown && shown.drawn > 2000, JSON.stringify(shown));
    check('the code is behind the picture; header has Code, PNG, Copy; one picture only; nothing inlined', shown && shown.pre === 'none' && shown.buttons.includes('Code') && shown.buttons.includes('PNG') && shown.buttons.includes('Copy') && !shown.buttons.includes('Wrap') && shown.count === 1 && shown.inline === 0, JSON.stringify(shown));
    const added = await inPage(`window.__imgsAdded`);
    check('the picture was not redrawn on every token (no flicker)', added >= 1 && added <= 8, added);
    const stats = await inPage(`(() => { const r = document.querySelector('.msg.assistant .svg-view img').getBoundingClientRect(); const m = document.querySelector('.msg.assistant').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), msg: Math.round(m.width) }; })()`);
    check('it shows at 240 x 240 and never wider than the reply', stats.w === 240 && stats.h === 240 && stats.w <= stats.msg, JSON.stringify(stats));
    check('svg-view.js loaded on demand', await inPage(`typeof window.svgView === 'object'`), '');

    // ---- the Code toggle
    const toggled = await inPage(`(async () => {
      const box = document.querySelector('.msg.assistant .svg-ok');
      const t = [...box.querySelectorAll('.code-head button')].find((b) => b.textContent.trim() === 'Code');
      t.click(); await new Promise((r) => setTimeout(r, 100));
      const code = { pre: getComputedStyle(box.querySelector('pre')).display, text: box.querySelector('pre code').textContent, view: getComputedStyle(box.querySelector('.svg-view')).display, label: t.textContent.trim(), wrap: !!getComputedStyle([...box.querySelectorAll('.code-wrap')][0]).display.replace('none', '') };
      t.click(); await new Promise((r) => setTimeout(r, 100));
      const back = { pre: getComputedStyle(box.querySelector('pre')).display, view: getComputedStyle(box.querySelector('.svg-view')).display, label: t.textContent.trim() };
      return { code, back };
    })()`);
    check('Code shows the source (with the unicode label and the markers), hides the picture, and the button reads Picture', toggled.code.pre !== 'none' && toggled.code.view === 'none' && /τ = 9000 psi/.test(toggled.code.text) && /<marker/.test(toggled.code.text) && toggled.code.label === 'Picture', JSON.stringify(toggled));
    check('Wrap is there with the code; clicking again brings the picture back', toggled.code.wrap && toggled.back.pre === 'none' && toggled.back.view !== 'none' && toggled.back.label === 'Code', JSON.stringify(toggled));

    // ---- click to enlarge
    await inPage(`document.querySelector('.msg.assistant .svg-pic').click(); true`);
    const viewer = await waitFor(() => inPage(`(() => { const v = document.querySelector('.civ'); const im = v && v.querySelector('.civ-img'); return im && im.naturalWidth > 0 ? { w: im.naturalWidth, src: im.src.slice(0, 22) } : null; })()`), 8000);
    check('clicking the picture opens it larger in the image viewer (as a PNG)', viewer && /^data:image\/png/.test(viewer.src) && viewer.w >= 240, JSON.stringify(viewer));
    await inPage(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await waitFor(() => inPage(`!document.querySelector('.civ')`), 4000);

    // ---- dark mode: the panel stays light
    await inPage(`document.documentElement.dataset.theme = 'dark'; true`);
    const panel = await inPage(`(() => { const c = getComputedStyle(document.querySelector('.msg.assistant .svg-view')).backgroundColor.match(/\\d+/g).map(Number); return { rgb: c, light: (c[0] + c[1] + c[2]) / 3 > 200 }; })()`);
    check('in dark mode the picture sits on a light panel', panel.light, JSON.stringify(panel));
    await inPage(`delete document.documentElement.dataset.theme; true`);

    // ---- raw <svg> in the text
    await send('RAW please');
    const raw = await waitFor(() => inPage(`(() => { const m = [...document.querySelectorAll('.msg.assistant')].find((x) => /as raw markup/.test(x.textContent)); const im = m && m.querySelector('.svg-view img'); return im ? { lang: m.querySelector('.code-lang')?.textContent, before: !!m.querySelector('p'), after: /Done\\./.test(m.textContent) } : null; })()`), 15000);
    await idle();
    check('a raw <svg> in the text is drawn as a picture, with the prose around it', raw && raw.lang === 'svg' && raw.before && raw.after, JSON.stringify(raw));

    // ---- hostile SVG, as a fence and as raw markup
    for (const [word, label] of [['EVILFENCE', 'in a ```svg fence'], ['EVILRAW', 'as raw markup']]) {
      await send(`${word} please`);
      const seen = await waitFor(() => inPage(`(() => { const ms = [...document.querySelectorAll('.msg.assistant')]; const m = ms[ms.length - 1]; return /Look:/.test(m.textContent) && m.querySelector('.svg-view img') ? true : false; })()`), 15000);
      await idle();
      await sleep(600);
      const bad = await inPage(`(async () => {
        const ms = [...document.querySelectorAll('.msg.assistant')]; const m = ms[ms.length - 1];
        const img = m.querySelector('.svg-view img');
        await (img && img.decode().catch(() => {}));
        const src = img ? decodeURIComponent(img.src.split(',').slice(1).join(',')) : '';
        return { pwned: window.__svgPwned, lines: window.__lines.filter((l) => /svg-script-ran|__svgPwned/.test(l)), srcHasScript: /script|foreignObject|onload|onclick|onerror|example\\.invalid/i.test(src), safeLabel: src.includes('safe label'), inline: m.querySelectorAll('.svg-view svg, svg rect, svg line, svg text, script, foreignObject, iframe').length, extScripts: document.querySelectorAll('script[src*="evil"]').length, w: img && img.naturalWidth };
      })()`);
      check(`a hostile SVG ${label} is drawn without its script`, seen && bad.w === 120 && bad.safeLabel && !bad.srcHasScript, JSON.stringify(bad));
      check(`...and nothing ran ${label}: no global, no console line, nothing inline`, bad.pwned === undefined && bad.lines.length === 0 && bad.inline === 0, JSON.stringify(bad));
    }
    const errors = await inPage(`window.__lines.filter((l) => /^ERR /.test(l))`);
    check('no page errors', errors.length === 0, JSON.stringify(errors));
  } catch (e) {
    failures++;
    console.log('FAIL  test crashed: ' + (e && e.stack || e));
  } finally {
    await app.close().catch(() => {});
    for (const d of [profile, temp]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
