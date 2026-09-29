// The tool overlay's page: the screenshot chooser, the area picker, toasts and the QR card. It only
// draws what the main process sends and reports the user's choice back (features/tool-overlay.js).
const $ = (id) => document.getElementById(id);
const screens = { modal: $('modal'), select: $('select'), toast: $('toast') };

let current = null; // { id, mode }
let toastTimer = null;
let toastHeld = false;

const send = (action, data) => { if (current) window.toolHost.action(current.id, action, data); };

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}

function button(label, className, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn${className ? ` ${className}` : ''}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// ---------- modal (chooser and QR card) ----------
function fillModal(payload) {
  $('m-title').textContent = payload.title || '';
  $('m-sub').textContent = payload.sub || '';
  $('m-sub').hidden = !payload.sub;
  $('m-warn').textContent = payload.warn || '';
  $('m-warn').hidden = !payload.warn;
  $('m-status').textContent = '';
  $('m-status').hidden = true;
  $('choices').replaceChildren();
  $('m-buttons').replaceChildren();
  $('qr-wrap').hidden = true;
  $('qr-text').hidden = true;
}

function showChooser(payload) {
  fillModal(payload);
  for (const option of payload.options || []) {
    const b = button('', 'choice', () => send('choose', { id: option.id }));
    b.append(document.createTextNode(option.label));
    if (option.hint) { const small = document.createElement('small'); small.textContent = option.hint; b.append(small); }
    $('choices').append(b);
  }
  $('m-buttons').append(button(payload.cancel || 'Cancel', '', () => send('close')));
  showScreen('modal');
  $('choices').firstElementChild?.focus();
}

// Draws the QR: `modules.rows` is one string of 0/1 per row; a quiet zone of 4 modules around it.
function drawQr(modules) {
  const canvas = $('qr');
  const n = modules.size;
  const margin = 4;
  const cell = Math.max(1, Math.floor(canvas.width / (n + margin * 2)));
  const total = cell * (n + margin * 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const offset = Math.floor((canvas.width - total) / 2) + margin * cell;
  ctx.fillStyle = '#000000';
  for (let r = 0; r < n; r++) {
    const row = modules.rows[r];
    for (let c = 0; c < n; c++) if (row[c] === '1') ctx.fillRect(offset + c * cell, offset + r * cell, cell, cell);
  }
}

function showQr(payload) {
  fillModal(payload);
  drawQr(payload.modules);
  $('qr').setAttribute('aria-label', payload.alt || '');
  $('qr-wrap').hidden = false;
  $('qr-text').textContent = payload.text || '';
  $('qr-text').hidden = !payload.text;
  for (const b of payload.buttons || []) $('m-buttons').append(button(b.label, b.primary ? 'primary' : '', () => send(b.id === 'close' ? 'close' : 'button', { id: b.id })));
  showScreen('modal');
  ($('m-buttons').querySelector('.primary') || $('m-buttons').lastElementChild)?.focus();
}

// Tab and Shift+Tab stay inside the card; Escape closes.
function trapFocus(e) {
  const items = [...$('modal').querySelectorAll('button')];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  e.preventDefault();
  items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
}

// ---------- area picker ----------
let drag = null; // { x0, y0, x1, y1 }
const dims = { top: $('dim-top'), left: $('dim-left'), right: $('dim-right'), bottom: $('dim-bottom') };

function paintSelection() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const box = $('box');
  if (!drag) {
    Object.assign(dims.top.style, { left: '0px', top: '0px', width: `${w}px`, height: `${h}px` });
    for (const k of ['left', 'right', 'bottom']) Object.assign(dims[k].style, { width: '0px', height: '0px' });
    box.hidden = true;
    return;
  }
  const x = Math.min(drag.x0, drag.x1);
  const y = Math.min(drag.y0, drag.y1);
  const bw = Math.abs(drag.x1 - drag.x0);
  const bh = Math.abs(drag.y1 - drag.y0);
  Object.assign(dims.top.style, { left: '0px', top: '0px', width: `${w}px`, height: `${y}px` });
  Object.assign(dims.bottom.style, { left: '0px', top: `${y + bh}px`, width: `${w}px`, height: `${Math.max(0, h - y - bh)}px` });
  Object.assign(dims.left.style, { left: '0px', top: `${y}px`, width: `${x}px`, height: `${bh}px` });
  Object.assign(dims.right.style, { left: `${x + bw}px`, top: `${y}px`, width: `${Math.max(0, w - x - bw)}px`, height: `${bh}px` });
  Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${bw}px`, height: `${bh}px` });
  box.hidden = false;
}

const clamp = (v, max) => Math.min(Math.max(v, 0), max);
const select = $('select');
select.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const x = clamp(e.clientX, window.innerWidth);
  const y = clamp(e.clientY, window.innerHeight);
  drag = { x0: x, y0: y, x1: x, y1: y };
  paintSelection();
});
select.addEventListener('mousemove', (e) => {
  if (!drag) return;
  drag.x1 = clamp(e.clientX, window.innerWidth);
  drag.y1 = clamp(e.clientY, window.innerHeight);
  paintSelection();
});
select.addEventListener('mouseup', () => {
  if (!drag) return;
  const rect = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0), viewWidth: window.innerWidth, viewHeight: window.innerHeight };
  drag = null;
  paintSelection();
  send('rect', rect); // main decides whether it is big enough
});

// ---------- toast ----------
function startToastTimer(seconds) {
  clearTimeout(toastTimer);
  if (!seconds) return;
  toastTimer = setTimeout(() => { if (toastHeld) startToastTimer(2); else send('close'); }, seconds * 1000);
}

function showToast(payload) {
  $('t-title').textContent = payload.title || '';
  $('t-sub').textContent = payload.sub || '';
  $('t-sub').hidden = !payload.sub;
  $('t-buttons').replaceChildren();
  for (const b of payload.buttons || []) $('t-buttons').append(button(b.label, '', () => send('button', { id: b.id })));
  showScreen('toast');
  startToastTimer(payload.seconds ?? 12);
}
$('toast').addEventListener('mouseenter', () => { toastHeld = true; });
$('toast').addEventListener('mouseleave', () => { toastHeld = false; });
$('toast').addEventListener('focusin', () => { toastHeld = true; });
$('toast').addEventListener('focusout', () => { toastHeld = false; });

// ---------- wiring ----------
window.toolHost.onShow(({ id, mode, payload }) => {
  clearTimeout(toastTimer);
  current = { id, mode };
  drag = null;
  toastHeld = false;
  if (mode === 'chooser') showChooser(payload);
  else if (mode === 'qr') showQr(payload);
  else if (mode === 'toast') showToast(payload);
  else if (mode === 'select') {
    $('hint').textContent = payload.hint || '';
    showScreen('select');
    paintSelection();
    select.focus();
  }
});

window.toolHost.onUpdate((data) => {
  if (!current || data.id !== current.id) return;
  if (data.status !== undefined) { $('m-status').textContent = data.status; $('m-status').hidden = !data.status; }
  if (data.title !== undefined) $('t-title').textContent = data.title;
  if (data.sub !== undefined) { $('t-sub').textContent = data.sub; $('t-sub').hidden = !data.sub; }
});

document.addEventListener('keydown', (e) => {
  if (!current) return;
  if (e.key === 'Escape') { e.preventDefault(); send('close'); return; }
  if (e.key === 'Tab' && (current.mode === 'chooser' || current.mode === 'qr')) trapFocus(e);
  if (current.mode === 'select' && e.key === 'Enter') e.preventDefault();
});
