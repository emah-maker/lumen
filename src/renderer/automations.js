// lumen://automations: the Automations list, an automation's editor, the profile, a run's queue and the tracker
// (features/automations-runtime.js does the work; main.js answers each call). Views are in the address's hash:
// #list, #edit/<id|new>, #run/<runId>, #profile, #tracker. Updates come on automations:changed.
const api = window.lumenAutomations;
const tr = window.t || ((key) => key);
// A string from the table, or the English written here when the table has none.
const T = (key, en, vars) => { const s = tr(key, vars); return s === key ? (vars ? en.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : en) : s; };
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};
let data = null;
let draft = null; // the automation being edited (a copy), kept across redraws
let profileDraft = null;
let learned = []; // answers a recording offered for the profile
let recording = false;

const say = (text) => { $('status').textContent = text || ''; };
const when = (time) => {
  if (!time) return '';
  const d = new Date(time);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const route = () => { const [view, id] = location.hash.slice(1).split('/'); return { view: view || 'list', id: id || '' }; };
const go = (hash) => { if (location.hash !== `#${hash}`) location.hash = hash; else draw(); };
const STATUS = {
  queued: () => T('automations.status.queued', 'Waiting'), running: () => T('automations.status.running', 'Working'), review: () => T('automations.status.review', 'Ready to submit'),
  'needs-you': () => T('automations.status.needs', 'Needs you'), done: () => T('automations.status.done', 'Submitted'), failed: () => T('automations.status.failed', 'Failed'),
  skipped: () => T('automations.status.skipped', 'Skipped'), stopped: () => T('automations.status.stopped', 'Stopped'),
};
const NEED = {
  login: () => T('automations.need.login', 'The site wants you to sign in. Sign in in its tab, then press Continue.'),
  captcha: () => T('automations.need.captcha', 'The site shows a CAPTCHA. Solve it in its tab, then press Continue.'),
  questions: () => T('automations.need.questions', 'These questions have no saved answer. Fill them in in its tab (or add them to your profile), then press Continue:'),
  file: () => T('automations.need.file', 'A file is needed that your profile doesn’t have. Add it in its tab, then press Continue:'),
  noform: () => T('automations.need.noform', 'No application form was found on this page. Open it, get to the form, then press Continue.'),
  nosubmit: () => T('automations.need.nosubmit', 'The Submit button wasn’t found. Submit it yourself in its tab and press Mark as done, or skip it.'),
  rejected: () => T('automations.need.rejected', 'The site didn’t accept it. Fix these in its tab, then press Continue:'),
  step: () => T('automations.need.step', 'A step of the automation didn’t work on this page. Do it yourself in its tab, then press Continue.'),
  check: () => T('automations.need.check', 'Lumen couldn’t tell whether it went through. Look at its tab, then press Mark as done or Continue.'),
};
const FIELD_LABELS = {
  firstName: 'First name', lastName: 'Last name', fullName: 'Full name', email: 'Email', phone: 'Phone', address: 'Street address', city: 'City', state: 'State', zip: 'ZIP code', country: 'Country',
  linkedin: 'LinkedIn', github: 'GitHub', website: 'Website or portfolio', school: 'School', degree: 'Degree', major: 'Major', gradDate: 'Graduation date', gpa: 'GPA',
  workAuth: 'Authorized to work here?', sponsorship: 'Need visa sponsorship?', startDate: 'Earliest start date',
};

async function act(fn, ok) {
  let r;
  try { r = await fn(); } catch (err) { r = { ok: false, error: String(err?.message || err) }; }
  if (r && r.ok === false) say(r.error || T('automations.failed', 'That didn’t work.'));
  else if (ok) say(ok);
  await refresh();
  return r;
}

function button(label, onclick, { primary = false, id, disabled = false, aria } = {}) {
  return el('button', { type: 'button', class: primary ? 'primary' : '', id, disabled, 'aria-label': aria, onclick }, label);
}

// ---------- list ----------
function inputsText(a) {
  if (a.inputs.kind === 'search') return T('automations.inputs.search', 'Search: {host}{match}', { host: (() => { try { return new URL(a.inputs.searchUrl).host; } catch { return '—'; } })(), match: a.inputs.match ? ` · “${a.inputs.match}”` : '' });
  return T('automations.inputs.urls', '{n} pages', { n: a.inputs.urls.length });
}
function scheduleText(s) {
  if (!s) return '';
  if (s.repeat === 'hours') return T('automations.schedule.hours', 'Every {n} hours', { n: s.hours });
  if (s.repeat === 'daily') return T('automations.schedule.daily', 'Every day at {time}', { time: s.time });
  if (s.repeat === 'weekdays') return T('automations.schedule.weekdays', 'Every weekday at {time}', { time: s.time });
  const names = s.days.map((d) => new Date(2024, 0, 7 + d).toLocaleDateString([], { weekday: 'short' })).join(', ');
  return T('automations.schedule.weekly', '{days} at {time}', { days: names, time: s.time });
}

function drawList(view) {
  view.append(el('p', { class: 'lede', text: T('automations.lede', 'Repeat a job on a list of pages, like applying to postings. Each page opens in its own tab, forms are filled from your profile, and nothing is submitted until you approve it.') }));
  const create = el('section', { class: 'card create', 'aria-labelledby': 'create-h' },
    el('h2', { id: 'create-h', text: T('automations.create', 'New automation') }),
    el('label', { class: 'field' }, T('automations.create.describe', 'Describe it'),
      el('textarea', { id: 'describe', rows: '3', placeholder: T('automations.create.placeholder', 'Apply to new mechanical co-op postings on https://… that match “mechanical”, every weekday at 9am') })),
    el('div', { class: 'actions' },
      button(T('automations.create.make', 'Make it'), makeFromText, { primary: true, id: 'describe-go' }),
      button(recording ? T('automations.create.stop', 'Stop recording') : T('automations.create.record', 'Record it'), recordToggle, { id: 'record' }),
      button(T('automations.create.blank', 'Start blank'), () => { draft = blank(); go('edit/new'); }, { id: 'blank' })),
    recording ? el('p', { class: 'hint', text: T('automations.create.recording', 'Recording: do the job once in a tab, up to the Submit button (don’t submit), then come back and press Stop recording.') }) : null);
  view.append(create);
  const list = el('section', { 'aria-labelledby': 'list-h' }, el('h2', { id: 'list-h', text: T('automations.list', 'Your automations') }));
  if (!data.automations.length) list.append(el('p', { class: 'empty', text: T('automations.list.empty', 'None yet.') }));
  for (const a of data.automations) {
    const bits = [inputsText(a), a.scheduleOn && a.schedule ? scheduleText(a.schedule) + (a.nextRun ? ` · ${T('automations.next', 'next {when}', { when: when(a.nextRun) })}` : '') : '', a.projectId ? (data.projects.find((p) => p.id === a.projectId)?.name || '') : ''].filter(Boolean);
    list.append(el('div', { class: 'row automation', dataset: { id: a.id } },
      el('div', { class: 'main' }, el('span', { class: 'title', text: a.name }), el('span', { class: 'detail', text: bits.join(' · ') })),
      el('div', { class: 'actions always' },
        a.runningId ? button(T('automations.view', 'View run'), () => go(`run/${a.runningId}`)) : button(T('automations.runNow', 'Run now'), () => runNow(a.id), { primary: true, aria: T('automations.runNamed', 'Run {name}', { name: a.name }) }),
        button(T('automations.edit', 'Edit'), () => { draft = JSON.parse(JSON.stringify(a)); go(`edit/${a.id}`); }))));
  }
  view.append(list);
  const runs = el('section', { 'aria-labelledby': 'runs-h' }, el('h2', { id: 'runs-h', text: T('automations.runs', 'Runs') }));
  if (!data.runs.length) runs.append(el('p', { class: 'empty', text: T('automations.runs.empty', 'No runs yet.') }));
  for (const r of data.runs.slice(0, 10)) runs.append(runRow(r));
  view.append(runs);
}
function runRow(r) {
  const c = r.counts;
  const summary = [c.done ? T('automations.count.done', '{n} submitted', { n: c.done }) : '', c.review ? T('automations.count.review', '{n} to review', { n: c.review }) : '', c['needs-you'] ? T('automations.count.needs', '{n} need you', { n: c['needs-you'] }) : '', c.failed ? T('automations.count.failed', '{n} failed', { n: c.failed }) : '', c.queued ? T('automations.count.queued', '{n} waiting', { n: c.queued }) : ''].filter(Boolean).join(' · ') || r.error || T(`automations.run.${r.state}`, r.state);
  return el('div', { class: 'row run' }, el('a', { href: `#run/${r.id}` }, el('span', { class: 'title', text: r.name }), el('span', { class: 'detail', text: `${when(r.startedAt)} · ${summary}` })));
}

async function runNow(id) {
  const r = await act(() => api.run(id));
  if (r?.ok && r.runId) go(`run/${r.runId}`);
}
async function makeFromText() {
  const text = $('describe').value.trim();
  if (!text) { say(T('automations.error.describe', 'Describe what the automation should do.')); return; }
  $('describe-go').disabled = true;
  say(T('automations.drafting', 'Making a draft…'));
  const r = await api.describe(text);
  if (!r?.ok) { say(r?.error || T('automations.failed', 'That didn’t work.')); $('describe-go').disabled = false; return; }
  draft = { ...blank(), ...r.draft };
  say(T('automations.drafted', 'Here’s a draft. Check it, pick a profile and save it.'));
  go('edit/new');
}
async function recordToggle() {
  if (!recording) {
    const r = await api.recordStart();
    if (!r?.ok) { say(r?.error || T('automations.failed', 'That didn’t work.')); return; }
    recording = true;
    say(T('automations.create.recording', 'Recording: do the job once in a tab, up to the Submit button (don’t submit), then come back and press Stop recording.'));
    draw();
    return;
  }
  recording = false;
  const r = await api.recordStop();
  if (!r?.ok) { say(T('automations.failed', 'That didn’t work.')); draw(); return; }
  draft = { ...blank(), steps: r.steps, submit: r.submit, inputs: { ...blank().inputs, urls: r.startUrl ? [r.startUrl] : [] } };
  learned = r.learned || [];
  say(T('automations.recorded', 'Recorded {n} steps. Add the pages to run it on, pick a profile and save.', { n: r.steps.length }));
  go('edit/new');
}
const blank = () => ({ id: '', name: '', description: '', inputs: { kind: 'urls', urls: [], searchUrl: '', match: '', limit: 10, skipDone: true }, steps: [], submit: null, profileId: data?.profiles[0]?.id || '', projectId: '', submitMode: 'review', schedule: null, scheduleOn: false });

// ---------- editor ----------
const stepText = (s) => {
  const what = s.locator ? (s.locator.name || s.locator.text || s.locator.label || s.locator.id || '') : '';
  if (s.type === 'click') return T('automations.step.click', 'Click “{what}”', { what });
  if (s.type === 'wait') return s.mode === 'seconds' ? T('automations.step.wait', 'Wait {n} s', { n: s.seconds }) : T('automations.step.waitFor', 'Wait for the page');
  if (s.type === 'key') return T('automations.step.key', 'Press {key}', { key: s.key });
  if (s.type === 'scroll') return T('automations.step.scroll', 'Scroll {dir}', { dir: s.direction });
  return s.type;
};
function drawEdit(view, id) {
  if (!draft || (id !== 'new' && draft.id !== id)) {
    const a = data.automations.find((x) => x.id === id);
    if (!a) { go('list'); return; }
    draft = JSON.parse(JSON.stringify(a));
  }
  const d = draft;
  const sync = () => { // the form's values into the draft
    d.name = $('a-name').value;
    d.description = $('a-desc').value;
    d.inputs.kind = $('a-kind-search').checked ? 'search' : 'urls';
    d.inputs.urls = $('a-urls').value.split(/\s+/).filter(Boolean);
    d.inputs.searchUrl = $('a-search').value.trim();
    d.inputs.match = $('a-match').value;
    d.inputs.limit = Number($('a-limit').value) || 10;
    d.inputs.skipDone = $('a-skip').checked;
    d.profileId = $('a-profile').value;
    d.projectId = $('a-project').value;
    d.submitMode = $('a-auto').checked ? 'auto' : 'review';
    const rep = $('a-repeat').value;
    d.scheduleOn = rep !== 'off';
    d.schedule = rep === 'off' ? d.schedule : rep === 'hours' ? { repeat: 'hours', hours: Number($('a-hours').value) || 6 } : { repeat: rep, time: $('a-time').value || '09:00', days: rep === 'weekly' ? [1] : undefined };
  };
  const rep = d.scheduleOn && d.schedule ? d.schedule.repeat : 'off';
  const radio = (id, value, label, checked) => el('label', { class: 'choice' }, el('input', { type: 'radio', name: 'a-kind', id, value, checked, onchange: () => { sync(); draw(); } }), label);
  const form = el('form', { class: 'edit', id: 'editor', onsubmit: (e) => e.preventDefault() },
    el('label', { class: 'wide' }, T('automations.edit.name', 'Name'), el('input', { id: 'a-name', value: d.name, maxlength: '80' })),
    el('label', { class: 'wide' }, T('automations.edit.desc', 'What it does (for you)'), el('textarea', { id: 'a-desc', rows: '2' }, d.description || '')),
    el('fieldset', { class: 'wide' }, el('legend', { text: T('automations.edit.inputs', 'Run it on') }),
      radio('a-kind-urls', 'urls', T('automations.edit.kind.urls', 'These pages'), d.inputs.kind !== 'search'),
      radio('a-kind-search', 'search', T('automations.edit.kind.search', 'The links on a search page'), d.inputs.kind === 'search'),
      el('label', { class: d.inputs.kind === 'search' ? 'hidden' : '' }, T('automations.edit.urls', 'Addresses, one per line'), el('textarea', { id: 'a-urls', rows: '5' }, d.inputs.urls.join('\n'))),
      el('div', { class: d.inputs.kind === 'search' ? 'grid' : 'hidden' },
        el('label', { class: 'wide' }, T('automations.edit.searchUrl', 'Search page address'), el('input', { id: 'a-search', value: d.inputs.searchUrl, placeholder: 'https://' })),
        el('label', {}, T('automations.edit.match', 'A link must have these words'), el('input', { id: 'a-match', value: d.inputs.match })),
        el('label', {}, T('automations.edit.limit', 'New ones per run'), el('input', { id: 'a-limit', type: 'number', min: '1', max: '50', value: String(d.inputs.limit) }))),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'a-skip', checked: d.inputs.skipDone !== false }), T('automations.edit.skipDone', 'Skip pages already submitted (the tracker has them)'))),
    el('div', { class: 'wide steps' }, el('span', { class: 'label', text: T('automations.edit.steps', 'Steps to reach the form') }),
      d.steps.length ? el('ol', {}, d.steps.map((s, i) => el('li', {}, stepText(s), ' ', button(T('automations.edit.removeStep', 'Remove'), () => { sync(); d.steps.splice(i, 1); draw(); })))) : el('p', { class: 'hint', text: T('automations.edit.noSteps', 'None: the form is on the page itself. Record the job to add the clicks that lead to it.') }),
      el('p', { class: 'hint', text: d.submit ? T('automations.edit.submitRecorded', 'Stops before: “{what}”', { what: d.submit.name || d.submit.text || d.submit.id || '' }) : T('automations.edit.submitFound', 'Stops before the form’s own Submit button.') })),
    el('label', {}, T('automations.edit.profile', 'Profile'), el('select', { id: 'a-profile' }, el('option', { value: '' }, T('automations.edit.noProfile', 'None (make one first)')), data.profiles.map((p) => el('option', { value: p.id, selected: p.id === d.profileId }, p.name)))),
    el('label', {}, T('automations.edit.project', 'Project'), el('select', { id: 'a-project' }, el('option', { value: '' }, T('automations.edit.noProject', 'None')), data.projects.map((p) => el('option', { value: p.id, selected: p.id === d.projectId }, p.name)))),
    el('label', {}, T('automations.edit.repeat', 'Schedule'), el('select', { id: 'a-repeat', onchange: () => { sync(); draw(); } },
      [['off', T('automations.edit.repeat.off', 'Only when I run it')], ['daily', T('automations.edit.repeat.daily', 'Every day')], ['weekdays', T('automations.edit.repeat.weekdays', 'Every weekday')], ['hours', T('automations.edit.repeat.hours', 'Every few hours')]].map(([v, l]) => el('option', { value: v, selected: v === rep }, l)))),
    rep === 'hours' ? el('label', {}, T('automations.edit.hours', 'Hours apart'), el('input', { id: 'a-hours', type: 'number', min: '1', max: '24', value: String(d.schedule?.hours || 6) }))
      : el('label', { class: rep === 'off' ? 'hidden' : '' }, T('automations.edit.time', 'At'), el('input', { id: 'a-time', type: 'time', value: d.schedule?.time || '09:00' })),
    el('label', { class: 'wide check' }, el('input', { type: 'checkbox', id: 'a-auto', checked: d.submitMode === 'auto' }),
      T('automations.edit.auto', 'Submit without asking when Lumen is in Bypass permissions')),
    el('p', { class: 'wide hint', text: data.mode === 'bypass' ? T('automations.edit.autoOn', 'Lumen is in Bypass permissions now: with this on, forms are submitted without stopping for review. Sign-ins, CAPTCHAs and unanswered questions still wait for you.') : T('automations.edit.autoOff', 'Every form stops at Submit for you to approve. With this on, it only submits alone while you pick Bypass permissions in the sidebar.') }),
    learned.length ? el('label', { class: 'wide check' }, el('input', { type: 'checkbox', id: 'a-learn', checked: true }), T('automations.edit.learn', 'Add the {n} answers you typed while recording to the profile', { n: learned.length })) : null,
    el('div', { class: 'buttons' },
      el('span', { class: 'error', id: 'a-error' }),
      d.id ? button(T('automations.edit.delete', 'Delete'), async () => { if (!confirm(T('automations.edit.deleteAsk', 'Delete “{name}”? The tracker keeps what it did.', { name: d.name }))) return; await act(() => api.remove(d.id)); draft = null; go('list'); }) : null,
      button(T('automations.edit.cancel', 'Cancel'), () => { draft = null; learned = []; go('list'); }),
      button(T('automations.edit.save', 'Save'), async () => {
        sync();
        if (d.inputs.kind === 'search' && !d.inputs.searchUrl) { $('a-error').textContent = T('automations.error.noSearch', 'Give the search page’s address.'); return; }
        const r = await api.save(d);
        if (!r?.ok) { $('a-error').textContent = r?.error || ''; return; }
        if (learned.length && $('a-learn')?.checked && d.profileId) {
          const p = data.profiles.find((x) => x.id === d.profileId);
          if (p) await api.saveProfile({ ...p, answers: [...p.answers, ...learned] });
        }
        learned = [];
        draft = null;
        say(T('automations.saved', 'Saved.'));
        await refresh();
        go('list');
      }, { primary: true, id: 'a-save' })));
  view.append(form);
}

