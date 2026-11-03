// [usage] Runs Antigravity's own terminal UI for a few seconds, out of sight, to read its plan quota (ai/agy-quota.js starts this
// script as a plain Node child: process.execPath with ELECTRON_RUN_AS_NODE). agy fetches the quota itself at start and hands it,
// with the rest of its status line data, to the `statusLine` command its settings name; it does that only in its terminal UI,
// never with -p, and only when its output is a real terminal. So this script gives it one: a Windows pseudo console (ConPTY,
// through koffi, the same way desktop/winapi.js calls user32), which has no window. No prompt is typed and no model is called.
//
//   argv: <agy path> <workspace folder> <settings file> <wait ms>
//   stdout: the status line JSON, once it carries `quota`; nothing when it never did (exit 2) or on another platform (exit 3)
//
// The statusLine command (agy-quota.js settingsFor) is `more > lumen-agy-status.json`: agy runs it through cmd.exe in the
// workspace folder with the JSON on stdin, so it writes the file this script waits for. agy's TUI is ended with its whole
// process tree (taskkill /T) as soon as the file has a quota, or when the wait runs out.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./cli-utils'); // (hidden, never a shell)
const { STATUS_FILE, commandLine } = require('./agy-quota');

const [bin, dir, settingsFile, waitArg] = process.argv.slice(2);
const WAIT = Math.max(1000, Number(waitArg) || 20000);
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x20016;
const EXTENDED_STARTUPINFO_PRESENT = 0x80000;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const STARTF_USESTDHANDLES = 0x100; // with no handles given: the child's stdio is the pseudo console, never this script's pipes
const HEAP_ZERO_MEMORY = 0x8;

if (process.platform !== 'win32' || !bin || !dir || !settingsFile) process.exit(3);
delete process.env.ELECTRON_RUN_AS_NODE; // (agy inherits this environment: it is Lumen's own switch, not agy's)

let pid = 0;
let closeConsole = null;
function end(code, text = '') {
  if (pid) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  // Closing the pseudo console ends the read still waiting on its output (else Node, joining its thread pool at exit, would wait forever).
  if (closeConsole) { const close = closeConsole; closeConsole = null; close(); }
  if (text) process.stdout.write(text, () => process.exit(code)); else process.exit(code);
}

let k32;
let koffi;
try {
  koffi = require('koffi');
  k32 = koffi.load(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'kernel32.dll'));
} catch { process.exit(3); }

const HANDLE = 'void *';
const COORD = koffi.struct('LUMEN_AGY_COORD', { X: 'int16', Y: 'int16' });
const STARTUPINFOW = koffi.struct('LUMEN_AGY_STARTUPINFOW', {
  cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *', dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
  dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32', dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16',
  lpReserved2: 'void *', hStdInput: HANDLE, hStdOutput: HANDLE, hStdError: HANDLE,
});
const STARTUPINFOEXW = koffi.struct('LUMEN_AGY_STARTUPINFOEXW', { StartupInfo: STARTUPINFOW, lpAttributeList: 'void *' });
const PROCESS_INFORMATION = koffi.struct('LUMEN_AGY_PROCESS_INFORMATION', { hProcess: HANDLE, hThread: HANDLE, dwProcessId: 'uint32', dwThreadId: 'uint32' });

const CreatePipe = k32.func('__stdcall', 'CreatePipe', 'int', [koffi.out(koffi.pointer(HANDLE)), koffi.out(koffi.pointer(HANDLE)), 'void *', 'uint32']);
const CreatePseudoConsole = k32.func('__stdcall', 'CreatePseudoConsole', 'int32', [COORD, HANDLE, HANDLE, 'uint32', koffi.out(koffi.pointer(HANDLE))]);
const GetProcessHeap = k32.func('__stdcall', 'GetProcessHeap', HANDLE, []);
const HeapAlloc = k32.func('__stdcall', 'HeapAlloc', 'void *', [HANDLE, 'uint32', 'size_t']);
const InitializeProcThreadAttributeList = k32.func('__stdcall', 'InitializeProcThreadAttributeList', 'int', ['void *', 'uint32', 'uint32', koffi.inout(koffi.pointer('size_t'))]);
const UpdateProcThreadAttribute = k32.func('__stdcall', 'UpdateProcThreadAttribute', 'int', ['void *', 'uint32', 'uintptr', HANDLE, 'size_t', 'void *', 'void *']);
const CreateProcessW = k32.func('__stdcall', 'CreateProcessW', 'int', ['str16', 'void *', 'void *', 'void *', 'int', 'uint32', 'void *', 'str16', koffi.pointer(STARTUPINFOEXW), koffi.out(koffi.pointer(PROCESS_INFORMATION))]);
const ReadFile = k32.func('__stdcall', 'ReadFile', 'int', [HANDLE, 'void *', 'uint32', koffi.out(koffi.pointer('uint32')), 'void *']);
const CloseHandle = k32.func('__stdcall', 'CloseHandle', 'int', [HANDLE]);
const ClosePseudoConsole = k32.func('__stdcall', 'ClosePseudoConsole', 'void', [HANDLE]);

const inRead = [null];
const inWrite = [null];
const outRead = [null];
const outWrite = [null];
if (!CreatePipe(inRead, inWrite, null, 0) || !CreatePipe(outRead, outWrite, null, 0)) end(2);
const pc = [null];
if (CreatePseudoConsole({ X: 120, Y: 30 }, inRead[0], outWrite[0], 0, pc) !== 0) end(2);
closeConsole = () => ClosePseudoConsole(pc[0]);
CloseHandle(inRead[0]); // (the pseudo console holds its own copies)
CloseHandle(outWrite[0]);

const size = [0];
InitializeProcThreadAttributeList(null, 1, 0, size); // (fails by design: it only says how big the list is)
const list = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size[0]);
if (!list || !InitializeProcThreadAttributeList(list, 1, 0, size) || !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pc[0], koffi.sizeof(HANDLE), null, null)) end(2);

const cmd = Buffer.from(`${commandLine(bin, ['--settings', settingsFile, '--mode', 'plan'])}\0`, 'utf16le'); // (CreateProcessW may write to it)
const si = { StartupInfo: { cb: koffi.sizeof(STARTUPINFOEXW), dwFlags: STARTF_USESTDHANDLES }, lpAttributeList: list };
const pi = {};
if (!CreateProcessW(null, cmd, null, null, 0, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, null, dir, si, pi)) end(2);
pid = pi.dwProcessId;
CloseHandle(pi.hThread);

// The pseudo console's output must be read, or agy stalls once the pipe is full; nothing in it is kept.
const chunk = Buffer.alloc(8192);
const drain = () => ReadFile.async(outRead[0], chunk, chunk.length, [0], null, (err, ok) => { if (!err && ok) drain(); });
drain();

const file = path.join(dir, STATUS_FILE);
const started = Date.now();
const timer = setInterval(() => {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* half written: the next look */ }
  if (json && json.quota && typeof json.quota === 'object') { clearInterval(timer); end(0, JSON.stringify(json)); }
  else if (Date.now() - started > WAIT) { clearInterval(timer); end(2); }
}, 250);
