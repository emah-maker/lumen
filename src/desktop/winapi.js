// [desktop apps] The few Win32 calls the "you took over" and "stop" checks need, through koffi (the same way features/webauthn-windows.js calls
// webauthn.dll): where the mouse is and which program's window is under it, which program has the keyboard, and whether a key is down.
// Each call takes microseconds and runs only while the AI is using an app. Nothing is read from another program's memory or windows beyond
// "which process owns this window".
'use strict';

const path = require('path');

// Keys that mean "the person is typing": letters, digits, space, edit and arrow keys, function keys, numpad, punctuation. Not the mouse
// buttons (1-6) and not the modifiers, which are held for shortcuts the AI itself may send.
const TYPING_KEYS = (() => {
  const out = [0x08, 0x09, 0x0d, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2e];
  for (let k = 0x30; k <= 0x5a; k++) out.push(k);
  for (let k = 0x60; k <= 0x87; k++) out.push(k);
  for (let k = 0xba; k <= 0xc0; k++) out.push(k);
  for (let k = 0xdb; k <= 0xde; k++) out.push(k);
  return out;
})();
const VK_ESCAPE = 0x1b;
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;

function load({ koffi: injected = null } = {}) {
  if (process.platform !== 'win32' && !injected) return { ok: false, reason: 'platform' };
  let koffi = injected;
  try { koffi ||= require('koffi'); } catch (err) { return { ok: false, reason: 'koffi', detail: err.message }; }
  try {
    const user32 = koffi.load(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'user32.dll'));
    const POINT = koffi.struct('LUMEN_DESKTOP_POINT', { x: 'int32', y: 'int32' });
    const getCursorPos = user32.func('__stdcall', 'GetCursorPos', 'int', [koffi.out(koffi.pointer(POINT))]);
    const windowFromPoint = user32.func('__stdcall', 'WindowFromPoint', 'void *', [POINT]);
    const getAncestor = user32.func('__stdcall', 'GetAncestor', 'void *', ['void *', 'uint32']);
    const getForeground = user32.func('__stdcall', 'GetForegroundWindow', 'void *', []);
    const getThreadProcess = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['void *', koffi.out(koffi.pointer('uint32'))]);
    const getKey = user32.func('__stdcall', 'GetAsyncKeyState', 'int16', ['int']);
    const pidOf = (hwnd) => { if (!hwnd) return 0; const out = [0]; getThreadProcess(hwnd, out); return out[0] >>> 0; };
    return {
      ok: true,
      cursor() { const p = {}; return getCursorPos(p) ? { x: p.x, y: p.y } : null; },
      pidUnderCursor() { const p = {}; if (!getCursorPos(p)) return 0; const w = windowFromPoint(p); return w ? pidOf(getAncestor(w, 2)) : 0; }, // GA_ROOT
      foregroundPid() { return pidOf(getForeground()); },
      foregroundHwnd() { const h = getForeground(); return h ? Number(koffi.address(h)) : 0; },
      keyDown: (vk) => (getKey(vk) & 0x8000) !== 0,
      escapeDown: () => (getKey(VK_ESCAPE) & 0x8000) !== 0,
      mouseDown: () => (getKey(VK_LBUTTON) & 0x8000) !== 0 || (getKey(VK_RBUTTON) & 0x8000) !== 0,
      typing: () => TYPING_KEYS.some((vk) => (getKey(vk) & 0x8000) !== 0),
    };
  } catch (err) { return { ok: false, reason: 'dll', detail: err.message }; }
}

module.exports = { load, TYPING_KEYS };
