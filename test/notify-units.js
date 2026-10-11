// Notifications say "Lumen" and show math as text. Plain Node; nothing here opens a window.
//  1. The Windows AppUserModelID: the one the process sets, the one the installer's shortcut gets and the one in the
//     build config must be the same string, or Windows names the toast from the exe ("Electron").
//  2. Every place that shows an OS notification runs its title and body through plain-math.
//  3. A corpus of real model output through plain-math, and the cut after (never inside) a math span.
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

// ---- 1. the app ID
const pkg = JSON.parse(read('package.json'));
const main = read('src', 'main.js');
const appId = pkg.build.appId;
const mainId = /^const APP_ID = '([^']+)';/m.exec(main)?.[1];
check('app ID: main.js APP_ID is the build config\'s appId', mainId === appId && appId === 'com.lumen.browser', `${mainId} vs ${appId}`);
const setAt = main.search(/app\.setAppUserModelId\(/);
const idAt = main.search(/^const APP_ID = /m);
const readyAt = main.search(/app\.whenReady\(\)/);
check('app ID: set at the top level, after APP_ID is defined and before the app is ready (so before any Notification)', idAt > -1 && setAt > idAt && setAt < readyAt, `${idAt} ${setAt} ${readyAt}`);
check('app ID: a real run sets exactly APP_ID (only a test run adds a suffix)', /setAppUserModelId\(TEST \? `\$\{APP_ID\}\.test` : APP_ID\)/.test(main) && !/setAppUserModelId\((?!TEST \?)/.test(main), '');
check('app ID: nothing sets it again later', (main.match(/setAppUserModelId\(/g) || []).length === 1, String((main.match(/setAppUserModelId\(/g) || []).length));
check('app ID: the shortcut writers get the same APP_ID', /installShortcuts\(app, shell, APP_ID\)/.test(main) && /ensureStartMenuShortcut\(app, shell, APP_ID\)/.test(main) && /fixShortcutIcons\(app, shell, undefined, APP_ID\)/.test(main) && /fixAppName\(app, APP_ID\)/.test(main), '');
check('app ID: the taskbar details use it too', /appId: APP_ID/.test(main), '');
const instanceSrc = read('src', 'features', 'instance.js');
check('app ID: no other app ID string is written in the shortcut code', !/com\.lumen\.browser/.test(instanceSrc.replace(/function fixAppName\(app, appId = 'com\.lumen\.browser'\)/, '')), '');
check('installer: Start menu and desktop shortcuts are created, named Lumen', pkg.build.nsis.createStartMenuShortcut === true && pkg.build.nsis.shortcutName === 'Lumen' && pkg.build.productName === 'Lumen', JSON.stringify(pkg.build.nsis));

const { ensureStartMenuShortcut, fixShortcutIcons, appNameValues } = require('../src/features/instance');
const rows = appNameValues('C:\\x\\Lumen.exe', appId, 'C:\\x\\icon.ico');
check('registry: DisplayName and IconUri are written under the build config\'s appId', rows.some((r) => r[0] === `HKCU\\Software\\Classes\\AppUserModelId\\${appId}` && r[1] === 'DisplayName' && r[2] === 'Lumen') && rows.some((r) => r[0].endsWith(`AppUserModelId\\${appId}`) && r[1] === 'IconUri'), JSON.stringify(rows));

if (process.platform === 'win32') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-aumid-'));
  const programs = path.join(dir, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  fs.mkdirSync(programs, { recursive: true });
  const lnk = path.join(programs, 'Lumen.lnk');
  const app = (packaged) => ({ isPackaged: packaged, getPath: (n) => (n === 'appData' ? dir : path.join(dir, n)) });
  const writes = [];
  let link = null;
  const shell = { readShortcutLink: () => link, writeShortcutLink: (f, op, o) => { writes.push({ f, op, o }); return true; } };
  check('shortcut: an unpackaged (dev) run touches nothing', ensureStartMenuShortcut(app(false), shell, appId) === false && writes.length === 0, JSON.stringify(writes));
  ensureStartMenuShortcut(app(true), shell, appId);
  check('shortcut: no Start menu Lumen.lnk -> it is created, with the app ID', writes.length === 1 && writes[0].op === 'create' && writes[0].o.appUserModelId === appId && writes[0].o.target === process.execPath && /\.ico$/.test(writes[0].o.icon), JSON.stringify(writes));
  fs.writeFileSync(lnk, '');
  writes.length = 0;
  link = { target: process.execPath, icon: 'x.ico', appUserModelId: '' };
  ensureStartMenuShortcut(app(true), shell, appId);
  check('shortcut: the installed copy\'s shortcut without the ID (what was on the user\'s machine) is given it', writes.length === 1 && writes[0].op === 'update' && writes[0].o.appUserModelId === appId, JSON.stringify(writes));
  writes.length = 0;
  link = { target: process.execPath, icon: 'x.ico', appUserModelId: appId };
  ensureStartMenuShortcut(app(true), shell, appId);
  check('shortcut: one that has the ID is not rewritten', writes.length === 0, JSON.stringify(writes));
  link = { target: 'C:\\Other\\Lumen.exe', icon: '', appUserModelId: '' };
  ensureStartMenuShortcut(app(true), shell, appId);
  check('shortcut: another install\'s shortcut is left alone', writes.length === 0, JSON.stringify(writes));
  // the startup sweep over every shortcut to this exe
  const desktop = path.join(dir, 'desktop');
  fs.mkdirSync(desktop);
  fs.writeFileSync(path.join(desktop, 'Lumen.lnk'), '');
  const ico = path.join(root, 'src', 'assets', 'icon.ico');
  const sweepLink = { target: process.execPath, icon: ico, appUserModelId: 'something.else' };
  const sweepShell = { readShortcutLink: () => sweepLink, writeShortcutLink: (f, op, o) => { writes.push({ f, op, o }); return true; } };
  writes.length = 0;
  fixShortcutIcons({ isPackaged: true, getPath: (n) => (n === 'desktop' ? desktop : dir) }, sweepShell, () => true, appId);
  check('shortcut: the sweep fixes a wrong ID on a shortcut whose icon is fine', writes.some((w) => w.f === path.join(desktop, 'Lumen.lnk') && w.o.appUserModelId === appId && !('icon' in w.o)), JSON.stringify(writes));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}

// ---- 2. every OS notification path converts math
const { notification, notifyText, firstLine } = require('../src/features/chat-runs');
const raw = String.raw;
const noTex = (s) => !/[\\$]/.test(s);

// Every file that makes a Notification (the page-notification proxy is the page's own text and is left as it is).
const found = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/vendor|node_modules/.test(e.name)) walk(p); } else if (/\.js$/.test(e.name) && !/\.(bundle|min)\.js$/.test(e.name) && /new Notification\(/.test(fs.readFileSync(p, 'utf8'))) found.push(path.relative(root, p).replace(/\\/g, '/'));
  }
}(path.join(root, 'src')));
check('notifications: the only OS notification makers are main.js (chat runs) and background-runner.js (tasks, routines, watches); a new one must be added here', found.sort().join() === 'src/features/background-runner.js,src/main.js', found.join());

