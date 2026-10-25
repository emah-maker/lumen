// Opt-in live check that ATI Testing's student portal (a nursing school's study materials and practice tests) loads in Lumen
// SIGNED OUT (never an account, never a login: throwaway profile). Not in npm test: needs the network and the site changes.
// Run: LUMEN_LIVE=1 node test/e2e/live-atitesting.js   (hidden: LUMEN_TEST_BACKGROUND=1, under scripts/test/e2e-lock.js)
// Asserts: the sign-in page (user-management/auth.atitesting.com) shows its form, no "unsupported browser" wording, the page's
// own UA, navigator.userAgentData and platform agree (one Chrome), no Electron/Lumen token, and no request to an atitesting.com
// host (or the CDNs it needs) is blocked by Lumen. Analytics pings the ad blocker drops are expected and ignored.
// Proctored exams use the school's own lockdown software (Proctorio, Respondus, PSI); Lumen does not stand in for those.
if (!process.env.LUMEN_LIVE) { console.log('SKIP  live-atitesting needs LUMEN_LIVE=1 (it loads student.atitesting.com)'); process.exit(0); }
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const UNSUPPORTED = /unsupported browser|browser (is )?not supported|use (google )?chrome|update your browser|upgrade your browser|not (a )?supported/i;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-live-ati-profile-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const bail = setTimeout(() => { console.error('live-atitesting: 3 min cap, closing'); app.close().finally(() => process.exit(1)); }, 3 * 60000);
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const r = await app.evaluate(async () => {
      const wc = global.__agent.browser.activeTab().webContents;
      const urls = new Map();
      const failed = [];
      try { wc.debugger.attach('1.3'); } catch { /* already attached (Lumen's identity): reuse it */ }
      await wc.debugger.sendCommand('Network.enable');
      wc.debugger.on('message', (_e, method, p) => {
        if (method === 'Network.requestWillBeSent') urls.set(p.requestId, p.request.url);
        if (method === 'Network.loadingFailed') failed.push({ url: urls.get(p.requestId) || '', error: p.errorText, blocked: p.blockedReason || '', type: p.type });
      });
      wc.loadURL('https://student.atitesting.com/').catch(() => {});
      const until = Date.now() + 40000;
      while (Date.now() < until) {
        await new Promise((res) => setTimeout(res, 1000));
        const ready = await wc.executeJavaScript('Boolean(document.querySelector("input[type=password]"))').catch(() => false);
        if (ready) break;
      }
      await new Promise((res) => setTimeout(res, 3000)); // late requests
      const page = await wc.executeJavaScript(`(async () => {
        const hi = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture']);
        return { ua: navigator.userAgent, platform: navigator.platform, uadPlatform: navigator.userAgentData.platform, brands: navigator.userAgentData.brands.map((b) => b.brand), arch: hi.architecture,
          text: document.body.innerText, password: Boolean(document.querySelector('input[type=password]')), chrome: typeof window.chrome, webdriver: navigator.webdriver };
      })()`);
      return { final: wc.getURL(), title: wc.getTitle(), failed, page };
    });
    const p = r.page;
    check('lands on an atitesting.com sign-in page', /^https:\/\/([a-z-]+\.)*atitesting\.com\//.test(r.final), r.final);
    check('the sign-in form (username, password) is there', p.password && /username/i.test(p.text), p.text.slice(0, 200));
    check('no unsupported-browser message', !UNSUPPORTED.test(p.text), p.text.slice(0, 300));
    check('UA, userAgentData and navigator.platform name one OS and one Chrome', (/Windows/.test(p.ua) ? p.uadPlatform === 'Windows' && p.platform === 'Win32' : /Macintosh/.test(p.ua) ? p.uadPlatform === 'macOS' && p.platform === 'MacIntel' : p.uadPlatform === 'Linux') && p.brands.includes('Google Chrome') && !/Electron|Lumen/i.test(p.ua + p.brands.join()), JSON.stringify(p));
    check('window.chrome exists and navigator.webdriver is false', p.chrome === 'object' && p.webdriver === false, `${p.chrome} ${p.webdriver}`);
    // What Lumen itself blocked (ad blocker: ERR_BLOCKED_BY_CLIENT) among the site's own hosts and the CDNs it loads code from.
    const needed = /^https:\/\/([a-z0-9-]+\.)*(atitesting\.com|cloudfront\.net|googleapis\.com|gstatic\.com|cloudflare\.com|jsdelivr\.net|unpkg\.com)\//;
    const blocked = r.failed.filter((f) => /BLOCKED_BY_CLIENT|BLOCKED_BY_RESPONSE|CERT|SSL/.test(f.error + f.blocked) && needed.test(f.url) && !/googletagmanager|google-analytics|\/collect|\/gtm/i.test(f.url));
    check('no request to the site or its CDNs is blocked by Lumen', blocked.length === 0, JSON.stringify(blocked.slice(0, 5)));
  } finally {
    clearTimeout(bail);
    await app.close().catch(() => {});
  }
  if (failures) { console.error(`${failures} live-atitesting check(s) failed`); process.exit(1); }
  console.log('live-atitesting: all passed');
})().catch((err) => { console.error(err); process.exit(1); });
