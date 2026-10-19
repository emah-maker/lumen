// The device chooser in a real Lumen (WebHID / WebUSB / Web Serial; features/device-chooser.js), in a hidden window with a
// throwaway profile. Run with LUMEN_TEST_BACKGROUND=1 so nothing is shown or takes focus. SHOTS=<dir> saves screenshots
// of the chooser (light and dark, with devices and empty).
//   - navigator.hid / usb / serial exist on an http://127.0.0.1 page (a secure context);
//   - a real navigator.hid.requestDevice() (no HID device in CI: an empty list) opens the chooser with "No compatible
//     devices found"; Esc cancels it and the page's promise resolves with no devices;
//   - a synthetic select-hid-device event with fake devices: the chooser lists them (a security key is left out), a
//     device plugged in while it is open appears, a script's click does nothing, a real click on a row + Connect calls
//     back with the right deviceId, and the choice is remembered per origin in settings.json;
//   - Cancel and Esc call back with no arguments; USB and serial words; a request from an AI-opened tab never shows.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>device test</title><body>device test</body>'); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-devices-'));
  const shots = process.env.SHOTS || '';
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const waitFor = async (fn, ms = 8000, step = 100) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; };

  try {
    await app.evaluate(async (_e, u) => {
      const wc = global.__agent.browser.activeTab().webContents;
      for (let n = 0; n < 3; n++) { try { await wc.loadURL(u); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
    }, url);
    const page = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c, true), code);
    // The chooser's own page (features/dialogs.js overlay).
    const overlay = (code) => app.evaluate(async ({ webContents }, c) => {
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && /dialog\.html/.test(w.getURL()));
      return wc ? wc.executeJavaScript(c) : null;
    }, code);
    const kind = () => app.evaluate(() => global.__dialogs.currentKind());
    // The chooser is open and its page has drawn it (the overlay loads once, the first time any dialog shows).
    const opened = async () => { if ((await waitFor(async () => (await kind()) === 'devices')) !== true) return false; return Boolean(await waitFor(() => overlay("document.getElementById('message').textContent"))); };
    const rows = () => overlay(`[...document.querySelectorAll('.device')].map(r => ({ name: r.querySelector('.d-name').textContent, id: r.querySelector('.d-id')?.textContent || '', selected: r.getAttribute('aria-selected') }))`);
    const text = () => overlay(`({ message: document.getElementById('message').textContent, empty: document.getElementById('devices-empty').hidden ? '' : document.getElementById('devices-empty').textContent, listHidden: document.getElementById('devices').hidden, buttons: [...document.querySelectorAll('#buttons .btn')].map(b => ({ text: b.textContent, disabled: b.disabled })) })`);
    // A real mouse click / key in the chooser (sendInputEvent makes trusted events; el.click() from a script does not).
    const realClick = (selector) => app.evaluate(async ({ webContents }, sel) => {
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && /dialog\.html/.test(w.getURL()));
      const r = await wc.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
      wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
      wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    }, selector);
    const realKey = (keyCode) => app.evaluate(async ({ webContents }, k) => {
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && /dialog\.html/.test(w.getURL()));
      wc.sendInputEvent({ type: 'keyDown', keyCode: k });
      wc.sendInputEvent({ type: 'keyUp', keyCode: k });
    }, keyCode);
    const shot = async (name, theme) => {
      await app.evaluate(async ({ webContents }, th) => { const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && /dialog.html/.test(w.getURL())); if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: th }] }); }, theme);
      await sleep(500);
      const b64 = await app.evaluate(async ({ webContents }) => {
        const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && /dialog\.html/.test(w.getURL()));
        const img = await wc.capturePage();
        return img.toPNG().toString('base64');
      });
      if (shots) fs.writeFileSync(path.join(shots, `${name}-${theme}.png`), Buffer.from(b64, 'base64'));
      return b64.length;
    };
    const fire = (type, devices, extra = '') => app.evaluate(({ session }, [ty, list]) => {
      const ses = session.defaultSession;
      const wc = global.__agent.browser.activeTab().webContents;
      global.__spy = [];
      const cb = (...a) => global.__spy.push(a);
      const event = { preventDefault() { global.__prevented = true; } };
      global.__prevented = false;
      if (ty === 'serial') ses.emit('select-serial-port', event, list, wc, cb);
      else ses.emit(`select-${ty}-device`, event, { deviceList: list, frame: wc.mainFrame }, cb);
    }, [type, devices]);
    const spy = () => app.evaluate(() => global.__spy);

    const HID = (over) => ({ deviceId: 'h1', name: 'AULA F75', vendorId: 0x0C45, productId: 0x8006, serialNumber: 'SN1', collections: [{ usagePage: 1, usage: 6 }], ...over });
    const KEY = { deviceId: 'k1', name: 'Security Key', vendorId: 0x1050, productId: 0x0407, collections: [{ usagePage: 0xF1D0, usage: 1 }] };

    // ---- the APIs exist
    const apis = await page(`({ hid: typeof navigator.hid, usb: typeof navigator.usb, serial: typeof navigator.serial, secure: isSecureContext })`);
    check('page: navigator.hid, usb and serial exist on a secure 127.0.0.1 page', apis.secure && apis.hid === 'object' && apis.usb === 'object' && apis.serial === 'object', JSON.stringify(apis));

    // ---- a real requestDevice(): no device in CI, so the chooser's empty state
    await page(`window.__req = navigator.hid.requestDevice({ filters: [{ vendorId: 0x0C45 }] }).then((list) => 'devices:' + list.length, (e) => e.name); 0`);
    check('real request: the chooser opens', await opened(), await kind());
    let t = await text();
    check('real request: names the site and says no devices', /^127\.0\.0\.1:\d+ wants to connect to a HID device$/.test(t.message) && t.empty === 'No compatible devices found' && t.listHidden, JSON.stringify(t));
    check('real request: Connect is disabled with nothing to pick', t.buttons.length === 2 && t.buttons[0].text === 'Cancel' && t.buttons[1].text === 'Connect' && t.buttons[1].disabled, JSON.stringify(t.buttons));
    if (shots) await shot('empty', 'light');
    await realKey('Escape');
    check('real request: Esc closes it', await waitFor(async () => (await kind()) === null), await kind());
    check('real request: the page\'s promise resolves with no devices (WebHID\'s answer to a cancel)', (await waitFor(() => page('window.__req'), 5000)) === 'devices:0', await page('window.__req'));

    // ---- synthetic event with fake devices
    await fire('hid', [HID(), KEY, HID({ deviceId: 'h2', name: '', productId: 0x1234, serialNumber: 'SN2' })]);
    check('synthetic: the event is taken over', await app.evaluate(() => global.__prevented), '');
    check('synthetic: the chooser opens', await opened(), await kind());
    let list = await rows();
    check('synthetic: lists the devices (security key left out, unnamed = Unknown device)', list.length === 2 && list[0].name === 'AULA F75' && list[0].id === '0C45:8006' && list[1].name === 'Unknown device' && list[1].id === '0C45:1234', JSON.stringify(list));
    t = await text();
    check('synthetic: Connect waits for a choice', t.buttons[1].disabled && t.empty === '', JSON.stringify(t));
    await app.evaluate(({ session }, device) => {
      const wc = global.__agent.browser.activeTab().webContents;
      session.defaultSession.emit('hid-device-added', { preventDefault() {} }, { device, frame: wc.mainFrame });
    }, HID({ deviceId: 'h3', name: 'Late Arrival', productId: 0x2222, serialNumber: 'SN3' }));
    await sleep(200);
    list = await rows();
    check('live: a device plugged in while it is open appears', list.length === 3 && list[2].name === 'Late Arrival', JSON.stringify(list));
    await app.evaluate(({ session }, device) => {
      const wc = global.__agent.browser.activeTab().webContents;
      session.defaultSession.emit('hid-device-removed', { preventDefault() {} }, { device, frame: wc.mainFrame });
    }, HID({ deviceId: 'h3' }));
    await sleep(200);
    check('live: and goes again when unplugged', (await rows()).length === 2, JSON.stringify(await rows()));

    // a script cannot choose
    await overlay(`document.querySelector('.device').click(); document.querySelector('.device').dispatchEvent(new MouseEvent('click', { bubbles: true })); 0`);
    await sleep(150);
    check('script click: selects nothing, Connect stays disabled', (await rows()).every((r) => r.selected === 'false') && (await text()).buttons[1].disabled, JSON.stringify(await rows()));
    await overlay(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 0`);
    await sleep(150);
    check('script key: Enter does not connect', (await kind()) === 'devices' && (await spy()).length === 0, JSON.stringify(await spy()));

    // a real click picks a row
    await realClick('.device:nth-child(2)');
    await sleep(200);
    list = await rows();
    check('real click: picks the row and enables Connect', list[1].selected === 'true' && list[0].selected === 'false' && (await text()).buttons[1].disabled === false, JSON.stringify(list));
    if (shots) { await shot('devices', 'light'); await shot('devices', 'dark'); }
    // a script clicking Connect after a real selection still does nothing
    await overlay(`document.querySelector('#buttons .btn.primary').click(); 0`);
    await sleep(200);
    check('script click on Connect after a real selection: still open, nothing answered', (await kind()) === 'devices' && (await spy()).length === 0, JSON.stringify(await spy()));
    await realClick('#buttons .btn.primary');
    check('real Connect: closes', await waitFor(async () => (await kind()) === null), await kind());
    const got = await spy();
    check('real Connect: the callback gets the chosen deviceId', got.length === 1 && got[0].length === 1 && got[0][0] === 'h2', JSON.stringify(got));
    const settingsFile = path.join(profile, 'settings.json');
    const saved = await waitFor(() => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).deviceGrants; } catch { return null; } }, 4000);
    check('remembered: settings.json holds origin + vendor/product/serial (no deviceId)', Array.isArray(saved) && saved.length === 1 && saved[0].origin === new URL(url).origin && saved[0].type === 'hid' && saved[0].vendorId === 0x0C45 && saved[0].productId === 0x1234 && saved[0].serialNumber === 'SN2' && !('deviceId' in saved[0]), JSON.stringify(saved));

    // ---- Cancel and Esc
    await fire('hid', [HID()]);
    await opened();
    await realClick('#buttons .btn:not(.primary)');
    await waitFor(async () => (await kind()) === null);
    let c = await spy();
    check('Cancel: calls back with no arguments', c.length === 1 && c[0].length === 0, JSON.stringify(c));
    await fire('hid', [HID()]);
    await opened();
    await realKey('Escape');
    await waitFor(async () => (await kind()) === null);
    c = await spy();
    check('Esc: calls back with no arguments', c.length === 1 && c[0].length === 0, JSON.stringify(c));
    check('cancelled requests grant nothing', JSON.parse(fs.readFileSync(settingsFile, 'utf8')).deviceGrants.length === 1, '');

    // ---- keyboard: arrows + Enter
    await fire('hid', [HID(), HID({ deviceId: 'h2', name: 'Second', productId: 2, serialNumber: 'B' })]);
    await opened();
    await realKey('Down');
    await realKey('Down');
    await sleep(150);
    check('keys: arrows move the selection', (await rows())[1].selected === 'true', JSON.stringify(await rows()));
    await realKey('Return');
    await waitFor(async () => (await kind()) === null);
    c = await spy();
    check('keys: Enter connects the selected device', c.length === 1 && c[0][0] === 'h2', JSON.stringify(c));

    // ---- USB and serial
    await fire('usb', [{ deviceId: 'u1', productName: 'Flasher', vendorId: 0x2341, productId: 0x43 }]);
    await opened();
    check('usb: wording', /wants to connect to a USB device$/.test((await text()).message) && (await rows())[0].name === 'Flasher', JSON.stringify(await text()));
    await realKey('Escape');
    await waitFor(async () => (await kind()) === null);
    await fire('serial', [{ portId: 'p1', portName: 'COM3', displayName: 'USB Serial', vendorId: '9025', productId: '67' }]);
    await opened();
    check('serial: wording', /wants to connect to a serial port$/.test((await text()).message) && (await rows())[0].name === 'USB Serial', JSON.stringify(await text()));
    await realKey('Escape');
    await waitFor(async () => (await kind()) === null);

    // ---- a tab the AI opened never gets a chooser
    const front = await app.evaluate(({ webContents }) => global.__agent.browser.activeTab().webContents.id);
    await app.evaluate(async (_e, u) => { await global.__agent.execute('open_tab', { url: u }); }, url);
    const aiTab = await waitFor(() => app.evaluate(({ webContents }, [id, u]) => { const w = webContents.getAllWebContents().find((x) => x.id !== id && !x.isDestroyed() && x.getURL() === u); return w ? w.id : 0; }, [front, url]));
    check('ai: the AI opened a tab', Boolean(aiTab), aiTab);
    const result = await app.evaluate(({ webContents }, id) => Promise.race([
      webContents.fromId(id).executeJavaScript("navigator.hid.requestDevice({ filters: [{ vendorId: 0x0C45 }] }).then((list) => 'devices:' + list.length, (e) => e.name)", true),
      new Promise((r) => setTimeout(() => r('waiting'), 4000)),
    ]), aiTab);
    check('ai: requestDevice from it is refused at once and no chooser is shown', result === 'devices:0' && (await kind()) === null, result);
  } catch (err) {
    check('no exception', false, err.stack || err.message);
  }

  await app.close().catch(() => {});
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall device chooser checks passed');
  process.exit(failures ? 1 : 0);
})();
