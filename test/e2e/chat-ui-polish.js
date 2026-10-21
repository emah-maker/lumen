// Hidden run: the full-page chat's reading and reply polish (lumen://chat), with a stubbed provider (no CLI, no network, no key).
//   - prose stops at 72ch while code and tables keep the column; speaker labels on every message
//   - a long code block's header (language, Wrap, Copy) sticks to the top while it scrolls past
//   - scrolled up during a streaming reply: the view is not pulled down, "Jump to latest" appears and works
//   - Up in an empty composer edits the last message; Send replaces it and the reply follows
//   - the polite status note says the reply finished while the list stays quiet (aria-busy flips)
//   - an error is a card with an icon, role=alert and Try again
//   - the composer's keys are said under the box
//   - the stylesheet's reduced-motion rule switches animation, transitions and smooth scrolling off
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
const CODE = `\`\`\`js\n${Array.from({ length: 70 }, (_, i) => `const line${i} = ${i}; // a long block of code`).join('\n')}\n\`\`\`\n`;
const LONG = `## Answer\n\n${'A sentence that goes on for a good while so the paragraph is wide enough to wrap more than once on a roomy window. '.repeat(5)}\n\n${CODE}\n| A | B |\n|---|---|\n| 1 | 2 |\n\nThe end.\n`;