// ---------- profile ----------
function drawProfile(view, id) {
  const pick = data.profiles.find((p) => p.id === id) || data.profiles[0];
  if (!profileDraft || (pick && profileDraft.id && profileDraft.id !== pick.id)) profileDraft = pick ? JSON.parse(JSON.stringify(pick)) : { id: '', name: T('automations.profile.default', 'My profile'), fields: {}, resumePath: '', coverLetterPath: '', coverLetterTemplate: '', answers: [] };
  const p = profileDraft;
  const sync = () => {
    p.name = $('p-name').value;
    for (const k of data.profileKeys) p.fields[k] = $(`p-${k}`).value;
    p.coverLetterTemplate = $('p-cover').value;
    p.answers = [...document.querySelectorAll('.answer')].map((row) => ({ question: row.querySelector('.q').value, answer: row.querySelector('.a').value })).filter((a) => a.question.trim());
  };
  const fileRow = (key, kind, label) => el('div', { class: 'wide file' }, el('span', { class: 'label', text: label }),
    el('span', { class: 'path', id: `p-${key}`, text: p[key] || T('automations.profile.noFile', 'No file chosen') }),
    button(T('automations.profile.choose', 'Choose…'), async () => { sync(); const f = await api.pickFile(kind); if (f) { p[key] = f; draw(); } }),
    p[key] ? button(T('automations.profile.clear', 'Clear'), () => { sync(); p[key] = ''; draw(); }) : null);
  view.append(el('p', { class: 'lede', text: data.keychain ? T('automations.profile.lede', 'What automations fill in. Kept on this computer only, encrypted with your system keychain. A question it has no answer for is always left to you.') : T('automations.profile.ledePlain', 'What automations fill in. Kept on this computer only (your system has no keychain, so the file isn’t encrypted). A question it has no answer for is always left to you.') }));
  if (data.profiles.length > 1) view.append(el('div', { class: 'segmented profiles' }, data.profiles.map((x) => el('button', { type: 'button', 'aria-pressed': String(x.id === p.id), onclick: () => { profileDraft = null; go(`profile/${x.id}`); } }, x.name))));
  view.append(el('form', { class: 'edit', id: 'profile', onsubmit: (e) => e.preventDefault() },
    el('label', { class: 'wide' }, T('automations.profile.name', 'Profile name'), el('input', { id: 'p-name', value: p.name })),
    data.profileKeys.map((k) => el('label', {}, T(`automations.field.${k}`, FIELD_LABELS[k] || k), el('input', { id: `p-${k}`, value: p.fields[k] || '' }))),
    fileRow('resumePath', 'resume', T('automations.profile.resume', 'Résumé file')),
    fileRow('coverLetterPath', 'cover', T('automations.profile.coverFile', 'Cover letter file (for a file upload)')),
    el('label', { class: 'wide' }, T('automations.profile.coverTemplate', 'Cover letter text (for a text box). {{company}}, {{role}}, {{name}} and {{date}} are filled in.'), el('textarea', { id: 'p-cover', rows: '6' }, p.coverLetterTemplate || '')),
    el('div', { class: 'wide answers' }, el('span', { class: 'label', text: T('automations.profile.answers', 'Answers to common questions') }),
      el('p', { class: 'hint', text: T('automations.profile.answersHint', 'A form question close to one of these gets its answer. Demographic and salary questions are only answered from here.') }),
      p.answers.map((a, i) => el('div', { class: 'answer' }, el('input', { class: 'q', value: a.question, 'aria-label': T('automations.profile.question', 'Question') }), el('input', { class: 'a', value: a.answer, 'aria-label': T('automations.profile.answer', 'Answer') }), button(T('automations.edit.removeStep', 'Remove'), () => { sync(); p.answers.splice(i, 1); draw(); }))),
      button(T('automations.profile.addAnswer', 'Add an answer'), () => { sync(); p.answers.push({ question: '', answer: '' }); draw(); }, { id: 'p-add' })),
    el('div', { class: 'buttons' },
      el('span', { class: 'error', id: 'p-error' }),
      p.id ? button(T('automations.profile.delete', 'Delete profile'), async () => { if (!confirm(T('automations.profile.deleteAsk', 'Delete this profile?'))) return; await act(() => api.removeProfile(p.id)); profileDraft = null; go('profile'); }) : null,
      p.id ? button(T('automations.profile.new', 'New profile'), () => { profileDraft = { id: '', name: '', fields: {}, resumePath: '', coverLetterPath: '', coverLetterTemplate: '', answers: [] }; draw(); }) : null,
      button(T('automations.profile.save', 'Save profile'), async () => {
        sync();
        const r = await api.saveProfile(p);
        if (!r?.ok) { $('p-error').textContent = r?.error || ''; return; }
        profileDraft = r.profile;
        say(T('automations.saved', 'Saved.'));
        await refresh();
      }, { primary: true, id: 'p-save' }))));
}

