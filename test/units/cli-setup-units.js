// Settings → AI → Set up a coding agent (renderer/settings-cli-setup.js): every CLI engine has official docs links, an install command per
// system that matches the engine's own hint in src/ai, a sign-in command, and a terminal animation that types in order and holds still
// under reduced motion. Plus the wiring: Settings page and alias, the bundle, the sidebar's "See how" link, the strings. Plain Node.
const fs = require('fs');
const path = require('path');
const C = require('../../src/renderer/settings-cli-setup');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

// ---- the guides
const ids = C.GUIDES.map((g) => g.id);
check('guides: one per CLI engine Lumen runs (Claude Code, Codex, Grok Build, Antigravity)', JSON.stringify(ids) === JSON.stringify(['claudecode', 'codex', 'grokbuild', 'antigravity']), ids.join());
const DOC_HOSTS = { claudecode: ['code.claude.com'], codex: ['learn.chatgpt.com'], grokbuild: ['docs.x.ai'], antigravity: ['antigravity.google'] };
for (const g of C.GUIDES) {
  const urls = [g.docs.install, g.docs.signIn];
  check(`${g.id}: install and sign-in docs are https on the maker's own docs host`, urls.every((u) => { try { const x = new URL(u); return x.protocol === 'https:' && DOC_HOSTS[g.id].includes(x.hostname); } catch { return false; } }), urls.join(' '));
  check(`${g.id}: an install command for Windows, macOS and Linux`, C.PLATFORMS.every((p) => typeof g.install[p] === 'string' && g.install[p].length > 5), JSON.stringify(g.install));
  check(`${g.id}: the Windows command runs in PowerShell (no bash pipe), the others in a POSIX shell`, !/\| *(ba)?sh\b/.test(g.install.win32) && ['darwin', 'linux'].every((p) => !/\birm\b|\biex\b/.test(g.install[p])), JSON.stringify(g.install));
  check(`${g.id}: the sign-in command starts with its binary`, g.signIn.split(' ')[0] === g.bin, g.signIn);
  check(`${g.id}: says what account it needs and how sign-in goes`, g.needs.length > 10 && g.signInHow.includes(g.signIn), g.signInHow);
  check(`${g.id}: points at a sidebar setup button that exists`, read('src/renderer/index.src.html').includes(`id="${g.setupId}"`), g.setupId);
}

// ---- the commands match what each engine itself tells the user when it isn't installed
const cc = read('src/ai/claude-code.js');
const claude = C.guideOf('claudecode');
check('claudecode: same install commands and npm package as ai/claude-code.js', cc.includes(claude.install.win32) && cc.includes(claude.install.linux) && cc.includes(claude.alt));
const grok = read('src/ai/grok-build.js');
const gb = C.guideOf('grokbuild');
check('grokbuild: same install commands as ai/grok-build.js', grok.includes(gb.install.win32) && grok.includes(gb.install.linux));
const agy = require('../../src/ai/antigravity');
const ag = C.guideOf('antigravity');
const agyCmd = typeof agy.installCommand === 'function' ? agy.installCommand : null;
check('antigravity: same install commands as ai/antigravity.js', agyCmd ? C.PLATFORMS.every((p) => agyCmd(p) === ag.install[p]) : read('src/ai/antigravity.js').includes(ag.install.win32.split(' ')[1]), agyCmd ? C.PLATFORMS.map((p) => agyCmd(p)).join(' | ') : 'installCommand not exported');
const cx = require('../../src/ai/codex-locate');
const codex = C.guideOf('codex');
check('codex: the npm package matches ai/codex-locate.js', (cx.installHint ? cx.installHint('linux') : read('src/ai/codex-locate.js')).includes(codex.alt));

// ---- platform and lookup helpers
check('platformOf: navigator.platform and Node names', C.platformOf('Win32') === 'win32' && C.platformOf('MacIntel') === 'darwin' && C.platformOf('darwin') === 'darwin' && C.platformOf('Linux x86_64') === 'linux' && C.platformOf('') === 'linux' && C.platformOf(undefined) === 'linux');
check('shellOf: PowerShell on Windows, Terminal elsewhere', C.shellOf('win32').name === 'PowerShell' && C.shellOf('win32').prompt === 'PS>' && C.shellOf('darwin').prompt === '$');
check('commandFor: picks this system, unknown guide is empty', C.commandFor(claude, 'Win32') === claude.install.win32 && C.commandFor(claude, 'MacIntel') === claude.install.darwin && C.commandFor(null, 'win32') === '' && C.guideOf('nope') === null);

