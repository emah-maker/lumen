// [ask options] The AI's question card (ai/ask-user.js has the tool and its rules). chat-core.js loads this file (and ask-card.css) with
// the first card, live or in a reopened chat, and asks card() for it. Each question shows its answers as chips plus an "Other…" chip
// that opens a text box. A card with one question and one pick sends on the click; otherwise the chips toggle and Send sends them all.
// The picks go to main (window.assistant.askAnswer): the waiting ask_user call takes them as its result and the run goes on. When no run
// waits any more (stopped, the wait ran out, a reopened chat), they are sent as the user's next message instead (window.ask).
// The card then shows what was picked, with the other chips greyed out. Plain buttons and a fieldset per question: Tab, Enter/Space and
// screen readers work as anywhere else; arrow keys move between a question's chips.
(() => {
  const rules = window.askUser; // ai/ask-user.js
  if (!rules) return;
  const tr = (key, fallback, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    const s = text && text !== key ? text : fallback;
    return vars ? s.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : s;
  };
  const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text !== undefined ? { textContent: text } : {});
  let seq = 0;

  // { askId, questions, answers?, live } -> the card element. `live`: its picks can still be sent (a run waits, or it is the chat's last
  // reply). A card with answers is drawn answered.
  function card({ askId, questions, answers = null, live = true } = {}) {
    const checked = rules.validateAsk({ questions: (questions || []).map((q) => ({ ...q, multi_select: q?.multi === true || q?.multi_select === true })) });
    if (!checked.questions) return null;
    const qs = checked.questions;
    const id = `ask-${++seq}`;
    const box = el('div', 'msg assistant ask-card');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', tr('ask.card.label', 'The AI asks you'));
    box.dataset.askId = String(askId || '');
    const picks = qs.map(() => new Set()); // per question: the labels picked (an Other text counts as one)
    const others = []; // per question: { wrap, input }
    const status = el('div', 'ask-status');
    status.setAttribute('role', 'status');
    const actions = el('div', 'ask-actions');
    const send = el('button', 'btn primary ask-send', tr('ask.card.send', 'Send'));
    send.type = 'button';
    const instant = qs.length === 1 && !qs[0].multi; // one question, one pick: the click sends
    actions.hidden = instant;
    actions.append(send);

    const ready = () => qs.every((_q, i) => picks[i].size > 0);
    const sync = () => {
      for (const [i, fs] of [...box.querySelectorAll('.ask-q')].entries()) {
        for (const b of fs.querySelectorAll('.ask-opt[data-label]')) b.setAttribute('aria-pressed', String(picks[i].has(b.dataset.label)));
      }
      send.disabled = !ready() || box.classList.contains('answered');
    };

    qs.forEach((q, i) => {
      const fs = el('fieldset', 'ask-q');
      const legend = el('legend', 'ask-legend');
      if (q.header) legend.append(el('span', 'ask-header', q.header));
      legend.append(el('span', 'ask-text', q.question));
      if (q.multi) legend.append(el('span', 'ask-hint', tr('ask.card.multi', 'Pick any that apply')));
      const row = el('div', 'ask-options');
      row.setAttribute('role', 'group');
      const choose = (label) => {
        if (box.classList.contains('answered')) return;
        if (q.multi) { if (picks[i].has(label)) picks[i].delete(label); else picks[i].add(label); } else { picks[i].clear(); picks[i].add(label); }
        sync();
        if (instant) submit();
      };
      for (const o of q.options) {
        const b = el('button', 'chip ask-opt');
        b.type = 'button';
        b.dataset.label = o.label;
        b.append(el('span', 'ask-opt-label', o.label));
        if (o.description) b.append(el('span', 'ask-opt-detail', o.description));
        b.setAttribute('aria-pressed', 'false');
        b.onclick = () => choose(o.label);
        row.append(b);
      }
      // Other: a chip that opens a text box; Enter (or Send) takes its text as this question's answer.
      const otherBtn = el('button', 'chip ask-opt ask-other-btn', tr('ask.card.other', 'Other…'));
      otherBtn.type = 'button';
      otherBtn.setAttribute('aria-expanded', 'false');
      const wrap = el('div', 'ask-other');
      wrap.hidden = true;
      const input = el('input');
      input.type = 'text';
      input.maxLength = rules.LIMITS.other;
      input.id = `${id}-other-${i}`;
      input.placeholder = tr('ask.card.otherPlaceholder', 'Type your answer');
      input.setAttribute('aria-label', tr('ask.card.otherLabel', 'Other answer: {question}', { question: q.question }));
      const ok = el('button', 'btn ask-other-ok', instant ? tr('ask.card.send', 'Send') : tr('ask.card.use', 'Use'));
      ok.type = 'button';
      const takeOther = () => {
        const text = input.value.replace(/\s+/g, ' ').trim();
        if (!text) { input.focus(); return; }
        if (!q.multi) picks[i].clear();
        for (const prev of [...picks[i]]) if (!q.options.some((o) => o.label === prev)) picks[i].delete(prev); // (one Other text per question)
        picks[i].add(text);
        otherBtn.setAttribute('aria-pressed', 'true');
        sync();
        if (instant) submit(); else if (ready()) send.focus();
      };
      otherBtn.onclick = () => {
        if (box.classList.contains('answered')) return;
        wrap.hidden = !wrap.hidden;
        otherBtn.setAttribute('aria-expanded', String(!wrap.hidden));
        if (!wrap.hidden) input.focus();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !isImeEnter(e)) { e.preventDefault(); takeOther(); } // (renderer/ime.js: not the Enter that picks an IME's text)
        else if (e.key === 'Escape') { wrap.hidden = true; otherBtn.setAttribute('aria-expanded', 'false'); otherBtn.focus(); }
      });
      ok.onclick = takeOther;
      wrap.append(input, ok);
      row.append(otherBtn);
      // Arrow keys move between this question's chips (Tab still leaves the group).
      row.addEventListener('keydown', (e) => {
        if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        const chips = [...row.querySelectorAll('.ask-opt:not(:disabled)')];
        const at = chips.indexOf(document.activeElement);
        if (at < 0) return;
        e.preventDefault();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? chips.length - 1 : (at + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + chips.length) % chips.length;
        chips[next].focus();
      });
      fs.append(legend, row, wrap);
      box.append(fs);
      others.push({ wrap, input, otherBtn });
    });
    box.append(actions, status);

    // The card shows `answers` as picked and takes no more clicks.
    function showAnswered(got) {
      box.classList.add('answered');
      box.dataset.state = 'answered';
      got.forEach((list, i) => {
        picks[i] = new Set(list);
        const extra = list.filter((a) => !qs[i].options.some((o) => o.label === a));
        if (extra.length) { others[i].otherBtn.setAttribute('aria-pressed', 'true'); others[i].otherBtn.textContent = tr('ask.card.otherPicked', 'Other: {text}', { text: extra.join(', ') }); }
      });
      sync();
      for (const b of box.querySelectorAll('button, input')) b.disabled = true;
      status.textContent = tr('ask.card.answered', 'You answered: {answers}', { answers: got.map((l) => l.join(', ')).join(' · ') });
    }
    let sending = false;
    async function submit() {
      if (sending || !ready() || box.classList.contains('answered')) return;
      sending = true;
      const got = rules.checkAnswers(qs, picks.map((s) => [...s]));
      if (!got) { sending = false; return; }
      showAnswered(got);
      let taken = false;
      try { taken = Boolean(box.dataset.askId && (await window.assistant?.askAnswer?.(box.dataset.askId, got))); } catch { /* main gone: send it as a message */ }
      if (!taken) window.ask?.(rules.answerText(qs, got, { message: true }));
    }
    send.onclick = submit;
    box.answer = (got) => { const c = rules.checkAnswers(qs, got); if (c && !box.classList.contains('answered')) showAnswered(c); };
    // The run stopped waiting: the card stays clickable, and its picks become the next message (submit: askAnswer says no).
    box.ended = () => { if (!box.classList.contains('answered')) box.dataset.state = 'ended'; };
    if (answers) { const c = rules.checkAnswers(qs, answers); if (c) showAnswered(c); } else if (!live) {
      box.classList.add('answered');
      box.dataset.state = 'unanswered';
      for (const b of box.querySelectorAll('button, input')) b.disabled = true;
      status.textContent = tr('ask.card.unanswered', 'Not answered here');
    }
    sync();
    return box;
  }

  window.askCard = { card };
})();
