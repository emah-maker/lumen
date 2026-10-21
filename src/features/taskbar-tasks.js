// The OS taskbar entry's commands (pure: no Electron). Windows: a Jump List task (right-click Lumen's taskbar icon) that starts
// Lumen with `--close-ai-tabs`; the running instance receives that argument through 'second-instance'. macOS: the Dock menu.
const CLOSE_AI_TABS_ARG = '--close-ai-tabs';

// Does this command line (process.argv, or the argv a second instance sends) ask for it? Only the exact flag counts, and only
// after argv[0] (the program); anything else on the line is ignored here.
const wantsCloseAiTabs = (argv) => Array.isArray(argv) && argv.slice(1).some((a) => a === CLOSE_AI_TABS_ARG);

// The tasks for app.setUserTasks: a task launches `program` with `arguments`. Its icon is `iconPath` (Lumen's icon.ico: Lumen.exe is Electron's binary,
// so its own icon, the default, is Electron's atom); iconIndex 0 is the first icon in that file.
function jumpListTasks({ execPath, label, description = label, iconPath = execPath } = {}) {
  if (typeof execPath !== 'string' || !execPath || typeof label !== 'string' || !label) return [];
  return [{ program: execPath, arguments: CLOSE_AI_TABS_ARG, iconPath: typeof iconPath === 'string' && iconPath ? iconPath : execPath, iconIndex: 0, title: label, description }];
}

// The Dock menu's items (macOS): the click runs the same action directly, no second process.
function dockMenuItems({ label, click } = {}) {
  if (typeof label !== 'string' || !label || typeof click !== 'function') return [];
  return [{ label, click }];
}

module.exports = { CLOSE_AI_TABS_ARG, wantsCloseAiTabs, jumpListTasks, dockMenuItems };
