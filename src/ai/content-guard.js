'use strict';
// Content guard: the safety layer under every tool that can edit what the user wrote (type_text, Delete / Backspace / cut,
// run_script, a click on a Delete / Remove / Clear button), for every engine and for outside agents: they all reach the page through
// agent.js execute(), which calls guardTool() here. docs/ai-content-guard.md.
//
// What it does, around one acting tool:
//   1. Snapshots the editable region the tool targets (the focused field or editor, else the page's main editor): its text, and how
//      many images, tables, equations, list items, table rows and styled runs it holds.
//   2. Where the effect can be told in advance (type_text replaces the whole field, a Delete over a selected block, a script that
//      assigns innerHTML), asks BEFORE acting.
//   3. After the tool, measures what disappeared. Over the thresholds (a single action, or the run's actions added up) it puts
//      the content back (native undo, else the snapshot), and asks: "Keep the change" / "Undo it". Text the AI typed itself in this
//      run, and text that moved elsewhere in the same region, doesn't count as lost.
//   4. Keeps a per-run journal of the regions it edited with their first snapshot: "Undo the AI's edits" and verify_changes use it.
// Bypass permissions skips the card (askApproval answers allow and shows a step) and still logs; nothing is undone behind the
// user's back then, and the journal keeps the undo available.
//
// Pure parts (classify, diffRegion, exceeds, describeLoss, journal, verifyReport) are unit tested (test/units/content-guard-units.js); the
// page side is the script strings below, run in Claude's isolated world (nothing in them is visible to the page).
const { HELPERS } = require('./page-scripts');

const THRESHOLD = {
  chars: 300, // this much text gone is always a card...
  share: 0.2, // ...and so is a fifth of a field, once at least...
  shareMin: 150, // ...this much (an address field rewritten is not a loss worth a card)
  items: 5, rows: 5, // list items / table rows
  styled: 8, styledShare: 0.5, // formatting runs (bold, links, headings, colours...), and the share of them
};
const TEXT_CAP = 400000; // snapshot text is compared up to here; the counts are always exact
const SAVE_CAP = 4000000; // a region bigger than this (in HTML) is measured but not saved for restoring

const num = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- what the tool is about to do