// ---------- a run ----------
function drawRun(view, id) {
  const run = data.runs.find((r) => r.id === id);
  if (!run) { view.append(el('p', { class: 'empty', text: T('automations.run.gone', 'That run is no longer kept.') })); return; }
  const c = run.counts;
  $('heading').textContent = run.name;
  view.append(el('p', { class: 'lede', text: `${T(`automations.run.${run.state}`, run.state)} · ${when(run.startedAt)} · ${T('automations.run.progress', '{done} of {total} submitted', { done: c.done, total: c.total })}` }));
  if (run.live) {
    view.append(el('div', { class: 'run-actions' },
      run.state === 'paused' ? button(T('automations.run.resume', 'Resume'), () => act(() => api.runAct({ op: 'resume', runId: run.id })), { primary: true, id: 'r-resume' }) : button(T('automations.run.pause', 'Pause'), () => act(() => api.runAct({ op: 'pause', runId: run.id })), { id: 'r-pause' }),
      button(T('automations.run.stop', 'Stop'), () => act(() => api.runAct({ op: 'stop', runId: run.id })), { id: 'r-stop' })));
  }
  if (run.error) view.append(el('p', { class: 'hint', text: run.error }));
  const order = { review: 0, 'needs-you': 1, running: 2, queued: 3, failed: 4, done: 5, skipped: 6, stopped: 7 };
  const items = [...run.items].sort((a, b) => order[a.status] - order[b.status]);
  const list = el('section', { 'aria-labelledby': 'queue-h' }, el('h2', { id: 'queue-h', text: T('automations.run.queue', 'Queue') }));
  for (const item of items) list.append(itemCard(run, item));
  view.append(list);
}
function itemCard(run, item) {
  const go2 = (op) => act(() => api.item({ op, runId: run.id, itemId: item.id }));
  const b = (op, label, primary) => button(label, () => go2(op), { primary, aria: `${label}: ${item.role || item.url}` });
  const buttons = [];
  if (run.live) {
    if (item.status === 'review') buttons.push(b('approve', T('automations.item.approve', 'Submit'), true), b('open', T('automations.item.open', 'Open tab')), b('skip', T('automations.item.skip', 'Skip')));
    if (item.status === 'needs-you') buttons.push(b('open', T('automations.item.open', 'Open tab'), true), b('continue', T('automations.item.continue', 'Continue')), b('done', T('automations.item.markDone', 'Mark as done')), b('skip', T('automations.item.skip', 'Skip')));
    if (item.status === 'queued') buttons.push(b('skip', T('automations.item.skip', 'Skip')));
    if (['failed', 'stopped', 'skipped'].includes(item.status)) buttons.push(b('retry', T('automations.item.retry', 'Try again')));
    if (item.hasTab && !['review', 'needs-you'].includes(item.status)) buttons.push(b('open', T('automations.item.open', 'Open tab')));
  }
  const filled = (item.filled || []).length ? el('details', { open: item.status === 'review' }, el('summary', {}, T('automations.item.filled', 'What was filled ({n})', { n: item.filled.length })),
    el('table', { class: 'filled' }, item.filled.map((f) => el('tr', {}, el('th', { text: f.label }), el('td', { text: f.value }))))) : null;
  return el('div', { class: `card item status-${item.status}`, dataset: { id: item.id, status: item.status } },
    el('div', { class: 'who' }, el('span', { class: 'chip', text: STATUS[item.status]() }), ' ', item.company || ''),
    el('p', { class: 'what', text: item.role || item.url }),
    el('a', { class: 'detail url', href: item.url, text: item.url, onclick: (e) => { e.preventDefault(); if (item.hasTab) go2('open'); } }),
    item.status === 'needs-you' && item.need ? el('p', { class: 'need', text: NEED[item.need] ? NEED[item.need]() : item.need }) : null,
    item.questions?.length && item.status === 'needs-you' ? el('ul', { class: 'questions' }, item.questions.map((q) => el('li', { text: q }))) : null,
    item.status === 'review' ? el('p', { class: 'need', text: T('automations.item.reviewHint', 'Check what was filled. Submit sends it; Open tab lets you change it first.') }) : null,
    item.note ? el('p', { class: 'hint', text: item.note }) : null,
    filled,
    buttons.length ? el('div', { class: 'actions' }, buttons) : null);
}