const runner = read('src', 'features', 'background-runner.js');
check('tasks, routines and watches: title and body both go through notifyText', /new Notification\(\{ title: notifyText\(task\.title, \d+\), body: notifyText\(text, \d+\)/.test(runner), '');
check('chat runs (tellUser): the text comes from chatRunsLib.notification, which converts', /const text = chatRunsLib\.notification\(kind,/.test(main) && /new Notification\(\{ title: text\.title, body: text\.body/.test(main), '');
const chatRuns = read('src', 'features', 'chat-runs.js');
check('chat runs: the reply line, the error line and the chat title all convert', /plainMath\(String\(text \|\| ''\)\)/.test(chatRuns) && /body = notifyText\(chat/.test(chatRuns), '');

const math = raw`$x_2 \approx 93.9\%$`;
const n1 = notification('done', { reply: `Here you go: ${math}`, chat: raw`Solve $\frac{a}{b} = 2$` });
check('chat finished: title and body show text', n1.title === 'Lumen finished: Here you go: x₂ ≈ 93.9%' && n1.body === 'Solve a/b = 2', JSON.stringify(n1));
const n2 = notification('failed', { error: raw`Could not take \(\sqrt{-1}\)`, chat: raw`$\alpha$ test` });
check('chat failed: error and body show text', noTex(n2.title) && n2.title.includes('√(-1)') && n2.body === 'α test', JSON.stringify(n2));
const n3 = notification('approval', { chat: raw`Is $x \ge 3$?` });
check('chat needs an OK: the body shows text', n3.body === 'Is x ≥ 3?', JSON.stringify(n3));
check('math on its own line after a heading and display math first both read as text', firstLine(raw`$$\frac{a+b}{2}$$` + '\nthen more') === '(a+b)/2' && firstLine('# Result\n' + raw`$E=mc^2$`) === 'Result', firstLine(raw`$$\frac{a+b}{2}$$`));
check('a reply that opens with a math block spread over lines is converted before it is split', firstLine('$$\n' + raw`\frac{a}{b}` + '\n$$\n') === 'a/b', firstLine('$$\n\\frac{a}{b}\n$$\n'));

// ---- 3. the cut comes after the conversion
const sentence = `Result is ${raw`$\frac{a+b}{c} \approx 12.5$`} and so on and on and on and on `.repeat(1);
let cutOk = true; let bad = '';
for (let max = 5; max < 80; max++) {
  const out = firstLine(sentence.repeat(3), max);
  if (!noTex(out) || [...out].length > max || /[$\\]|frac|approx/.test(out)) { cutOk = false; bad = `${max}: ${out}`; break; }
}
check('truncation: at every length the text has no LaTeX left in it and is within the limit', cutOk, bad);
check('truncation: a title cut mid-math has no half-open $ left', noTex(notifyText(`${'x'.repeat(100)} ${raw`$\alpha_{ij} \le \beta$`}`, 108)) && noTex(notifyText(raw`$\frac{very long numerator}{denominator}$ `.repeat(30), 120)), notifyText(raw`$\frac{very long numerator}{denominator}$ `.repeat(5), 40));
check('notifyText: money and plain text are left as they are', notifyText('It costs $5 and $10.', 100) === 'It costs $5 and $10.' && notifyText('', 10) === '' && notifyText(null, 10) === '', '');

// ---- plain-math against real model output
const { plainMath } = require('../src/features/plain-math');
const is = (input, want) => { const got = plainMath(input); check(`corpus: ${input.replace(/\n/g, '\\n')}  ->  ${want}`, got === want, JSON.stringify(got)); };
is(raw`$x$`, 'x');
is(raw`$$\frac{a}{b}$$`, 'a/b');
is(raw`\(\frac{a}{b}\)`, 'a/b');
is(raw`\[\frac{a+b}{c-d}\]`, '(a+b)/(c-d)');
is(raw`$\frac12$`, '1/2');
is(raw`the ratio is \frac{a}{b} here`, 'the ratio is a/b here'); // no delimiters
is(raw`$\sqrt{x}$, $\sqrt[3]{27}$, $\sqrt2$`, '√x, ³√27, √2');
is(raw`$\sqrt{a^2+b^2}$`, '√(a²+b²)');
is(raw`$x^{2}+y_{i}$`, 'x²+yᵢ');
is(raw`$a_{ij}^{2}$`, 'aᵢⱼ²');
is(raw`$e^{i\pi}+1=0$`, 'e^(iπ)+1=0');
is(raw`$12 \times 3 \cdot 4$`, '12 × 3 · 4');
is(raw`$\pi r^2$`, 'π r²');
is(raw`$a \le b \ge c \neq d \approx e$`, 'a ≤ b ≥ c ≠ d ≈ e');
is(raw`$\leq \geq$`, '≤ ≥');
is(raw`$\text{speed} = 5\,\text{m/s}^2$`, 'speed = 5 m/s²');
is(raw`$9.8\,\text{m/s}^2$`, '9.8 m/s²');
is(raw`$\mathrm{CO}_2$ and $\mathrm{H}_2\mathrm{O}$`, 'CO₂ and H₂O');
is(raw`$\mathbf{F} = m\mathbf{a}$`, 'F = ma');
is(raw`$\left( \frac{a}{b} \right)^2$`, '( a/b )²');
is(raw`$\left[ x \right]$ $\left\{ y \right\}$ $\left| z \right|$`, '[ x ] { y } | z |');
is(raw`$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$`, 'Σᵢ₌₁ⁿ i = (n(n+1))/2');
is(raw`$\int_0^1 x\,dx = \frac12$`, '∫₀¹ x dx = 1/2');
is(raw`$x = 3.2 \times 10^{-5}$`, 'x = 3.2 × 10⁻⁵');
is(raw`$\Delta T = 20^\circ\mathrm{C}$`, 'Δ T = 20°C');
is(raw`$\log_{10} 100 = 2$, $\sin\theta$`, 'log₁₀ 100 = 2, sinθ');
is(raw`$\lim_{x\to 0} \frac{\sin x}{x} = 1$`, 'lim_(x→ 0) (sin x)/x = 1');
is(raw`$\vec{v}$`, 'v\u20D7');
is(raw`$\mathbb{R}$ and $\mathcal{L}$`, 'R and L');
is(raw`$\boxed{42}$`, '42');
is(raw`$\begin{aligned} a &= b \\ c &= d \end{aligned}$`, 'a = b; c = d');
is(raw`$\infty$, $\pm 1$, $\neq$, $\cdots$`, '∞, ± 1, ≠, ⋯');
is(raw`$\alpha, \beta, \gamma, \Omega$`, 'α, β, γ, Ω');
is(raw`$\%$ and 50\% and \$5`, '% and 50% and $5');
is('costs $5 and $10, or $3.50.', 'costs $5 and $10, or $3.50.');
is('between $5 and $10 dollars', 'between $5 and $10 dollars');
is('a **bold** claim', 'a **bold** claim');
is('Line one\n\n$$\nE = mc^2\n$$\n\nLine two', 'Line one\n\nE = mc²\n\nLine two');
is(raw`First $a \le b$ then $$c \ge d$$ then \(e \neq f\)`, 'First a ≤ b then c ≥ d then e ≠ f');
is('`$x$` in code', '`$x$` in code'.replace('$x$', 'x')); // (code spans are not special-cased: a $x$ in backticks reads as x too)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall notification checks passed');
process.exit(failures ? 1 : 0);