const DANGER = /\b(delete|remove|clear|discard|erase|wipe|trash|empty (?:the )?(?:trash|bin|recycle bin))\b/i;
// A script that rewrites a region's content (assigning markup or text, replacing or emptying nodes, document.write, an edit command).
const WIPING = /\.(?:innerHTML|outerHTML|textContent|innerText)\s*=(?!=)|\.value\s*=(?!=)|\.replaceChildren\s*\(|\.replaceWith\s*\(|\.insertAdjacentHTML\s*\(|document\.(?:write|writeln)\s*\(|execCommand\s*\(\s*['"`](?:selectAll|delete|forwardDelete|cut|insertHTML|insertText|removeFormat)['"`]|\.(?:empty|html|text)\s*\(\s*(?:['"`][^)]*)?\)|\.(?:remove|innerText)\s*\(\s*\)/;

const scriptWipes = (code) => WIPING.test(String(code || ''));
const dangerousLabel = (label) => DANGER.test(String(label || ''));

// 'type' | 'key' | 'script' | 'click' | 'selectall' | null: which kind of risk a call carries. `label` is the control's name for a click.
function classify(name, input = {}, label = '') {
  if (name === 'type_text') return 'type';
  if (name === 'run_script') return 'script';
  if (name === 'click') return dangerousLabel(label) || dangerousLabel(input.text) ? 'click' : null;
  if (name === 'press_key') {
    const key = String(input.key || '');
    const mods = (input.modifiers || []).map((m) => String(m).toLowerCase());
    const command = mods.includes('control') || mods.includes('ctrl') || mods.includes('meta') || mods.includes('cmd');
    if (/^(delete|backspace)$/i.test(key)) return 'key';
    if (command && /^x$/i.test(key)) return 'key'; // cut
    if (command && /^a$/i.test(key)) return 'selectall';
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- measuring a loss (pure)

// The part of `before` that changed: what was taken out and what went in (everything outside the common start and end).
function changedSpan(before, after) {
  const a = String(before || ''), b = String(after || '');
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { removed: a.slice(p, a.length - s), inserted: b.slice(p, b.length - s) };
}

// Characters that left the region and were neither typed by the AI in this run (`owned`) nor moved elsewhere in it.
function foreignLoss(before, after, owned = []) {
  let { removed, inserted } = changedSpan(before, after);
  if (!removed.trim()) return 0;
  if (inserted.includes(removed)) return 0; // moved or re-wrapped
  const mine = owned.map(String).filter((o) => o.length > 1);
  if (mine.some((o) => o.includes(removed))) return 0; // cut out of text the AI typed itself
  for (const o of mine.sort((x, y) => y.length - x.length)) {
    if (o.length >= 12 && removed.includes(o)) removed = removed.split(o).join('');
  }
  let lost = 0;
  for (const line of removed.split(/\n+/)) {
    const t = line.trim();
    if (t && !inserted.includes(t)) lost += t.length;
  }
  return lost;
}

const COUNTS = ['images', 'tables', 'equations', 'items', 'rows', 'styled'];

// What a change took away from a region. `before` / `after`: { chars, text, images, tables, equations, items, rows, styled }.
function diffRegion(before, after, owned = []) {
  const b = before || {}, a = after || {};
  const delta = {
    lostChars: foreignLoss(b.text, a.text, owned),
    netChars: (a.chars || 0) - (b.chars || 0),
    addedChars: Math.max(0, changedSpan(b.text, a.text).inserted.length),
  };
  for (const k of COUNTS) delta[`lost${k[0].toUpperCase()}${k.slice(1)}`] = Math.max(0, (b[k] || 0) - (a[k] || 0));
  return delta;
}

// { over, reasons } for a delta against the region it came from (`before` supplies the size for the share rule).
function exceeds(delta, before = {}) {
  const reasons = [];
  const size = before.chars || 0;
  if (delta.lostChars >= THRESHOLD.chars || (delta.lostChars >= THRESHOLD.shareMin && size > 0 && delta.lostChars >= size * THRESHOLD.share)) reasons.push('text');
  if (delta.lostImages > 0) reasons.push('images');
  if (delta.lostTables > 0) reasons.push('tables');
  if (delta.lostEquations > 0) reasons.push('equations');
  if (delta.lostItems >= THRESHOLD.items) reasons.push('items');
  if (delta.lostRows >= THRESHOLD.rows) reasons.push('rows');
  if (delta.lostStyled >= THRESHOLD.styled && delta.lostStyled >= (before.styled || 0) * THRESHOLD.styledShare) reasons.push('formatting');
  return { over: reasons.length > 0, reasons };
}

// "about 1,200 characters (80% of it), 3 images and 1 table"
function describeLoss(delta, before = {}) {
  const parts = [];
  if (delta.lostChars > 0) {
    const share = before.chars ? Math.min(100, Math.round((delta.lostChars / before.chars) * 100)) : 0;
    parts.push(`${delta.lostChars >= 100 ? 'about ' : ''}${plural(delta.lostChars, 'character')}${share >= 5 ? ` (${share}% of the text)` : ''}`);
  }
  if (delta.lostImages) parts.push(plural(delta.lostImages, 'image'));
  if (delta.lostTables) parts.push(plural(delta.lostTables, 'table'));
  if (delta.lostEquations) parts.push(plural(delta.lostEquations, 'equation'));
  if (delta.lostItems) parts.push(plural(delta.lostItems, 'list item'));
  if (delta.lostRows) parts.push(plural(delta.lostRows, 'table row'));
  if (delta.lostStyled >= THRESHOLD.styled) parts.push('most of its formatting');
  if (!parts.length) return 'some content';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// Same content for the restore check: text and every count.
function sameContent(a, b) {
  if (!a || !b) return false;
  if (a.chars !== b.chars || a.text !== b.text) return false;
  return COUNTS.every((k) => (a[k] || 0) === (b[k] || 0));
}

// What a call would take out, told in advance, as a delta (null: can't tell, or nothing to worry about). Selection numbers come
// from the snapshot (selChars, selImages, selTables).
function predictLoss(kind, input, before, owned = []) {
  if (!before) return null;
  if (kind === 'type') { // type_text selects the whole field first, then inserts plain text
    return diffRegion(before, { chars: String(input.text ?? '').length, text: String(input.text ?? ''), images: 0, tables: 0, equations: 0, items: 0, rows: 0, styled: 0 }, owned);
  }
  if (kind === 'key') {
    if (!before.selChars && !before.selImages && !before.selTables) return null; // a plain Backspace: one character
    const wholeField = before.chars > 0 && before.selChars >= before.chars * 0.9;
    return {
      lostChars: wholeField ? foreignLoss(before.text, '', owned) : before.selChars, netChars: -before.selChars, addedChars: 0,
      lostImages: before.selImages || 0, lostTables: before.selTables || 0, lostEquations: 0, lostItems: 0, lostRows: 0, lostStyled: 0,
    };
  }
  if (kind === 'script' && scriptWipes(input.code)) { // assumed to rewrite the region: the whole of what's in it
    return {
      lostChars: foreignLoss(before.text, '', owned), netChars: -before.chars, addedChars: 0,
      lostImages: before.images, lostTables: before.tables, lostEquations: before.equations, lostItems: before.items, lostRows: before.rows, lostStyled: before.styled,
    };
  }
  return null;
}

// ---------------------------------------------------------------- the journal (per run)

function createJournal(id = 'run') {
  return { id: String(id), regions: new Map(), unmeasured: [], undone: false };
}

// The record of one region (an editor or field on one tab) this run has touched.
function regionRecord(journal, tabId, snap, site) {
  const key = `${tabId}:${snap.region}`;
  let rec = journal.regions.get(key);
  if (!rec) {
    rec = { key, tabId, region: snap.region, site: site || '', rich: snap.kind === 'rich', first: snap, firstSave: snap.firstSave ?? snap.save ?? null, baseline: snap, last: snap, owned: [], changes: 0, native: 0, scripted: 0, flagged: 0 };
    journal.regions.set(key, rec);
  }
  return rec;
}

const changedRegions = (journal) => [...(journal?.regions.values() || [])].filter((r) => r.changes > 0 && !sameContent(r.first, r.last));

// ---------------------------------------------------------------- reporting for verify_changes (pure)

function statLine(label, first, now) {
  const bits = [`text ${num(first.chars)} → ${num(now.chars)} characters`];
  for (const [k, name] of [['images', 'images'], ['tables', 'tables'], ['equations', 'equations'], ['items', 'list items'], ['rows', 'table rows']]) {
    if (first[k] || now[k]) bits.push(`${name} ${num(first[k])} → ${num(now[k])}`);
  }
  const same = sameContent(first, now);
  const d = diffRegion(first, now);
  const detail = same ? 'unchanged from when the run started' : `changed: ${d.addedChars ? `${plural(d.addedChars, 'character')} added` : 'no text added'}${d.lostChars ? `, ${plural(d.lostChars, 'character')} removed` : ''}${COUNTS.some((k) => d[`lost${k[0].toUpperCase()}${k.slice(1)}`]) ? `; lost ${describeLoss({ ...d, lostChars: 0 }, first)}` : ''}`;
  return `- ${label}: ${bits.join(', ')}. ${detail}.`;
}

// `current`: region key -> a fresh snapshot, or null when the region can't be measured any more. `names`: tab id -> site.
function verifyReport(journal, current, names = new Map()) {
  const lines = [];
  for (const rec of journal?.regions.values() || []) {
    const label = `${names.get(rec.tabId) || rec.site || 'a page'} (${rec.rich ? 'editor' : 'text field'})`;
    const now = current.get(rec.key);
    if (!now) lines.push(`- ${label}: can't be measured any more (the page changed or was closed). Don't claim it is unchanged.`);
    else lines.push(statLine(label, rec.first, now));
  }
  for (const u of journal?.unmeasured || []) lines.push(`- ${u.site || 'a page'}: ${u.count} ${u.count === 1 ? 'edit' : 'edits'} (${u.tools.join(', ')}) could not be measured: no readable editor there. Don't claim that content is unchanged.`);
  if (!lines.length) return 'This run has not typed into, deleted from or scripted any text field or editor, so there is nothing to compare. (Only those edits are tracked; clicks and navigation are not.)';
  return `What this run changed, measured now against the start of the run:\n${lines.join('\n')}\nSay only what this shows; don't claim anything else on those pages is unchanged.`;
}

// ---------------------------------------------------------------- the page side (Claude's isolated world)

// Shared by both scripts. The registry lives on the isolated world's window: region ids, elements (weakly), saved copies.
const PAGE_API = `
  const G = (window.__lumenGuard = window.__lumenGuard || { n: 0, ids: new WeakMap(), els: new Map(), saves: new Map(), pins: new Map(), sv: 0 });
  const isField = (el) => Boolean(el) && !secretField(el) && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|url|email|tel|)$/i.test(el.getAttribute('type') || 'text')));
  const editRoot = (el) => { let r = el; while (r.parentElement && r.parentElement.isContentEditable) r = r.parentElement; return r; };
  const asRegion = (a) => {
    if (!a || a.nodeType !== 1) return null;
    if (isField(a)) return a;
    if (a.isContentEditable) return editRoot(a);
    return null;
  };
  const deepActive = (doc) => {
    let a = doc.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    if (a && a.tagName === 'IFRAME') {
      try { const d = a.contentDocument; if (d) { const inner = deepActive(d); if (inner && (inner !== d.body || d.designMode === 'on')) return inner; } } catch {}
    }
    return a;
  };
  const sizeOf = (el) => (isField(el) ? el.value.length : (el.textContent || '').length);
  const candidates = () => {
    const out = [];
    const scan = (doc, depth) => {
      for (const el of doc.querySelectorAll('textarea, input, [contenteditable]')) {
        const r = asRegion(el);
        if (r && !out.includes(r) && r.getClientRects().length) out.push(r);
      }
      if (depth > 2) return;
      for (const f of doc.querySelectorAll('iframe')) {
        try {
          const d = f.contentDocument;
          if (!d) continue;
          if (d.designMode === 'on' && d.body) out.push(d.body); else scan(d, depth + 1);
        } catch {}
      }
    };
    scan(document, 0);
    return out;
  };
  const pick = () => {
    const a = deepActive(document);
    const focused = asRegion(a) || (a && a.ownerDocument.designMode === 'on' && a === a.ownerDocument.body ? a : null);
    if (focused) return focused;
    const all = candidates().sort((x, y) => sizeOf(y) - sizeOf(x));
    return all[0] || null;
  };
  const idOf = (el) => {
    let id = G.ids.get(el);
    if (!id) { id = ++G.n; G.ids.set(el, id); G.els.set(id, new WeakRef(el)); }
    return id;
  };
  const find = (id) => { const el = G.els.get(id)?.deref(); return el && el.isConnected ? el : null; };
  const CONTENT = 'img, canvas, svg, video';
  const measure = (el, run, keep) => {
    const field = isField(el);
    const text = field ? el.value : (el.innerText != null ? el.innerText : el.textContent || '');
    const q = (s) => (field ? 0 : el.querySelectorAll(s).length);
    const out = {
      region: idOf(el), kind: field ? 'field' : 'rich', tag: el.tagName.toLowerCase(),
      chars: text.length, text: text.length > ${TEXT_CAP} ? text.slice(0, ${TEXT_CAP}) : text, truncated: text.length > ${TEXT_CAP},
      images: q(CONTENT), tables: q('table'), equations: q('math, .katex, mjx-container, .MathJax, [data-equation]'), items: q('li'), rows: q('tr'),
      styled: q('b, strong, i, em, u, s, a[href], h1, h2, h3, h4, h5, h6, font, code, pre, blockquote, sup, sub, mark, [style]'),
      selChars: 0, selImages: 0, selTables: 0,
    };
    if (field) {
      out.selChars = Math.max(0, (el.selectionEnd || 0) - (el.selectionStart || 0));
    } else {
      const s = el.ownerDocument.getSelection();
      if (s && s.rangeCount && !s.isCollapsed) {
        const r = s.getRangeAt(0);
        if (el.contains(r.commonAncestorContainer)) {
          const frag = r.cloneContents();
          out.selChars = s.toString().length;
          out.selImages = frag.querySelectorAll(CONTENT).length;
          out.selTables = frag.querySelectorAll('table').length;
        }
      }
    }
    if (keep) {
      const html = field ? el.value : el.innerHTML;
      if (html.length <= ${SAVE_CAP}) {
        const sid = ++G.sv;
        G.saves.set(sid, { rid: out.region, field, html });
        out.save = sid;
        const pin = out.region + '|' + run;
        if (run && !G.pins.has(pin)) G.pins.set(pin, sid);
        out.firstSave = run ? G.pins.get(pin) : sid;
        const pinned = new Set(G.pins.values());
        for (const k of [...G.saves.keys()]) { if (G.saves.size <= 12) break; if (!pinned.has(k)) G.saves.delete(k); }
      }
    }
    return out;
  };
`;

// opts: { id } an element id (type_text's target), { region } a region measured before, or neither: the focused field / main editor.
// -> the measure above, { none: true } (nothing editable), or { missing: true } (that region is gone). keep: save a copy for restoring.
function snapshotScript({ id = null, region = null, run = '', keep = false } = {}) {
  return `(() => {
    ${HELPERS}
    ${PAGE_API}
    let el = null;
    if (${JSON.stringify(region)} !== null) {
      el = find(${JSON.stringify(region)});
      if (!el) return { missing: true };
    } else if (${JSON.stringify(id)} !== null) {
      const entry = entryFor(${Number(id) || 0});
      el = entry ? asRegion(entry.el) : null;
    } else {
      el = pick();
    }
    if (!el) return { none: true };
    return measure(el, ${JSON.stringify(String(run))}, ${keep ? 'true' : 'false'});
  })()`;
}

// The name of the control element `id` is: its text, aria-label and title, for the Delete / Remove check on a click.
function controlNameScript(id) {
  return `(() => {
    ${HELPERS}
    const entry = entryFor(${Number(id) || 0});
    if (!entry) return '';
    const el = entry.el;
    return [entry.label, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tooltip')].filter(Boolean).join(' ').slice(0, 200);
  })()`;
}

// Puts a saved copy back into its region: a field's value (through the native setter, with an input event), an editor's markup.
function restoreScript({ save, region }) {
  return `(() => {
    ${HELPERS}
    ${PAGE_API}
    const saved = G.saves.get(${Number(save) || 0});
    const el = find(${Number(region) || 0});
    if (!saved || !el) return false;
    if (saved.field) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, saved.html);
    } else {
      el.innerHTML = saved.html;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
}

// ---------------------------------------------------------------- guarding one tool call

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ctx (from agent.js): { journal, tabId, site, id (the element id of type_text), label (a click's control name),
//   snap(opts), restore({save, region}), undo(), redo(), ask(card) -> true (go ahead / keep) | false, bypass }.
// A card: { phase: 'before' | 'after', kind, title, detail, undone }. Throws an Error the model reads when the user says no.
async function guardTool(ctx, name, input, run) {
  const kind = classify(name, input, ctx.label);
  if (!kind || kind === 'selectall') return run();
  const journal = ctx.journal;
  const site = ctx.site || 'this page';
  let before = null;
  try { before = await ctx.snap({ id: kind === 'type' ? ctx.id : null, keep: true }); } catch { before = null; }
  if (!before || before.none || before.missing) {
    if (kind !== 'click') noteUnmeasured(journal, site, name);
    return run();
  }
  const rec = regionRecord(journal, ctx.tabId, before, site);
  rec.last = before;

  // 2. Told in advance: ask before acting.
  let approved = false;
  const predicted = predictLoss(kind, input, before, rec.owned);
  if (predicted && exceeds(predicted, before).over) {
    const what = describeLoss(predicted, before);
    const detail = {
      type: `Typing here replaces everything in this ${before.kind === 'rich' ? 'editor' : 'field'}, so ${what} would be removed (the AI is not moving or editing it in place).`,
      key: `This key press deletes the selected part of the ${before.kind === 'rich' ? 'editor' : 'field'}: ${what}.`,
      script: `This script rewrites the ${before.kind === 'rich' ? 'editor' : 'field'}'s content, which holds ${what}.`,
    }[kind];
    const ok = await ctx.ask({ phase: 'before', kind, site, title: `The AI is about to remove ${what} from ${site}`, detail });
    if (!ok) throw new Error(`The user did not allow this: it would remove ${what} from ${site}. Don't retry it or work around it with another tool. Edit in place (move content, don't retype it), or ask the user what they want.`);
    approved = true;
    rec.flagged++;
  }

  // 3. Run, then measure.
  let result;
  let failure = null;
  try { result = await run(); } catch (err) { failure = err; }
  let after = null;
  try {
    after = await ctx.snap({ region: before.region, keep: true });
    if (after?.missing) after = await ctx.snap({ keep: true }); // the editor was re-created: whatever is main now
  } catch { after = null; }
  if (!after || after.none || after.missing) {
    noteUnmeasured(journal, site, name);
    if (failure) throw failure;
    return result;
  }
  if (kind === 'type' && !failure) rec.owned.push(String(input.text ?? ''));
  const changed = !sameContent(before, after);
  if (changed) {
    rec.changes++;
    if (kind === 'type' || kind === 'key') rec.native++; else rec.scripted++;
  }
  rec.last = after;
  if (failure) throw failure;
  if (!changed) return result;

  // The run's edits added up (since the last time the user kept a loss), and this one on its own.
  const single = diffRegion(before, after, rec.owned);
  const combined = diffRegion(rec.baseline, after, rec.owned);
  const exSingle = exceeds(single, before);
  const exCombined = exceeds(combined, rec.baseline);
  if (approved) { rec.baseline = after; return result; } // the user said yes to this one before it ran
  if (!(exSingle.over || exCombined.over)) return result;
  const delta = exSingle.over ? single : combined;
  const base = exSingle.over ? before : rec.baseline;
  const what = describeLoss(delta, base);
  rec.flagged++;

  if (ctx.bypass) { // no card, no undo behind the user's back: a step and the note below
    await ctx.ask({ phase: 'after', kind, site, title: `Removed ${what} from ${site}`, detail: `Removed ${what} from ${site}. "Undo the AI's edits" under the reply is still available.`, undone: false });
    rec.baseline = after;
    return withNote(result, `Content check: this removed ${what} from the page's ${after.kind === 'rich' ? 'editor' : 'field'} (bypass is on, so it was not undone). Say so in your answer.`);
  }

  // Put it back first, then ask: the content is safe while the user decides.
  const how = await putBack(ctx, kind, before, after); // this last step; earlier ones were under the limit one by one
  const undone = how !== null;
  const keep = await ctx.ask({
    phase: 'after', kind, site, undone,
    title: `This removed ${what} from ${site}`,
    detail: undone ? 'It was put back for now. Keep the change or undo it?' : "It couldn't be put back automatically. Use the site's version history if you want it back.",
  });
  if (keep) {
    if (undone) await putBackAfter(ctx, how, after);
    rec.baseline = after;
    rec.last = after;
    return withNote(result, `Content check: the user chose to keep a change that removed ${what} from ${site}.`);
  }
  rec.last = undone ? before : after;
  if (undone) rec.changes = Math.max(0, rec.changes - 1);
  throw new Error(undone
    ? `The user undid that change because it removed ${what} from ${site}; the page is as it was. Don't retry it or find another way to do the same. Edit in place (move content, don't retype it), or ask the user how to proceed.`
    : `The user stopped here: that change removed ${what} from ${site} and could not be undone automatically. Tell them plainly what happened and that the site's version history can bring it back. Don't change that content again.`);
}

function noteUnmeasured(journal, site, tool) {
  let entry = journal.unmeasured.find((u) => u.site === site);
  if (!entry) { entry = { site, count: 0, tools: [] }; journal.unmeasured.push(entry); }
  entry.count++;
  if (!entry.tools.includes(tool)) entry.tools.push(tool);
}

const withNote = (result, note) => (typeof result === 'string' ? `${result}\n${note}` : result);

// Takes the action back: the page's own undo for typing and keys (the editor keeps its state), the snapshot for the rest or when
// the native undo did not bring it back. -> 'native' | 'restore' | null (couldn't).
async function putBack(ctx, kind, target, after) {
  const check = async () => { const now = await ctx.snap({ region: target.region }); return sameContent(now, target); };
  try {
    if ((kind === 'type' || kind === 'key') && ctx.undo) {
      await ctx.undo();
      await sleep(40);
      if (await check()) return 'native';
    }
    const save = target.save;
    if (save && await ctx.restore({ save, region: target.region }) && await check()) return 'restore';
    if (after?.save) await ctx.restore({ save: after.save, region: after.region }); // leave it as the tool did
  } catch { /* can't undo */ }
  return null;
}

async function putBackAfter(ctx, how, after) {
  try {
    if (how === 'native' && ctx.redo) {
      await ctx.redo();
      await sleep(40);
      if (sameContent(await ctx.snap({ region: after.region }), after)) return;
    }
    if (after.save) await ctx.restore({ save: after.save, region: after.region });
  } catch { /* the user keeps what's there */ }
}

// ---------------------------------------------------------------- "Undo the AI's edits on this page"

// Puts back each region the run edited, as it was at its first snapshot. `tabs`: tab id -> { snap, restore, undo, redo, site } for
// tabs still open. -> { done: [...], skipped: [...] } (lines for the sidebar).
async function undoEdits(journal, tabs) {
  const done = [];
  const skipped = [];
  const history = (site) => `If ${site} saves your work online, its version history (in its File or menu bar) can bring back what this couldn't.`;
  for (const rec of changedRegions(journal)) {
    const tab = tabs.get(rec.tabId);
    const site = tab?.site || rec.site || 'the page';
    if (!tab) { skipped.push(`Couldn't put back the edits on ${site}: its tab was closed. ${history(site)}`); continue; }
    let now = null;
    try { now = await tab.snap({ region: rec.region }); } catch { now = null; }
    if (!now || now.missing || now.none) { skipped.push(`Couldn't put back the edits on ${site}: the page changed since. ${history(site)}`); continue; }
    if (sameContent(now, rec.first)) { done.push(`${site} already matches how it started.`); rec.changes = 0; continue; }
    const matches = async () => sameContent(await tab.snap({ region: rec.region }), rec.first);
    let ok = false;
    try {
      if (rec.rich && rec.native > 0 && tab.undo) { // the editor's own undo, as often as it takes (checked after each step)
        let steps = 0;
        let last = now.text;
        for (let i = 0; i < 80 && !ok; i++) {
          await tab.undo();
          steps++;
          await sleep(25);
          ok = await matches();
          const cur = await tab.snap({ region: rec.region });
          if (!ok && cur && cur.text === last && i > 2) break; // the undo stack is used up
          last = cur?.text;
        }
        if (!ok && tab.redo) for (let i = 0; i < steps; i++) await tab.redo(); // overshot or never matched: back to where it was
      }
      if (!ok && rec.firstSave && await tab.restore({ save: rec.firstSave, region: rec.region })) ok = await matches();
      if (!ok && !rec.rich && tab.undo) { // a field set by the page's own undo history
        for (let i = 0; i < 20 && !ok; i++) { await tab.undo(); await sleep(25); ok = await matches(); }
      }
    } catch { ok = false; }
    if (ok) { done.push(`Put back what was in ${site}'s ${rec.rich ? 'editor' : 'text field'} (${plural(rec.first.chars, 'character')}).`); rec.changes = 0; rec.last = rec.first; }
    else skipped.push(`Couldn't fully put back ${site}'s ${rec.rich ? 'editor' : 'text field'}. ${history(site)}`);
  }
  return { done, skipped };
}

module.exports = {
  THRESHOLD, classify, scriptWipes, dangerousLabel, changedSpan, foreignLoss, diffRegion, exceeds, describeLoss, sameContent, predictLoss,
  createJournal, regionRecord, changedRegions, verifyReport, snapshotScript, restoreScript, controlNameScript, guardTool, undoEdits,
};