// ---------- tracker ----------
function drawTracker(view) {
  view.append(el('p', { class: 'lede', text: T('automations.tracker.lede', 'Every page an automation finished: what was filled and whether it was submitted. {n} kept.', { n: data.logCount }) }));
  view.append(el('div', { class: 'run-actions' },
    button(T('automations.tracker.export', 'Export CSV'), () => act(() => api.exportCsv(), T('automations.tracker.exported', 'Exported.')), { primary: true, id: 't-export', disabled: !data.logCount }),
    button(T('automations.tracker.clear', 'Clear'), async () => { if (confirm(T('automations.tracker.clearAsk', 'Clear the tracker? Exported files are kept.'))) await act(() => api.clearLog()); }, { id: 't-clear', disabled: !data.logCount })));
  if (!data.log.length) { view.append(el('p', { class: 'empty', text: T('automations.tracker.empty', 'Nothing yet.') })); return; }
  view.append(el('table', { class: 'tracker' },
    el('thead', {}, el('tr', {}, [T('automations.tracker.date', 'Date'), T('automations.tracker.company', 'Company'), T('automations.tracker.role', 'Role'), T('automations.tracker.status', 'Status')].map((h) => el('th', { text: h })))),
    el('tbody', {}, data.log.map((e) => el('tr', {}, el('td', { text: when(e.at) }), el('td', { text: e.company || '' }), el('td', {}, el('span', { text: e.role || e.url, title: e.url })), el('td', { text: STATUS[e.status] ? STATUS[e.status]() : e.status }))))));
}

