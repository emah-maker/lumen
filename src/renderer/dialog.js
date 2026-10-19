const backdrop = document.getElementById('backdrop');
const card = document.getElementById('card');
const iconEl = document.getElementById('icon');
const titleEl = document.getElementById('title');
const messageEl = document.getElementById('message');
const detailEl = document.getElementById('detail');
const fieldsEl = document.getElementById('fields');
const checkboxRow = document.getElementById('checkbox-row');
const checkboxInput = document.getElementById('checkbox');
const checkboxLabelEl = document.getElementById('checkbox-label');
const buttonsEl = document.getElementById('buttons');
const textEl = document.getElementById('text');
const notesEl = document.getElementById('notes');
const moreEl = document.getElementById('more');
const linkEl = document.getElementById('notes-link');
const devicesEl = document.getElementById('devices');
const devicesEmptyEl = document.getElementById('devices-empty');

// A line of release notes: `code` and **bold** become elements, everything else stays text.
function inline(parent, text) {
  for (const part of String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) parent.append(Object.assign(document.createElement('code'), { textContent: part.slice(1, -1) }));
    else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) parent.append(Object.assign(document.createElement('strong'), { textContent: part.slice(2, -2) }));
    else parent.append(document.createTextNode(part));
  }
}

function renderNotes(payload) {
  notesEl.replaceChildren();
  for (const release of payload.notes || []) {
    const section = document.createElement('section');
    section.className = 'release';
    const heading = document.createElement('h3');
    heading.textContent = release.version;
    if (release.date) heading.append(Object.assign(document.createElement('span'), { className: 'date', textContent: release.date }));
    section.append(heading);
    let list = null;
    for (const block of release.blocks || []) {
      if (block.type === 'p') {
        list = null;
        const p = document.createElement('p');
        inline(p, block.text);
        section.append(p);
      } else {
        if (!list) { list = document.createElement('ul'); section.append(list); }
        const li = document.createElement('li');
        inline(li, block.text);
        list.append(li);
      }
    }
    notesEl.append(section);
  }
  notesEl.hidden = payload.kind !== 'notes';
  moreEl.textContent = payload.more || '';
  moreEl.hidden = !payload.more;
  linkEl.hidden = !payload.link;
  linkEl.textContent = payload.link?.label || '';
  if (payload.link) linkEl.href = payload.link.url; else linkEl.removeAttribute('href');
  const notes = payload.kind === 'notes';
  card.classList.toggle('wide', notes);
  card.setAttribute('role', notes ? 'dialog' : 'alertdialog');
  // The switch stays in view under a long list; other dialogs keep it with their text.
  if (notes) card.insertBefore(checkboxRow, buttonsEl);
  else textEl.append(checkboxRow);
  if (notes) document.getElementById('head').scrollTop = 0;
}

const DESTRUCTIVE = /^(remove|clear|delete|leave)$/i;

let current = null; // { id, defaultId, cancelId, kind }
let fieldInputs = [];

// ---- the device chooser (kind "devices"): one row picked, Connect enabled once there is one ----
let deviceItems = [];
let selectedDevice = '';
let connectButton = null;

function renderDevices() {
  if (!deviceItems.some((d) => d.id === selectedDevice)) selectedDevice = '';
  devicesEl.replaceChildren(...deviceItems.map((d, i) => {
    const row = document.createElement('div');
    row.className = 'device';
    row.id = 'device-' + i;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(d.id === selectedDevice));
    row.dataset.id = d.id;
    row.append(Object.assign(document.createElement('span'), { className: 'd-name', textContent: d.name }));
    if (d.detail) row.append(Object.assign(document.createElement('span'), { className: 'd-id', textContent: d.detail }));
    return row;
  }));
  const selected = devicesEl.querySelector('[aria-selected="true"]');
  if (selected) devicesEl.setAttribute('aria-activedescendant', selected.id); else devicesEl.removeAttribute('aria-activedescendant');
  devicesEl.hidden = deviceItems.length === 0;
  devicesEmptyEl.hidden = deviceItems.length !== 0;
  if (connectButton) connectButton.disabled = !selectedDevice;
}

