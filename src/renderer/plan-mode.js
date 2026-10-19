// [plan mode] The composer's "Plan" chip, the /plan command and the plan card (ai/plan-mode.js has the rules and the tool gating).
// With the chip on, a message only lets the AI read, and it answers with propose_plan: main sends a 'plan' event, chat-core.js asks
// card() for the card and puts it in the reply. Run plan sends the plan as the user left it (edits included) as the next message,
// with plan mode off for that chat, and main allows exactly the plan's sites for the chat (main.js agent:ask approvedPlan).
// The chip is per chat: a new chat starts as Settings → AI → "Start new chats in plan mode" says (planModeDefault, ui-prefs.js).
// Claude Code, Codex, Grok Build and Antigravity bring tools of their own that Lumen can't hold back: on them the chip is off and
// says why (agent.js answers a plan-mode message there with a note too).
/* global shownChatId */ // renderer/chat-core.js: the chat the view shows
(() => {
  const rules = window.planMode; // ai/plan-mode.js
  const composer = document.getElementById('composer');
  const promptEl = document.getElementById('prompt');
  if (!rules || !composer || !promptEl) return;
  const tr = (key, fallback, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    return text && text !== key ? text : (vars ? fallback.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : fallback);
  };
  const CLI = /^(claudecode|grokbuild|antigravity|codex):/;
  const modelSelect = document.getElementById('model');
  const onCli = () => CLI.test(String(modelSelect?.value || ''));

  let on = false;
  const byChat = new Map(); // chat id -> the chip's state there (this view only)
  const remember = () => { if (shownChatId) byChat.set(shownChatId, on); };

  // The toggle is a row of the composer's + menu; while it is on, a small "Plan" tag beside + keeps the state in sight (click it to turn off).
  const chip = Object.assign(document.createElement('button'), { type: 'button', className: 'cm-item plan-chip', id: 'plan-chip' });
  chip.setAttribute('role', 'menuitemcheckbox');
  chip.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4h7M6 8h7M6 12h7"/><path d="M2.6 4h.8M2.6 8h.8M2.6 12h.8"/></svg><span class="cm-label plan-chip-text"></span>';
  chip.querySelector('.plan-chip-text').textContent = tr('plan.chip.label', 'Plan first');
  const menu = composer.querySelector('#composer-menu');
  if (menu) menu.append(chip);
  else composer.insertBefore(chip, composer.querySelector('#attach, #send'));
  const tag = document.getElementById('plan-tag');
  if (tag) tag.querySelector('.plan-tag-text').textContent = tr('plan.chip', 'Plan');

  function render() {
    const cli = onCli();
    chip.disabled = cli;
    chip.setAttribute('aria-pressed', String(on && !cli));
    chip.setAttribute('aria-checked', String(on && !cli));
    chip.title = cli ? tr('plan.chip.cli', 'Plan first works with API models. Claude Code, Codex, Grok Build and Antigravity have their own tools, so pick another model to plan first.')
      : on ? tr('plan.chip.on', 'Plan first is on: the AI only reads, then shows you a plan to run, edit or send back. Click to turn off.')
        : tr('plan.chip.off', 'Plan first: the AI only reads, then shows you a plan before it acts.');
    chip.setAttribute('aria-label', `${tr('plan.chip.label', 'Plan first')}: ${chip.title}`);
    composer.classList.toggle('planning', on && !cli);
    if (tag) {
      tag.hidden = !(on && !cli);
      tag.title = chip.title;
      tag.setAttribute('aria-label', `${tr('plan.chip.label', 'Plan first')}: ${chip.title}`);
    }
  }
  function setOn(value) { on = Boolean(value); remember(); render(); }
  chip.addEventListener('click', () => { setOn(!on); promptEl.focus(); });
  tag?.addEventListener('click', () => { setOn(false); promptEl.focus(); });
  modelSelect?.addEventListener('change', render);
  promptEl.addEventListener('focus', render); // (the model can change from another view)

  // A chat shown: the same one keeps the chip as it is; another one takes what it had here, or for an empty chat the Settings default.
  function chatShown(view, sameChat) {
    if (sameChat) { remember(); return; }
    const id = view?.id || null;
    on = id && byChat.has(id) ? byChat.get(id) : !(view?.items?.length || view?.live) && window.lumenPlanModeDefault === true;
    render();
  }

  // ---------- the card ----------
  const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});

  function card(plan) {
    const checked = rules.validatePlan(plan);
    if (!checked.plan) return null;
    const p = checked.plan;
    const box = el('div', 'msg assistant plan-card');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', tr('plan.card.label', 'Proposed plan: {title}', { title: p.title }));
    const head = el('div', 'plan-head');
    head.append(el('span', 'plan-kicker', tr('plan.card.kicker', 'Plan')), el('span', 'plan-title', p.title));
    const list = el('ol', 'plan-steps');
    p.steps.forEach((text, i) => {
      const li = el('li');
      if (p.risky_steps.includes(i + 1)) li.dataset.risky = '1';
      const span = el('span', 'plan-step-text', text);
      li.append(span);
      if (li.dataset.risky) li.append(el('span', 'plan-risky', tr('plan.card.risky', 'Risky')));
      list.append(li);
    });
    const sites = el('div', 'plan-sites');
    const siteList = el('span', 'plan-site-list');
    const drawSites = (hosts) => {
      siteList.replaceChildren();
      for (const host of hosts) {
        const chipEl = el('span', 'plan-site');
        chipEl.dataset.host = host;
        chipEl.append(el('span', '', host));
        const x = el('button', 'plan-site-x', '×');
        x.type = 'button';
        x.title = tr('plan.card.removeSite', 'Leave {site} out', { site: host });
        x.setAttribute('aria-label', x.title);
        x.onclick = () => { chipEl.remove(); if (!siteList.children.length) siteList.append(el('span', 'plan-none', tr('plan.card.noSites', 'none'))); };
        chipEl.append(x);
        siteList.append(chipEl);
      }
      if (!hosts.length) siteList.append(el('span', 'plan-none', tr('plan.card.noSites', 'none')));
    };
    drawSites(p.sites);
    sites.append(el('span', 'plan-label', tr('plan.card.sites', 'Sites it will act on:')), ' ', siteList);
    const note = el('div', 'plan-note', tr('plan.card.note', 'Run plan lets the AI click and type on these sites in this chat. Opening or sending to a site after reading a page still asks, and so does anything that buys, sends, posts or submits.'));
    const problem = el('div', 'plan-problem');
    problem.setAttribute('role', 'alert');
    problem.hidden = true;
    const actions = el('div', 'plan-actions');
    const run = el('button', 'btn primary plan-run', tr('plan.card.run', 'Run plan'));
    const edit = el('button', 'btn plan-edit', tr('plan.card.edit', 'Edit'));
    const keep = el('button', 'btn plan-keep', tr('plan.card.keep', 'Keep planning'));
    for (const b of [run, edit, keep]) b.type = 'button';
    actions.append(run, edit, keep);
    box.append(head, list, sites, note, problem, actions);

    let editing = false;
    edit.onclick = () => {
      editing = !editing;
      box.classList.toggle('editing', editing);
      for (const span of list.querySelectorAll('.plan-step-text')) {
        if (editing) { span.contentEditable = 'plaintext-only'; span.setAttribute('role', 'textbox'); span.setAttribute('aria-label', tr('plan.card.stepLabel', 'Step')); } else { span.removeAttribute('contenteditable'); span.removeAttribute('role'); }
      }
      edit.textContent = editing ? tr('plan.card.doneEditing', 'Done editing') : tr('plan.card.edit', 'Edit');
      if (editing) list.querySelector('.plan-step-text')?.focus();
    };
    // The plan as it stands on the card: emptied steps are left out, and a risky mark stays with its step.
    const current = () => {
      const steps = [];
      const risky = [];
      for (const li of list.children) {
        const text = li.querySelector('.plan-step-text')?.textContent.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        steps.push(text);
        if (li.dataset.risky) risky.push(steps.length);
      }
      return { title: p.title, steps, sites: [...siteList.querySelectorAll('.plan-site')].map((s) => s.dataset.host), risky_steps: risky };
    };
    run.onclick = () => {
      const got = rules.validatePlan(current());
      if (!got.plan) { problem.textContent = got.error; problem.hidden = false; return; }
      problem.hidden = true;
      setOn(false); // plan mode ends for this chat: the approved plan runs with the usual tools
      box.classList.add('used');
      for (const b of [run, edit, keep]) b.disabled = true;
      for (const span of list.querySelectorAll('[contenteditable]')) span.removeAttribute('contenteditable');
      for (const x of box.querySelectorAll('.plan-site-x')) x.remove();
      const text = rules.approvedText(got.plan, { head: tr('plan.approved.head', 'Run this plan. I approved it as written; still stop and ask me before anything that buys, pays, sends, posts, submits or deletes.'), sites: tr('plan.approved.sites', 'Sites:'), risky: tr('plan.approved.risky', 'Ask me before these steps as usual:') });
      window.ask(text, [], null, undefined, { approvedPlan: got.plan });
    };
    keep.onclick = () => {
      setOn(true); // the next message plans again: say what to change
      promptEl.focus();
    };
    return box;
  }

  // ---------- /plan <task> ----------
  window.slashCommands?.register({
    name: 'plan',
    label: tr('slash.plan', 'Plan first'),
    description: tr('slash.plan.description', 'The AI only reads, then shows a plan you can run, edit or send back: /plan book a table for two on Friday'),
    hint: tr('slash.plan.hint', 'The task to plan, then press Enter'),
    takesInput: true,
    run({ input }) {
      if (onCli()) return { ok: false, message: tr('plan.chip.cli', 'Plan first works with API models. Claude Code, Codex, Grok Build and Antigravity have their own tools, so pick another model to plan first.') };
      if (!input) { setOn(true); return { ok: true }; } // "/plan" alone: the chip goes on for this chat
      window.ask(input, [], null, undefined, { plan: true });
      return { ok: true };
    },
  });

  window.planModeUI = {
    forSend: () => on && !onCli(),
    card,
    chatShown,
    setOn,
    isOn: () => on,
  };
  // Settings changed the default: an empty chat that was never sent follows it.
  window.addEventListener('lumen:plan-default', () => { if (!shownChatId && !document.querySelector('#messages .msg')) { on = window.lumenPlanModeDefault === true; render(); } });
  on = window.lumenPlanModeDefault === true;
  render();
})();
