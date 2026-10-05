// Manual DRM check (castlabs ECS / Widevine). Not part of `npm test` — run directly:
//   node test/drm.js
// Starts Lumen as a plain process (under Playwright's Electron launcher the Widevine component
// never installs) and drives a tab over the DevTools protocol instead. The CDM downloads on the
// first run of a fresh profile, so this allows real time for that.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const electron = require('electron'); // path to the binary
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-drm-'));
  const child = spawn(electron, [path.join(__dirname, '..'), `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(1000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
  }
  if (!browser) throw new Error(`Lumen did not open its debugging port\n${log}`);
  for (let i = 0; i < 30 && !/Widevine components status/.test(log); i++) await sleep(1000);
  if (!/Widevine components status/.test(log)) console.log('No Widevine status logged (not a castlabs ECS build?)');

  // Lumen's DevTools endpoint can't create targets; use the tab it opened (the new-tab page).
  let page;
  for (let i = 0; i < 20 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('newtab.html'));
    if (!page) await sleep(500);
  }
  await page.goto('https://example.com/');
  const result = await page.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      try {
        await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
          initDataTypes: ['cenc'],
          videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
          audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
        }]);
        return 'PASS';
      } catch (err) {
        if (i === 59) return `FAIL: ${err.name}: ${err.message}`;
        await new Promise((r) => setTimeout(r, 2000)); // the CDM may still be installing
      }
    }
  });
  const status = log.match(/Widevine components status:[\s\S]*?\n\}/)?.[0] || '(no status logged)';
  console.log(status.replace(/\x1b\[\d+m/g, ''));
  console.log(`requestMediaKeySystemAccess('com.widevine.alpha'): ${result}`);
  await browser.close().catch(() => {});
  child.kill();
  process.exit(result === 'PASS' ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
