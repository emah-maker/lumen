// LaTeX as plain text for system notifications (features/plain-math.js) and the notification text itself
// (features/chat-runs.js). Plain Node.
const { plainMath } = require('../src/features/plain-math');
const { notification } = require('../src/features/chat-runs');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const is = (input, want) => { const got = plainMath(input); check(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, got === want, JSON.stringify(got)); };

is('The table confirms the answer: $x_2 \\approx 93.9\\%$.', 'The table confirms the answer: x₂ ≈ 93.9%.');
is('$h_f = 173.88$ and $h_{fg} = 2403.1$', 'h_f = 173.88 and h_(fg) = 2403.1');
is('$$x_2 = \\frac{2430 - h_f}{h_{fg}}$$', 'x₂ = (2430 - h_f)/(h_(fg))'); // ("f" and "g" have no subscript letter in Unicode)
is('\\(E = mc^2\\) and \\[\\sqrt{a^2+b^2}\\]', 'E = mc² and √(a²+b²)');
is('$\\Delta T \\geq 10^{-3}$ K', 'Δ T ≥ 10⁻³ K');
is('$\\text{rate} = 4\\,\\mathrm{kg/s}$', 'rate = 4 kg/s');
is('$\\alpha + \\beta \\to \\gamma$', 'α + β → γ');
is('$x^{n+1}$', 'xⁿ⁺¹');
is('$90^\\circ$', '90°');
is('costs $5 and $10 today', 'costs $5 and $10 today'); // money, not math
is('it is $5', 'it is $5');
is('no math here', 'no math here');
is('', '');

const n = notification('done', { reply: 'The table confirms the answer: $x_2 \\approx 93.9\\%$. The Engineering ToolBox saturated-water table agrees.' });
check('the "finished" notification shows the math as text, not LaTeX', /x₂ ≈ 93\.9%/.test(n.title) && !/[$\\]/.test(n.title), n.title);
const f = notification('failed', { error: 'Could not compute $\\frac{1}{0}$' });
check('a failure notification too', !/[$\\]/.test(f.title) && /1\/0/.test(f.title), f.title);

// Windows names a notification from the app ID's registry entry; without it, from the exe's description ("Electron").
const { appNameValues } = require('../src/features/instance');
const rows = appNameValues('C:\\Apps\\Lumen\\Lumen.exe', 'com.lumen.browser', 'C:\\Apps\\Lumen\\resources\\app\\src\\assets\\icon.ico');
check('notifications: the app ID gets DisplayName "Lumen" and an icon', rows.some(([k, n, d]) => k === 'HKCU\\Software\\Classes\\AppUserModelId\\com.lumen.browser' && n === 'DisplayName' && d === 'Lumen') && rows.some(([k, n, d]) => /AppUserModelId\\com\.lumen\.browser$/.test(k) && n === 'IconUri' && /icon\.ico$/.test(d)), JSON.stringify(rows));
const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main.js'), 'utf8');
check('a test run uses an app ID of its own (not the installed Lumen\'s)', /setAppUserModelId\(TEST \? `\$\{APP_ID\}\.test` : APP_ID\)/.test(main) && /fixAppName\(app, APP_ID\)/.test(main), '');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall plain-math checks passed');
process.exit(failures ? 1 : 0);