// ---- the animation script
for (const g of C.GUIDES) {
  const s = C.demoScript(g, 'win32');
  const kinds = s.map((l) => l.kind).join(',');
  check(`${g.id} demo: install, then sign in, then ready`, kinds === 'cmd,out,ok,cmd,out,ok,note' && s[0].text === g.install.win32 && s[3].text === g.signIn, kinds);
  check(`${g.id} demo: lines start in order and never overlap the typing before them`, s.every((l, i) => i === 0 || l.start >= s[i - 1].start + s[i - 1].dur), JSON.stringify(s.map((l) => [l.start, l.dur])));
  check(`${g.id} demo: a typed line has one step per character and types in under 2 s`, s.filter((l) => l.kind === 'cmd').every((l) => l.n === l.text.length && l.dur > 0 && l.dur <= 1600));
  check(`${g.id} demo: a short run (under 10 s), every message has a string key and the name`, C.demoLength(s) > 2000 && C.demoLength(s) < 10000 && s.filter((l) => l.kind !== 'cmd').every((l) => l.key && l.vars.name === g.name), String(C.demoLength(s)));
  const still = C.demoScript(g, 'darwin', { reduced: true });
  check(`${g.id} demo: reduced motion shows every line at once`, still.length === s.length && still.every((l) => l.start === 0 && l.dur === 0) && C.demoLength(still) === 0 && still[0].text === g.install.darwin);
}
check('demo: no guide, no lines', C.demoScript(null, 'win32').length === 0);

// ---- reduced motion in CSS: Lumen's own switch and the system's both stop the animation and show the text
const css = read('src/renderer/settings.css');
check('css: prefers-reduced-motion shows the lines without animation', /@media \(prefers-reduced-motion: reduce\) \{ \.cli-line \{ opacity: 1; animation: none; \}/.test(css));
check('css: Lumen’s Reduce motion (.reduce-motion) shows the lines too, not stuck at opacity 0', /\.reduce-motion \.cli-line \{ opacity: 1; animation: none; \}/.test(css) && /\.reduce-motion \.cli-line\.cmd \.cli-typed \{ width: auto; animation: none; \}/.test(css));
check('css: typing uses steps of 1ch', /steps\(var\(--n, 1\), end\)/.test(css) && /width: calc\(var\(--n, 0\) \* 1ch\)/.test(css));

// ---- wiring
const settings = read('src/renderer/settings.js');
check('settings: the page is under AI, built by buildCliSetup, and opens as lumen://settings/cli-setup', /\['ai-setup', 'Set up a coding agent', \{ page: 'ai-links'/.test(settings) && /\['ai-setup', buildCliSetup\]/.test(settings) && /'cli-setup': \{ cat: 'ai', sub: 'ai-setup' \}/.test(settings) && /const SUBS = new Set\(\['ai-providers', 'ai-setup'/.test(settings));
const src = read('src/renderer/settings.src.html');
check('settings: the script loads before settings.js', src.indexOf('settings-cli-setup.js') > 0 && src.indexOf('settings-cli-setup.js') < src.indexOf('<script src="settings.js">'));
check('settings bundle: includes the guides', read('src/renderer/settings.bundle.js').includes('lumenCliSetup') && read('src/renderer/settings.bundle.js').includes('buildCliSetup'));
check('settings: links open with S.openUrl, styles set through CSSOM (the page CSP has no inline style)', /S\.openUrl\(g\.docs\.install\)/.test(read('src/renderer/settings-cli-setup.js')) && !/setAttribute\('style'/.test(read('src/renderer/settings-cli-setup.js')));
const core = read('src/renderer/chat-core.js');
check('sidebar: "See how" and "Get Claude Code" open the guide', /setup-more-link'\)\.onclick = \(\) => window\.lumenPrefs\?\.openSettingsPage\('cli-setup'\)/.test(core) && /setup-claude-code-get'\)\.addEventListener\('click'[^\n]*openSettingsPage\('cli-setup'\)/.test(core));
check('sidebar bundle: rebuilt with the new link', read('src/renderer/ui.bundle.js').includes("openSettingsPage('cli-setup')"));

// ---- strings: every key the page looks up is in en.json, with the same English as the fallback
const en = JSON.parse(read('src/locales/en.json'));
const strings = en.strings || en;
const page = read('src/renderer/settings-cli-setup.js');
const keys = [...page.matchAll(/tr\('(settings\.cliSetup\.[\w.]+)'/g)].map((m) => m[1]);
for (const g of C.GUIDES) keys.push(`settings.cliSetup.${g.id}.needs`, `settings.cliSetup.${g.id}.signIn`);
for (const l of C.demoScript(C.GUIDES[0], 'linux')) if (l.key) keys.push(l.key);
const missing = [...new Set(keys)].filter((k) => typeof strings[k] !== 'string');
check('strings: every key is in locales/en.json', keys.length > 25 && missing.length === 0, missing.join(', '));
const differs = C.GUIDES.filter((g) => strings[`settings.cliSetup.${g.id}.needs`] !== g.needs || strings[`settings.cliSetup.${g.id}.signIn`] !== g.signInHow).map((g) => g.id);
check('strings: the per-agent English matches the guide data', differs.length === 0, differs.join());

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
