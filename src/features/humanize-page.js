// [humanize] The main process's side of Humanize: the user's humanizer skill (features/skills.js humanizer) run on a text (ai/humanize.js):
//   rewrite(text, { kind })  one rewrite, with the skill's own instructions, on the user's own AI: the open chat's model (else the default), through the same route the
//                            AI uses: the provider's API with the user's key, or the engine's CLI with no tools. Nothing else is called.
//   fromMenu(wc, params)     the page's right-click "Humanize" on selected text. The selection is noted in the page first (which box,
//                            where in it), then a card over the window shows the text before and after. In a text box (an email, a
//                            document, a form) Replace puts the rewrite in place of the selection as typing would, so the page's
//                            own undo works too, and a toast offers Undo for a few seconds. On read-only text the card has Copy.
// Loaded on first use (main.js lazy): nothing here runs at startup.
const lib = require('../ai/humanize');

const WORLD = 1083; // a JavaScript world of our own in the page (the AI's is 1001, page text 1001, skills 1002, passwords 1077)
const UNDO_SECONDS = 10;
const SHOWN_CHARS = 4000; // the card shows this much of a long text (the whole rewrite still goes in)

// In the page, at the right-click: which editable box holds the selection, and where. Kept in the world for Replace and Undo.
const MARK = `(() => {
  const sel = window.getSelection();
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  const st = { el: null };
  const field = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(?:text|search|email|url|tel|)$/i.test(el.getAttribute('type') || '')));
  if (field && el.selectionStart !== el.selectionEnd && !el.readOnly && !el.disabled) {
    Object.assign(st, { el, kind: 'field', start: el.selectionStart, end: el.selectionEnd, text: el.value.slice(el.selectionStart, el.selectionEnd) });
  } else if (sel && sel.rangeCount && !sel.isCollapsed) {
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const host = (node.nodeType === 1 ? node : node.parentElement)?.closest?.('[contenteditable]:not([contenteditable="false"])');
    if (host && host.isContentEditable) Object.assign(st, { el: host, kind: 'rich', range: range.cloneRange(), text: sel.toString() });
  }
  window.__lumenHumanize = st;
  return st.el ? { editable: true, kind: st.kind, text: st.text } : { editable: false };
})()`;

// Puts `text` where the noted selection was. insertText is what typing does: the page hears an input event and its undo has a step.
const replaceScript = (text) => `((text) => {
  const st = window.__lumenHumanize;
  if (!st || !st.el || !st.el.isConnected) return { ok: false, error: 'gone' };
  st.el.focus();
  if (st.kind === 'field') {
    if (st.el.value.slice(st.start, st.end) !== st.text) return { ok: false, error: 'changed' };
    st.el.setSelectionRange(st.start, st.end);
  } else {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(st.range);
    if (sel.toString().replace(/\\s+/g, ' ').trim() !== st.text.replace(/\\s+/g, ' ').trim()) return { ok: false, error: 'changed' };
  }
  let done = false;
  try { done = document.execCommand('insertText', false, text); } catch {}
  if (st.kind === 'field' && st.el.value.slice(st.start, st.start + text.length) !== text) {
    st.el.setRangeText(text, st.start, st.end, 'end');
    st.el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
    done = true;
  }
  if (!done) return { ok: false, error: 'refused' };
  st.replaced = text;
  return { ok: true };
})(${JSON.stringify(text)})`;

// Takes the rewrite back out: the page's own undo first, then (a text field) the original put back by hand if undo did not.
const UNDO = `(() => {
  const st = window.__lumenHumanize;
  if (!st || typeof st.replaced !== 'string' || !st.el || !st.el.isConnected) return { ok: false };
  st.el.focus();
  let back = false;
  if (st.kind === 'field') {
    const at = st.el.value.slice(st.start, st.start + st.replaced.length) === st.replaced;
    if (at) { st.el.setSelectionRange(st.start, st.start + st.replaced.length); try { document.execCommand('undo'); } catch {} }
    back = st.el.value.slice(st.start, st.start + st.text.length) === st.text;
    if (!back && at) {
      st.el.setRangeText(st.text, st.start, st.start + st.replaced.length, 'select');
      st.el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'historyUndo' }));
      back = true;
    }
    if (back) st.el.setSelectionRange(st.start, st.start + st.text.length);
  } else {
    try { back = document.execCommand('undo'); } catch {}
  }
  if (back) st.replaced = null;
  return { ok: back };
})()`;

