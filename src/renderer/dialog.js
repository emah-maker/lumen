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

function respond(index) {
  if (!current) return;
  const result = { id: current.id, response: index, checkboxChecked: checkboxInput.checked };
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
    btn.addEventListener('click', () => respond(index));
    buttonsEl.append(btn);
  });

  backdrop.classList.add('shown');
  card.classList.remove('entering');
  void card.offsetWidth; // restart the entrance animation for every new dialog
  card.classList.add('entering');
  const focusTarget = fieldInputs[0] || buttonsEl.querySelector('.primary') || buttonsEl.lastElementChild;
  focusTarget?.focus();
  if (focusTarget && focusTarget.tagName === 'INPUT') focusTarget.select();
});

document.addEventListener('keydown', (e) => {
  if (!current) return;
  if (e.key === 'Enter' && e.target?.tagName !== 'BUTTON') { e.preventDefault(); respond(current.defaultId); }
  else if (e.key === 'Escape') { e.preventDefault(); respond(current.cancelId); }
});
