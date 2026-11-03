// A stand-in for agy's terminal UI (test/units/agy-quota-units.js reaches it through a .cmd shim, never the real agy).
// Like agy 1.4.12, it hands its status line JSON to the `statusLine` command its --settings file names, through cmd.exe in the
// current folder, and only when its output is a real terminal; then it keeps running, as a TUI does, until it is ended.
//   FAKE_AGY_STATUS: the JSON file to pass (default: test/fixtures/agy-statusline.json)
//   FAKE_AGY_MODE:   'silent' passes nothing (an agy too old for a quota, or signed out)
//   FAKE_AGY_TRACE:  a file that gets one line per start: "<isTTY> <args as JSON>"
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
if (process.env.FAKE_AGY_TRACE) fs.appendFileSync(process.env.FAKE_AGY_TRACE, `${Boolean(process.stdout.isTTY)} ${JSON.stringify(args)}\n`);
const at = args.indexOf('--settings');
if (at < 0) { process.stdout.write('1.4.12\n'); process.exit(0); } // (any other call, such as a version check, ends at once)
const settings = at >= 0 ? JSON.parse(fs.readFileSync(args[at + 1], 'utf8')) : {};
process.stdout.write('\x1b[?1049h> Plan mode: research & plan only\r\n'); // (some screen output, which the probe must read off the pipe)
if (process.stdout.isTTY && process.env.FAKE_AGY_MODE !== 'silent' && settings.statusLine && settings.statusLine.command) {
  const json = fs.readFileSync(process.env.FAKE_AGY_STATUS || path.join(__dirname, 'agy-statusline.json'), 'utf8');
  setTimeout(() => { execSync(settings.statusLine.command, { input: json.replace(/\s*\n\s*/g, ' '), cwd: process.cwd(), shell: process.env.ComSpec || 'cmd.exe', windowsHide: true }); }, 300);
}
setInterval(() => process.stdout.write('.'), 500);