// deps: { agent, cliJson, providers, skill() -> skills.humanizer()'s answer, userData(), overlay (features/tool-overlay.js), t, copy(text), win(wc) -> BrowserWindow,
//   restoreFocus(wc), openSkills() (Settings → Skills), aiOff(url) -> boolean, modelName(id) -> string, subagentModel() -> 'same' | 'auto' }
function create(deps) {
  const { t } = deps;
  const runs = new Map(); // a key (a view's id, or 'page') -> AbortController: a new rewrite from the same place stops the old one

  // The model the open chat uses, else the default; 'auto' as the model Auto picks for a quick job.
  function chatModel(messages) {
    const a = deps.agent;
    return a.resolveAuto((messages || a.messages)?.settings?.model || a.getOptions().model || '');
  }

  async function apiCall(model, { system, messages, signal, maxTokens }) {
    const { provider, model: id } = deps.providers.splitModel(model);
    if (provider === 'anthropic') return deps.agent.getClient().messages.create({ model: id, max_tokens: maxTokens, system, messages }, { signal });
    const apiKey = deps.agent.getKey(provider);
    if (!apiKey) throw new Error(`Add your ${deps.providers.PROVIDERS[provider].label} API key to use this model.`);
    return deps.providers.streamTurn({ provider, model: id, apiKey, effort: '', system, messages, tools: [], signal, emit: () => {}, noTools: true });
  }

  async function cliCall({ engine, model, system, user, signal, timeoutMs }) {
    const runner = deps.agent.engines?.[engine];
    const bin = await runner?.detect?.();
    if (!bin) throw new Error(`${{ claudecode: 'Claude Code', grokbuild: 'Grok Build', antigravity: 'Antigravity' }[engine] || engine} isn’t installed.`);
    if (engine === 'claudecode') return (await deps.cliJson.completeText({ bin, model, system, user, timeoutMs, signal })).text;
    const answer = await deps.cliJson.completeJSON({ engine, bin, model, system, user, schema: lib.CLI_SCHEMA, userData: deps.userData(), timeoutMs, signal });
    return String(answer?.rewrite ?? '');
  }

  // One rewrite. key: who asked (a newer request from the same place stops the older one); messages: the chat whose model is used
  // (the sidebar's open chat by default). -> ai/humanize.js run's result plus `name`.
  async function rewrite(text, { kind = 'selection', key = 'page', messages = null } = {}) {
    runs.get(key)?.abort();
    const ctrl = new AbortController();
    runs.set(key, ctrl);
    try {
      const a = deps.agent;
      const options = a.fallbackOptionsList();
      const model = chatModel(messages);
      const defaultModel = a.resolveAuto(a.getOptions().model || '');
      const local = !lib.plan({ chatModel: model, defaultModel, options })
        && Boolean(await a.engines?.claudecode?.status?.().then((st) => st?.installed && st.signedIn !== false).catch(() => false));
      const r = await lib.run({
        text, kind, skill: deps.skill(), chatModel: model, defaultModel, options, local, signal: ctrl.signal,
        mode: deps.subagentModel?.() === 'same' ? 'same' : 'auto',
        api: apiCall, cli: cliCall,
        onUsage: (message, used) => { if (message?.usage) a.reportApi(deps.providers.splitModel(used).provider, { model: used, usage: message.usage }); },
      });
      const name = r.kind === 'cli' ? `${{ claudecode: 'Claude Code', grokbuild: 'Grok Build', antigravity: 'Antigravity' }[r.engine] || 'CLI'}${r.model && r.model !== 'default' ? ` (${r.model})` : ''}` : (r.model ? deps.modelName(r.model) : '');
      return { ...r, name };
    } finally {
      if (runs.get(key) === ctrl) runs.delete(key);
    }
  }
  const cancel = (key) => { runs.get(key)?.abort(); };

  const errorText = (r) => {
    if (r.error === 'no-skill') return t('humanize.noSkill');
    if (r.error === 'skills-off') return t('humanize.skillsOff');
    if (r.error === 'no-provider') return t('humanize.noProvider');
    if (r.error === 'too-long') return t('humanize.tooLong', { max: lib.MAX_CHARS.toLocaleString('en-US') });
    if (r.error === 'timeout') return t('humanize.timeout');
    if (r.error === 'no-answer') return t('humanize.noAnswer');
    return t('humanize.failed', { error: String(r.error || '').slice(0, 200) });
  };
  const clip = (s) => (s.length > SHOWN_CHARS ? `${s.slice(0, SHOWN_CHARS)}…` : s);

  // The page's right-click "Humanize". p: Electron's context-menu params.
  async function fromMenu(wc, p) {
    const win = deps.win(wc);
    if (!win || wc.isDestroyed()) return { ok: false };
    const restoreFocus = () => deps.restoreFocus(wc);
    const toast = (title) => deps.overlay.show(win, { mode: 'toast', restoreFocus, payload: { title, buttons: [], seconds: 6 }, onAction: () => {} });
    if (deps.aiOff(wc.getURL())) { await toast(t('humanize.aiOff')); return { ok: false, error: 'ai-off' }; }
    const frame = p.frame && !p.frame.isDestroyed?.() && p.frame.parent ? p.frame : null; // (an iframe: its own document; the top frame gets our own world)
    const exec = (code) => (frame ? frame.executeJavaScript(code) : wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]));
    let mark = { editable: false };
    if (p.isEditable) { try { mark = (await exec(MARK)) || mark; } catch { /* the frame went away: treated as read-only */ } }
    const original = String(mark.editable ? mark.text : (p.selectionText || '')).replace(/\r\n/g, '\n');
    if (!original.trim()) { await toast(t('humanize.empty')); return { ok: false, error: 'empty' }; }
    const editable = Boolean(mark.editable);
    let result = null;
    let closed = false;
    const base = { title: t('humanize.title'), before: clip(original), beforeLabel: t('humanize.before'), afterLabel: t('humanize.after') };
    const session = await deps.overlay.show(win, {
      mode: 'humanize', restoreFocus,
      payload: { ...base, sub: t('humanize.working'), busy: true, buttons: [{ id: 'close', label: t('humanize.cancel') }] },
      onClose: () => { closed = true; cancel('page'); },
      onAction: async (action, data, sess) => {
        if (action === 'button' && data.id === 'skills') { deps.overlay.hide(win, sess); deps.openSkills?.(); return; } // the skill is missing: Settings → Skills
        if (action !== 'button' || !result?.ok) return;
        if (data.id === 'copy') {
          try { await deps.copy(result.text); deps.overlay.update(win, sess, { status: t('humanize.copied') }); } catch { deps.overlay.update(win, sess, { status: t('humanize.copyFailed') }); }
        } else if (data.id === 'replace' && editable) {
          deps.overlay.hide(win, sess); // (gives the page its focus back first)
          let done;
          try { done = await exec(replaceScript(result.text)); } catch { done = null; }
          if (!done?.ok) { await toast(t(done?.error === 'changed' ? 'humanize.changed' : 'humanize.replaceFailed')); return; }
          await deps.overlay.show(win, {
            mode: 'toast', restoreFocus,
            payload: { title: t('humanize.replaced'), buttons: [{ id: 'undo', label: t('humanize.undo') }], seconds: UNDO_SECONDS },
            onAction: async (act, d, toastSession) => {
              if (act !== 'button' || d.id !== 'undo') return;
              deps.overlay.hide(win, toastSession);
              let back;
              try { back = await exec(UNDO); } catch { back = null; }
              if (!back?.ok) await toast(t('humanize.undoFailed'));
            },
          });
        }
      },
    });
    result = await rewrite(original, { kind: 'selection', key: 'page' });
    if (closed || !session || deps.overlay.currentFor(win) !== session) return { ok: false, error: 'closed' };
    if (!result.ok) {
      const skillMissing = result.error === 'no-skill' || result.error === 'skills-off';
      deps.overlay.update(win, session, { payload: { ...base, sub: errorText(result), error: true, buttons: [...(skillMissing ? [{ id: 'skills', label: t('humanize.openSkills'), primary: true }] : []), { id: 'close', label: t('humanize.close') }] } });
      return result;
    }
    const notes = [t('humanize.skill'), result.name ? t('humanize.by', { model: result.name }) : '', result.unchanged ? t('humanize.unchanged') : ''].filter(Boolean).join(' · ');
    const buttons = editable
      ? [{ id: 'replace', label: t('humanize.replace'), primary: true }, { id: 'copy', label: t('humanize.copy') }, { id: 'close', label: t('humanize.cancel') }]
      : [{ id: 'copy', label: t('humanize.copy'), primary: true }, { id: 'close', label: t('humanize.close') }];
    deps.overlay.update(win, session, {
      payload: { ...base, after: clip(result.text), sub: notes, warn: result.missing?.length ? t('humanize.missing', { list: result.missing.slice(0, 6).join(', ') }) : '', buttons },
    });
    return result;
  }

  return { rewrite, cancel, fromMenu };
}

module.exports = { create, WORLD, MARK, UNDO, replaceScript, UNDO_SECONDS };