function pickDevice(id, event) {
  if (!event.isTrusted) return; // only a real click or key chooses: never an event a script made
  selectedDevice = id;
  renderDevices();
  devicesEl.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

devicesEl.addEventListener('click', (e) => { const row = e.target.closest?.('.device'); if (row) pickDevice(row.dataset.id, e); });
devicesEl.addEventListener('dblclick', (e) => { const row = e.target.closest?.('.device'); if (row && e.isTrusted && current?.kind === 'devices') { pickDevice(row.dataset.id, e); respond(current.defaultId, e); } });
devicesEl.addEventListener('keydown', (e) => {
  if (current?.kind !== 'devices' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  e.preventDefault();
  if (!deviceItems.length) return;
  const at = deviceItems.findIndex((d) => d.id === selectedDevice);
  const next = e.key === 'ArrowDown' ? Math.min(deviceItems.length - 1, at + 1) : Math.max(0, at === -1 ? 0 : at - 1);
  pickDevice(deviceItems[next].id, e);
});

window.dialogHost.onUpdate?.((payload) => {
  if (!current || current.kind !== 'devices' || payload.id !== current.id) return;
  deviceItems = payload.items || [];
  renderDevices();
});

function respond(index, event) {
  if (!current) return;
  const result = { id: current.id, response: index, checkboxChecked: checkboxInput.checked };
  if (current.kind === 'devices') {
    result.choice = index === current.cancelId ? '' : selectedDevice;
    result.trusted = Boolean(event && event.isTrusted); // a click or key the browser made, not a script's dispatchEvent
    if (index !== current.cancelId && (!result.choice || !result.trusted)) return; // Connect: only with a choice and a real click or key (the main process checks again)
  }
  if (current.kind === 'ask') {
    result.values = index === current.cancelId ? null : Object.fromEntries(fieldInputs.map((el) => [el.dataset.name, el.value]));
  }
  current = null;
  backdrop.classList.remove('shown');
  card.classList.remove('entering');
  window.dialogHost.respond(result);
}

window.dialogHost.onShow((payload) => {
  current = { id: payload.id, defaultId: payload.defaultId, cancelId: payload.cancelId, kind: payload.kind };

  titleEl.textContent = payload.title || '';
  titleEl.hidden = !payload.title;
  messageEl.textContent = payload.message || '';
  detailEl.textContent = payload.detail || '';
  detailEl.hidden = !payload.detail;
  iconEl.hidden = payload.type !== 'warning';

  fieldsEl.replaceChildren();
  fieldInputs = [];
  for (const field of payload.fields || []) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'field-label';
    labelSpan.textContent = field.label || '';
    const input = document.createElement('input');
    input.type = field.type === 'password' ? 'password' : 'text';
    input.value = field.value || '';
    input.dataset.name = field.name;
    input.autocomplete = field.type === 'password' ? 'current-password' : 'off';
    wrap.append(labelSpan, input);
    fieldsEl.append(wrap);
    fieldInputs.push(input);
  }
  fieldsEl.hidden = fieldInputs.length === 0;

  renderNotes(payload);

  const devices = payload.kind === 'devices';
  deviceItems = devices ? payload.items || [] : [];
  selectedDevice = '';
  connectButton = null;
  devicesEmptyEl.textContent = payload.emptyText || '';
  if (devices) renderDevices(); else { devicesEl.hidden = true; devicesEmptyEl.hidden = true; }

  checkboxRow.hidden = !payload.checkboxLabel;
  checkboxLabelEl.textContent = payload.checkboxLabel || '';
  checkboxInput.checked = Boolean(payload.checkboxChecked);

  buttonsEl.replaceChildren();
  payload.buttons.forEach((label, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    if (DESTRUCTIVE.test(label)) btn.classList.add('danger');
    else if (index === payload.defaultId) btn.classList.add('primary');
    btn.textContent = label;
    btn.addEventListener('click', (e) => respond(index, e));
    if (devices && index === payload.defaultId) { connectButton = btn; btn.disabled = !selectedDevice; }
    buttonsEl.append(btn);
  });

  backdrop.classList.add('shown');
  card.classList.remove('entering');
  void card.offsetWidth; // restart the entrance animation for every new dialog
  card.classList.add('entering');
  const focusTarget = (devices && devicesEl) || fieldInputs[0] || buttonsEl.querySelector('.primary') || buttonsEl.lastElementChild;
  focusTarget?.focus();
  if (focusTarget && focusTarget.tagName === 'INPUT') focusTarget.select();
});

document.addEventListener('keydown', (e) => {
  if (!current) return;
  if (e.key === 'Enter' && e.target?.tagName !== 'BUTTON') { e.preventDefault(); respond(current.defaultId, e); }
  else if (e.key === 'Escape') { e.preventDefault(); respond(current.cancelId, e); }
});
