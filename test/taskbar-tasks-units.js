// The taskbar's "Close tabs the AI opened" (features/taskbar-tasks.js and how main.js / instance.js use it), plain Node: no Electron.
const fs = require('fs');
const path = require('path');
const T = require('../src/features/taskbar-tasks');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

// ---- the Jump List task
{
  const [task, ...rest] = T.jumpListTasks({ execPath: 'C:\\Lumen\\Lumen.exe', label: 'Close tabs the AI opened', description: 'Close them' });
  check('task: one task, no more', Boolean(task) && rest.length === 0);
  check('task: it launches Lumen with the flag only', task.program === 'C:\\Lumen\\Lumen.exe' && task.arguments === '--close-ai-tabs' && T.CLOSE_AI_TABS_ARG === '--close-ai-tabs');
  check('task: Lumen\'s own icon (index 0), the label as title, the description', task.iconPath === 'C:\\Lumen\\Lumen.exe' && task.iconIndex === 0 && task.title === 'Close tabs the AI opened' && task.description === 'Close them');
  check('task: no description falls back to the label', T.jumpListTasks({ execPath: 'x', label: 'L' })[0].description === 'L');
  check('task: no program or no label means no task', J(T.jumpListTasks()) === '[]' && J(T.jumpListTasks({ label: 'L' })) === '[]' && J(T.jumpListTasks({ execPath: 'x' })) === '[]' && J(T.jumpListTasks({ execPath: 5, label: 'L' })) === '[]');
}

// ---- the Dock menu
{
  const click = () => {};
  const items = T.dockMenuItems({ label: 'Close tabs the AI opened', click });
  check('dock: one item with the label and the click', items.length === 1 && items[0].label === 'Close tabs the AI opened' && items[0].click === click);
  check('dock: without a label or a click, no item', J(T.dockMenuItems()) === '[]' && J(T.dockMenuItems({ label: 'x' })) === '[]' && J(T.dockMenuItems({ click })) === '[]');
}

// ---- the command line
{
  const exe = 'C:\\Lumen\\Lumen.exe';
  check('argv: the flag is recognised (process.argv and a second instance\'s argv look alike)', T.wantsCloseAiTabs([exe, '--close-ai-tabs']) === true);
  check('argv: from source (Electron, the app folder, then the flag)', T.wantsCloseAiTabs(['electron.exe', '.', '--close-ai-tabs']) === true);
  check('argv: with other flags and a link around it', T.wantsCloseAiTabs([exe, '--no-sandbox', 'https://example.com/', '--close-ai-tabs']) === true);
  check('argv: no flag, nothing', T.wantsCloseAiTabs([exe]) === false && T.wantsCloseAiTabs([exe, 'https://example.com/']) === false);
  check('argv: unknown or look-alike arguments are ignored', T.wantsCloseAiTabs([exe, '--close-ai-tabs=1', '--close-ai', '--close-ai-tabs-now', 'close-ai-tabs', '--CLOSE-AI-TABS']) === false);
  check('argv: the program itself (argv[0]) never counts', T.wantsCloseAiTabs(['--close-ai-tabs']) === false);
  check('argv: not an array, nothing', T.wantsCloseAiTabs(undefined) === false && T.wantsCloseAiTabs(null) === false && T.wantsCloseAiTabs('--close-ai-tabs') === false);
}

// ---- wiring
{
  const main = read('src/main.js');
  const inst = read('src/features/instance.js');
  const en = JSON.parse(read('src/locales/en.json'));
  check('wiring: the second instance runs the action, and only a flag-only command line leaves the window alone', /app\.on\('second-instance'[\s\S]{0,400}wantsCloseAiTabs\(argv\)[\s\S]{0,200}closeAiTabsEverywhere\(\)[\s\S]{0,200}if \(!closeAi \|\| links\.length\) \{ focusWindow\(\)/.test(main));
  check('wiring: the action never focuses or shows a window itself', (() => { const fn = main.slice(main.indexOf('async function closeAiTabsEverywhere'), main.indexOf("if (TEST) global.__manners")); return fn.length > 100 && !/focusWindow|\.focus\(|\.show\(|restore\(\)|moveTop/.test(fn); })());
  check('wiring: it goes through the same selection, close and toast as the tab menu (aiTabsClose, aiCloseNote), per window', /closeAiTabsEverywhere[\s\S]{0,1800}aiTabsClose\(\{ rec \}\)[\s\S]{0,300}aiCloseNote\(rec, r\)/.test(main));
  check('wiring: the Jump List task is set from an installed Windows build only, never in a test (it would replace the real app\'s list)', /function setupTaskbar\(\) \{\s*if \(TEST\) return;\s*if \(process\.platform === 'win32' && app\.isPackaged\)[\s\S]{0,200}setUserTasks\(taskbarTasks\.jumpListTasks/.test(main));
  check('wiring: the Dock menu carries the same action on macOS', /dock\?\.setMenu\([\s\S]{0,200}dockMenuItems[\s\S]{0,200}closeAiTabsEverywhere/.test(main));
  check('wiring: the taskbar is set up when the app is ready', /instance\.listenForSecondInstances\(app, focusWindow\);\s*setupTaskbar\(\);/.test(main));
  check('wiring: a second process with the flag does not ping (and so focus) the running window', /wantsCloseAiTabs\(process\.argv\)\) return false;[^\n]*\n[\s\S]{0,200}pingRunningInstance/.test(inst) || inst.indexOf('wantsCloseAiTabs(process.argv)') < inst.indexOf('if (pingRunningInstance(app))'));
  check('wiring: in the \u22ef menu and the macOS Tab menu', (main.match(/menu\.closeAiTabs'\), [^\n]*closeAiTabsEverywhere/g) || []).length === 2 && /enabled: aiTabSelect\(\{\}\)\.length > 0, click: \(\) => \{ closeAiTabsEverywhere/.test(main));
  check('strings: the taskbar label, its description and the empty note exist', ['taskbar.closeAiTabs', 'taskbar.closeAiTabsDesc', 'taskbar.noAiTabs', 'menu.closeAiTabs'].every((k) => typeof en[k] === 'string' && en[k]));
  check('docs and changelog mention it', /taskbar/i.test(read('docs/settings.md')) && /taskbar/i.test(read('CHANGELOG.md'))); // anywhere in it: the entry moves from Unreleased into a version's section when that version is cut
}

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