// ---------- drawing ----------
function draw() {
  if (!data) return;
  const { view, id } = route();
  const host = $('view');
  // Keep focus and what is being typed: the editors are drawn from their drafts, which sync() keeps current.
  const focused = document.activeElement?.id;
  host.replaceChildren();
  $('heading').textContent = T('automations.title', 'Automations');
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-pressed', String(b.dataset.view === view || (view === 'edit' && b.dataset.view === 'list') || (view === 'run' && b.dataset.view === 'list')));
  if (data.unreadable) host.append(el('p', { class: 'hint error', text: T('automations.unreadable', 'Lumen couldn’t read its automations file (a copy was kept), so nothing is saved until it can.') }));
  if (view === 'edit') drawEdit(host, id);
  else if (view === 'profile') drawProfile(host, id);
  else if (view === 'run') drawRun(host, id);
  else if (view === 'tracker') drawTracker(host);
  else drawList(host);
  if (focused && $(focused)) $(focused).focus();
}
async function refresh() {
  try { data = await api.state(); } catch { data = null; }
  const { view } = route();
  // An editor being typed in is not redrawn by an update from elsewhere.
  if (data && !(view === 'edit' || view === 'profile') ) draw();
  else if (data && !document.getElementById(view === 'edit' ? 'editor' : 'profile')) draw();
}
for (const b of document.querySelectorAll('nav button')) b.addEventListener('click', () => { draft = null; profileDraft = null; go(b.dataset.view); });
window.addEventListener('hashchange', draw);
api.onChange(() => { refresh(); });
refresh();