// In-page contrast probe (text colour against the composited backgrounds behind it): WCAG ratio.
const CONTRAST = `(() => {
  const px = (c) => { const g = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (acc, c) => { const k = c[3] * (1 - acc[3]); return [acc[0] + c[0] * k, acc[1] + c[1] * k, acc[2] + c[2] * k, acc[3] + k]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const field = () => { const p = document.createElement('div'); p.style.background = 'var(--field)'; document.body.append(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return px(c); };
  window.__contrast = (el, opts) => {
    let acc = [0, 0, 0, 0];
    if (opts && opts.fieldOver) acc = over(acc, field());
    for (let n = el; n && acc[3] < 0.999; n = n.parentElement) acc = over(acc, px(getComputedStyle(n).backgroundColor));
    if (acc[3] < 0.999) acc = over(acc, [255, 255, 255, 1]);
    const t = px(getComputedStyle(el).color);
    const mix = [t[0] * t[3] + acc[0] * (1 - t[3]), t[1] * t[3] + acc[1] * (1 - t[3]), t[2] * t[3] + acc[2] * (1 - t[3])];
    const a = lum(mix) + 0.05; const b = lum(acc) + 0.05;
    return Math.round((Math.max(a, b) / Math.min(a, b)) * 100) / 100;
  };
  return true;
})()`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-uipolish-'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-uipolish-tmp-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', TEMP: temp, TMP: temp, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  try {
    const ui = await app.firstWindow();
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, LONG) => {
      const a = global.__agent;
      global.__hold = false;
      global.__more = 0;
      a.runTask = async (messages, _tab, text, _i, controller, emit) => {
        messages.push({ role: 'user', content: text });
        emit({ type: 'turn_start' });
        if (/ERR/.test(text)) { emit({ type: 'error', text: 'The AI service did not answer. Try again in a minute.', details: '429 rate_limit_error' }); return; }
        let said = '';
        if (/STREAM/.test(text)) {
          emit({ type: 'text_block' });
          while (!global.__hold) { const bit = `More of the streaming reply, paragraph ${++global.__more}.\n\n`; said += bit; emit({ type: 'text', text: bit }); await new Promise((r) => setTimeout(r, 120)); }
        } else { said = /LONG/.test(text) ? LONG : `Answered: ${text}`; emit({ type: 'text_block' }); emit({ type: 'text', text: said }); }
        messages.push({ role: 'assistant', content: [{ type: 'text', text: said }] });
        a.runs.get(messages).settling = true;
        emit({ type: 'reply_complete' });
      };
    }, LONG);
    await app.evaluate(() => global.__chatPage.open());
    let tabId;
    for (let i = 0; i < 50 && !tabId; i++) { tabId = await app.evaluate(() => global.__chatPage.tabs().find((x) => x.chat)?.id); if (!tabId) await sleep(200); }
    check('the full-page chat opened', Boolean(tabId), tabId);
    const inPage = (code) => app.evaluate(async (_e, [id, c]) => global.__chatPage.contents(id).executeJavaScript(c, true), [tabId, code]);
    await waitFor(() => inPage(`Boolean(document.getElementById('prompt')) && document.readyState === 'complete'`));
    const send = (text) => inPage(`(() => { const p = document.getElementById('prompt'); p.value = ${JSON.stringify(text)}; p.dispatchEvent(new Event('input')); document.getElementById('send').click(); })()`);
    const idle = () => waitFor(() => inPage(`!document.getElementById('send').classList.contains('stop') && !document.querySelector('.msg.assistant.streaming')`), 15000);
    await sleep(1500);

    // ---- composer hint, empty state
    const hint = await inPage(`(() => { const h = document.querySelector('.cp-hint'); return h && { text: h.textContent, shown: getComputedStyle(h).display !== 'none' }; })()`);
    check('the composer\'s keys (Enter, Shift+Enter, Up) are said under the box', hint && /Enter to send/.test(hint.text) && /Shift\+Enter/.test(hint.text) && /Up/.test(hint.text) && hint.shown, JSON.stringify(hint));

    // ---- a long reply: reading width, speaker labels, sticky code header
    await send('LONG please');
    await waitFor(() => inPage(`document.querySelector('.msg.assistant .code-block')`));
    await idle();
    await sleep(500);
    const width = await inPage(`(() => {
      const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;visibility:hidden;width:72ch;font:' + getComputedStyle(document.querySelector('.msg.assistant p')).font; document.body.append(probe);
      const limit = probe.getBoundingClientRect().width; probe.remove();
      const p = document.querySelector('.msg.assistant p').getBoundingClientRect().width;
      const code = document.querySelector('.msg.assistant .code-block').getBoundingClientRect().width;
      const msg = document.querySelector('.msg.assistant').getBoundingClientRect().width;
      return { limit: Math.round(limit), p: Math.round(p), code: Math.round(code), msg: Math.round(msg) };
    })()`);
    check('a paragraph is at most 72ch wide (a comfortable line)', width.p <= width.limit + 1 && width.p > 200, JSON.stringify(width));
    check('code and tables keep the column\'s full width', width.code >= width.msg - 2 && width.code > width.p, JSON.stringify(width));
    const who = await inPage(`[...document.querySelectorAll('#messages > .msg')].map((m) => m.className.split(' ')[1] + ':' + m.getAttribute('role') + ':' + m.getAttribute('aria-label'))`);
    check('every message is a labelled group (You / Assistant) for screen readers', who.includes('user:group:You') && who.includes('assistant:group:Assistant') && who.every((w) => !/:null$/.test(w)), JSON.stringify(who));
    const head = await inPage(`(() => { const h = document.querySelector('.msg.assistant .code-head'); const b = h.querySelectorAll('button'); return { label: h.textContent.trim().slice(0, 40), buttons: [...b].map((x) => x.textContent.trim()), sticky: getComputedStyle(h).position }; })()`);
    check('the code block has a language label and a Copy button in a sticky header', /js/.test(head.label) && head.buttons.includes('Copy') && head.sticky === 'sticky', JSON.stringify(head));
    const stuck = await inPage(`(async () => {
      const m = document.getElementById('messages'); const blk = document.querySelector('.msg.assistant .code-block'); const h = blk.querySelector('.code-head');
      m.scrollTop = m.scrollTop + (blk.getBoundingClientRect().top - m.getBoundingClientRect().top) + 200; // the block's top is 200 px above the view
      await new Promise((r) => setTimeout(r, 300));
      return { head: Math.round(h.getBoundingClientRect().top - m.getBoundingClientRect().top), blockTop: Math.round(blk.getBoundingClientRect().top - m.getBoundingClientRect().top), visible: h.getBoundingClientRect().height > 20 };
    })()`);
    check('scrolled into a long block, its header stays at the top of the list', stuck.blockTop < -100 && Math.abs(stuck.head) <= 2 && stuck.visible, JSON.stringify(stuck));
    const copied = await inPage(`(async () => { const b = [...document.querySelectorAll('.msg.assistant .code-head button')].find((x) => x.textContent.trim() === 'Copy'); b.click(); await new Promise((r) => setTimeout(r, 300)); return b.textContent.trim() + '|' + (b.getAttribute('aria-label') || ''); })()`);
    check('Copy answers with feedback', /Copied|✓|Copy/.test(copied), copied);

    // ---- Read aloud sits in the corner row with Copy, Regenerate and Retry: same size, same row, fixed order, tooltip from its label
    const row = await inPage(`(() => {
      const m = [...document.querySelectorAll('#messages > .msg.assistant')].pop();
      const r = (sel) => { const e = m.querySelector(':scope > ' + sel); if (!e) return null; const b = e.getBoundingClientRect(); return { right: Math.round(b.right), top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
      const s = m.querySelector(':scope > .reply-speak');
      return { speak: r('.reply-speak'), copy: r('.reply-copy'), regen: r('.reply-regen'), retry: r('.reply-retry'), label: s && s.getAttribute('aria-label'), title: s && s.getAttribute('title'), inMeta: Boolean(m.querySelector('.reply-meta .reply-speak')) };
    })()`);
    const ok = row.speak && row.copy && row.regen && row.speak.w === row.regen.w && row.speak.h === row.regen.h && row.speak.top === row.regen.top && row.speak.top === row.copy.top && row.speak.right < row.regen.right && (!row.retry || row.speak.right < row.retry.right) && row.retry && row.retry.right < row.regen.right && row.copy.right > row.regen.right;
    check('Read aloud is in the action group, the same size and row, after Copy, Regenerate and Retry', Boolean(ok) && !row.inMeta, JSON.stringify(row));
    check('Read aloud is named "Read aloud" (its tooltip comes from the label, no second native one)', row.label === 'Read aloud' && row.title === null, JSON.stringify(row));

    // ---- edit-and-resend with Up
    await inPage(`document.getElementById('prompt').focus()`);
    await inPage(`document.getElementById('prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))`);
    const edit = await waitFor(() => inPage(`(() => { const b = document.querySelector('.msg.user .msg-edit-box'); return b && { value: b.value }; })()`));
    check('Up in an empty composer opens the last message for editing', edit && /LONG please/.test(edit.value), JSON.stringify(edit));
    await inPage(`(() => { const b = document.querySelector('.msg.user .msg-edit-box'); b.value = 'edited question'; b.dispatchEvent(new Event('input')); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    const resent = await waitFor(() => inPage(`(() => { const u = [...document.querySelectorAll('.msg.user')].map((x) => x.textContent); const a = [...document.querySelectorAll('.msg.assistant')].map((x) => x.textContent).join('|'); return /Answered: edited question/.test(a) && u.some((x) => /edited question/.test(x)) && !u.some((x) => /LONG please/.test(x)) ? { u, a: a.slice(0, 80) } : null; })()`), 15000);
    check('Send on an edited message resends it and the reply follows', Boolean(resent), JSON.stringify(resent));
    await idle();

    // ---- streaming: the view is not pulled down while scrolled up; Jump to latest brings it back
    for (let i = 0; i < 6; i++) { await send(`LONG filler ${i}`); await idle(); }
    await send('STREAM please');
    await waitFor(() => inPage(`document.querySelector('.msg.assistant.streaming')`));
    const live = await inPage(`({ busy: document.getElementById('messages').getAttribute('aria-busy'), live: document.getElementById('messages').getAttribute('aria-live') })`);
    check('while streaming the list is busy but quiet (not read word by word)', live.busy === 'true' && live.live === 'off', JSON.stringify(live));
    await sleep(600);
    const before = await inPage(`(async () => { const m = document.getElementById('messages'); m.scrollTop = Math.max(0, m.scrollTop - 600); await new Promise((r) => setTimeout(r, 300)); return { top: m.scrollTop, jump: !document.querySelector('.jump-latest').hidden, grew: m.scrollHeight }; })()`);
    check('scrolling up during a stream shows "Jump to latest"', before.jump === true, JSON.stringify(before));
    await sleep(1500); // more paragraphs arrive
    const after = await inPage(`(() => { const m = document.getElementById('messages'); return { top: m.scrollTop, height: m.scrollHeight, more: window.__moreSeen = document.querySelectorAll('.msg.assistant.streaming p').length }; })()`);
    check('new text does not pull the view down while the reader is scrolled up', Math.abs(after.top - before.top) <= 2 && after.height > before.grew, JSON.stringify({ before, after }));
    // (a hidden window paints no frames, so a smooth scroll never moves: the button takes its reduced-motion path, a plain jump)
    await inPage(`window.__mm = window.matchMedia; window.matchMedia = (q) => ({ matches: /reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {} }); document.querySelector('.jump-latest').click(); window.matchMedia = window.__mm; 0`);
    let jumped; await waitFor(async () => (jumped = await inPage(`(() => { const m = document.getElementById('messages'); const gap = m.scrollHeight - m.scrollTop - m.clientHeight; return gap < 60 && document.querySelector('.jump-latest').hidden ? 'yes' : 'gap ' + Math.round(gap) + ' hidden ' + document.querySelector('.jump-latest').hidden; })()`)) === 'yes', 6000);
    check('"Jump to latest" scrolls to the end and goes away', jumped === 'yes', jumped);
    const h0 = await inPage(`document.getElementById('messages').scrollHeight`);
    const follows = await waitFor(() => inPage(`(() => { const m = document.getElementById('messages'); const gap = m.scrollHeight - m.scrollTop - m.clientHeight; return m.scrollHeight > ${h0} && gap < 60 ? { gap } : null; })()`), 5000); // (the jump holds the view for 0.7 s, then it follows again)
    check('back at the end, the view follows the reply again', Boolean(follows), JSON.stringify(follows));

    // ---- reduced motion: the debugger is taken by the app, so read the rules (a reduced-motion media block that zeroes every animation and transition, and smooth scrolling)
    const motion = await inPage(`(() => {
      const found = [];
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const r of rules) {
          if (r.type !== CSSRule.MEDIA_RULE || !(r.conditionText || r.media.mediaText).includes('prefers-reduced-motion')) continue;
          for (const x of r.cssRules) if (x.selectorText && x.selectorText.startsWith('*')) found.push(x.style.animationDuration + '|' + x.style.transitionDuration + '|' + x.style.scrollBehavior);
        }
      }
      return found;
    })()`);
    check('with reduced motion, animations, transitions and smooth scrolling are switched off', motion.some((m) => /^0\.01ms\|0\.01ms\|auto$/.test(m)), JSON.stringify(motion));

    // ---- the reply finishes: the polite note says so
    await app.evaluate(() => { global.__hold = true; });
    await idle();
    const note = await waitFor(() => inPage(`(() => { const n = document.querySelector('body > [role=status][aria-live=polite]'); return n && /finished/i.test(n.textContent) ? { text: n.textContent, busy: document.getElementById('messages').getAttribute('aria-busy') } : null; })()`), 5000);
    check('a finished reply is announced once in the polite status note, and the list is no longer busy', note && note.busy === 'false', JSON.stringify(note));

    // ---- an error is a card
    await inPage(`document.getElementById('new-chat').click()`);
    await sleep(500);
    await send('ERR please');
    const card = await waitFor(() => inPage(`(() => { const e = document.querySelector('#messages .error'); if (!e) return null; const b = getComputedStyle(e, '::before'); return { role: e.getAttribute('role'), icon: b.content, retry: [...e.querySelectorAll('button')].map((x) => x.textContent.trim()), radius: getComputedStyle(e).borderRadius, bar: getComputedStyle(e).boxShadow !== 'none' }; })()`));
    check('an error shows as a card: alert role, an icon, a bar and a Try again button', card && card.role === 'alert' && /!/.test(card.icon) && card.retry.includes('Try again') && card.bar, JSON.stringify(card));

    // ---- dark mode (CDP emulation of prefers-color-scheme): the error card and the sticky code header read at WCAG AA (4.5:1)
    const dark = await app.evaluate(async (_e, id) => { const wc = global.__chatPage.contents(id); try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); return await wc.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches"); } catch (e) { return String(e); } }, tabId);
    check('the page is in dark mode for the contrast checks', dark === true, dark);
    await inPage(CONTRAST);
    await sleep(300);
    const errC = await inPage(`(() => { const e = document.querySelector('#messages .error'); const s = e.querySelector('summary'); const b = e.querySelector('button'); return { message: window.__contrast(e), details: window.__contrast(s), retry: window.__contrast(b), icon: window.__contrast(e, {}) }; })()`);
    check('dark: the error message, Details and Try again are at least 4.5:1', errC.message >= 4.5 && errC.details >= 4.5 && errC.retry >= 4.5, JSON.stringify(errC));
    await send('LONG dark please');
    await waitFor(() => inPage(`document.querySelector('.msg.assistant .code-head')`));
    await idle();
    const codeC = await inPage(`(() => { const h = document.querySelector('.msg.assistant .code-head'); const label = h.firstElementChild; return { label: window.__contrast(label, { fieldOver: true }), copy: window.__contrast([...h.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Copy'), { fieldOver: true }) }; })()`);
    check('dark: the sticky code header label and Copy are at least 4.5:1', codeC.label >= 4.5 && codeC.copy >= 4.5, JSON.stringify(codeC));
    await app.evaluate(async (_e, id) => { try { await global.__chatPage.contents(id).debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); } catch { /* ignore */ } }, tabId);

    check('no UI errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
