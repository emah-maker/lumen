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
