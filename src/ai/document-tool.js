// The AI's `document` tool for Google Docs (a canvas editor: no DOM to click, no API key). It works the way a person does with
// the keyboard, and checks each step against the editor's own export:
//   - what is in the document comes from the export (html for headings and pictures/tables/equations, txt for the text);
//   - a section is selected with Find (to land on its heading) and Ctrl+Shift+Down, and the selection is COPIED and compared with
//     what the export says the section holds, so a wrong selection is caught before anything is cut;
//   - a move is cut and paste of that real range, which keeps pictures, tables, equations and fonts; text is never retyped;
//   - the document is compared with a snapshot taken before the first edit after every change (verify), and the AI's edits can be
//     undone (undo) back to that snapshot.
// Pure parts and the destructive-change rules are in doc-edit.js. This file drives a `host` (agent.js documentHost): the tab, keys,
// clipboard and approval card, so it can be tested against a fixture page that behaves like Docs.

const d = require('./doc-edit');

const wait = (host, ms) => host.sleep(ms);
const MAX_ROWS = 80;

// ---- reading the document through its export ----

async function readDoc(host) {
  const [txt, html] = [await host.fetchExport('txt'), await host.fetchExport('html')];
  if (txt == null || html == null) throw new Error('Could not read this document through its export (is it open, and do you have access?). Use read_page instead.');
  const text = String(txt).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const parsed = d.parseDocHtml(html);
  return { text, html, parsed, loc: locate(text, parsed.headings) };
}

// Where each heading sits in the text export: the next line (after the previous heading) that is exactly the heading's text.
// -> [{ offset, line, ordinal }]: ordinal = which match of the heading's text a Find would reach first-to-last.
function locate(text, headings) {
  const out = [];
  const lines = text.split('\n');
  let off = 0, li = 0;
  const starts = lines.map((l) => { const s = off; off += l.length + 1; return s; });
  for (const h of headings) {
    const want = d.clean(h.text).toLowerCase();
    const from = li;
    while (li < lines.length && d.clean(lines[li]).toLowerCase() !== want) li++;
    if (li >= lines.length) { out.push(null); li = from; continue; }
    out.push({ offset: starts[li], line: li, ordinal: occurrences(text, h.text, starts[li]) + 1 });
    li++;
  }
  return out;
}
// How many times `needle` occurs (case-insensitive, like Docs' Find) before `upto`.
function occurrences(text, needle, upto) {
  const hay = text.slice(0, upto).toLowerCase(), n = d.clean(needle).toLowerCase();
  let c = 0, i = 0;
  while (n && (i = hay.indexOf(n, i)) >= 0) { c++; i += n.length; }
  return c;
}

// Pictures (and equations), tables the export holds in a section: [heading from .. the next heading after to).
function sectionObjects(doc, from, to) {
  const hs = doc.parsed.headings;
  const a = hs[from].offset, b = hs[to + 1] ? hs[to + 1].offset : doc.parsed.src.length;
  const part = doc.parsed.src.slice(a, b);
  return { pictures: (part.match(/<img\b/gi) || []).length + (part.match(/<math\b|<m:oMath\b/gi) || []).length, tables: (part.match(/<table\b/gi) || []).length };
}
// How many paragraphs a section has in the text export: one line each, empty ones (a picture's paragraph) included.
function sectionParagraphs(doc, from, to) {
  const a = doc.loc[from];
  const next = doc.loc.slice(to + 1).find(Boolean);
  const total = doc.text.split('\n').length - (doc.text.endsWith('\n') ? 1 : 0);
  return (next ? next.line : total) - a.line;
}

function sectionText(doc, from, to) { // inclusive heading indexes of one section
  const a = doc.loc[from];
  const next = doc.loc.slice(to + 1).find(Boolean);
  return a ? doc.text.slice(a.offset, next ? next.offset : doc.text.length) : '';
}

// ---- keys ----

// Put the caret on a heading: Find (Ctrl+F), type its text, step to the right match, Esc (the match stays selected), Home.
async function gotoHeading(host, doc, index) {
  const h = doc.parsed.headings[index], at = doc.loc[index];
  if (!at) throw new Error(`Could not find "${h.text}" in the document text, so cannot place the cursor there.`);
  await host.key('f', ['control']);
  await wait(host, 150);
  await host.insert(h.text);
  await wait(host, 120);
  for (let i = 1; i < at.ordinal; i++) { await host.key('Enter'); await wait(host, 60); }
  await host.key('Escape');
  await wait(host, 100);
  await host.key('Home');
}

const sameWords = (a, b) => d.words(a).join(' ') === d.words(b).join(' ');

// Select a section exactly: from the heading to the end of its last paragraph, checked against the export by copying the selection.
async function selectSection(host, doc, index, { includeBreak = false } = {}) {
  const span = d.sectionSpan(doc.parsed.headings, index);
  const expected = sectionText(doc, span.from, span.to);
  const objs = sectionObjects(doc, span.from, span.to);
  const paragraphs = sectionParagraphs(doc, span.from, span.to);
  await gotoHeading(host, doc, index);
  for (let i = 0; i < paragraphs; i++) await host.key('ArrowDown', ['control', 'shift']);
  await wait(host, 100);
  // Exactly the section: its words, and its pictures and tables (the words alone cannot see a picture left behind).
  const exact = (got) => sameWords(got.text, expected) && got.images + got.equations === objs.pictures && got.tables === objs.tables;
  let got = await host.selectionInfo();
  for (let tries = 0; tries < 6 && !exact(got); tries++) {
    const fewer = d.words(got.text).length < d.words(expected).length || got.images + got.equations < objs.pictures || got.tables < objs.tables;
    await host.key(fewer ? 'ArrowDown' : 'ArrowUp', ['control', 'shift']);
    await wait(host, 100);
    got = await host.selectionInfo();
  }
  if (!exact(got)) {
    await host.key('Escape');
    throw new Error(`Could not select exactly the section "${doc.parsed.headings[index].text}" (the selection held ${d.words(got.text).length} words, ${got.images + got.equations} pictures and ${got.tables} tables; the document says ${d.words(expected).length}, ${objs.pictures} and ${objs.tables}). Nothing was changed.`);
  }
  if (includeBreak && doc.loc.slice(span.to + 1).some(Boolean)) await host.key('ArrowRight', ['shift']); // the paragraph break: the next heading stays on its own line
  return { span, expected };
}

// ---- state (per run and document) ----

function begin(host, doc) {
  const st = host.state;
  const id = host.docId();
  if (!st.doc || st.doc.id !== id) {
    st.doc = { id, snap: d.takeSnapshot({ html: doc.html, text: doc.text, rev: new Date().toISOString(), at: Date.now() }), undoSteps: 0, expect: { removedWords: 0, addedWords: 0 }, edits: [] };
  }
  return st.doc;
}

// Re-read until the export agrees with `ok` (Docs saves a moment after an edit), at most ~8 s.
async function settle(host, ok) {
  let doc = null;
  for (let i = 0; i < 8; i++) {
    doc = await readDoc(host);
    if (ok(doc)) return { doc, settled: true };
    await wait(host, 1000);
  }
  return { doc, settled: false };
}

function check(host, run, doc) {
  const snap = d.takeSnapshot({ html: doc.html, text: doc.text });
  const res = d.compareSnapshots(run.snap, snap, run.expect);
  return { res, snap };
}

// The line every edit ends with, and what `verify` returns. Never "unchanged" unless the comparison said so.
async function verifyNow(host, run, { expectOrder } = {}) {
  const { doc } = await settle(host, (dc) => {
    if (expectOrder && dc.parsed.headings.map((h) => h.text).join('|') !== expectOrder.join('|')) return false;
    return check(host, run, dc).res.ok;
  });
  const { res } = check(host, run, doc);
  const orderOk = !expectOrder || doc.parsed.headings.map((h) => h.text).join('|') === expectOrder.join('|');
  return { doc, res, orderOk, text: d.verifyMessage(res, run.snap) };
}

// ---- actions ----

async function outline(host) {
  const doc = await readDoc(host);
  const run = begin(host, doc);
  const hs = doc.parsed.headings;
  const rows = hs.slice(0, MAX_ROWS).map((h, i) => {
    const sp = d.sectionSpan(hs, i);
    const w = d.words(sectionText(doc, i, i === sp.to ? i : i)).length;
    const at = doc.loc[i];
    return `${i + 1}. ${'  '.repeat(h.level - 1)}H${h.level} ${h.text}${at ? ` (paragraph ${at.line + 1}, ${w} words)` : ''}`;
  });
  const s = run.snap;
  return `${rows.join('\n') || 'No headings (apply heading styles first).'}${hs.length > MAX_ROWS ? `\n… ${hs.length - MAX_ROWS} more` : ''}\nWhole document: ${s.wordCount} words, ${s.images} images, ${s.tables} tables, ${s.equations} equations. A snapshot was taken; verify and undo compare against it.`;
}

async function selectSectionAction(host, input) {
  const doc = await readDoc(host);
  begin(host, doc);
  const f = d.findHeading(doc.parsed.headings, input.heading);
  if (f.error) throw new Error(f.error);
  const { span, expected } = await selectSection(host, doc, f.index);
  return `Selected the section "${f.heading.text}" (${span.to - span.from + 1} heading${span.to > span.from ? 's' : ''}, ${d.words(expected).length} words), checked against the document's text. Copy it, or press a style/move.`;
}

// After a cut the caret is where the section was. If a paragraph there is empty (the cut left its paragraph mark behind), remove it:
// Delete, or Backspace when it is the last paragraph. Checked by selecting the line and copying it. -> undo steps used (0 or 1).
async function tidyAfterCut(host, last) {
  await host.key('Home');
  await host.key('End', ['shift']);
  const line = await host.selectionText();
  await host.key('Home');
  if (d.clean(line)) return 0;
  await host.key(last ? 'Backspace' : 'Delete');
  return 1;
}
const successorless = (span, hs) => span.to >= hs.length - 1; // the section runs to the end of the document

async function moveSection(host, input) {
  const doc = await readDoc(host);
  const run = begin(host, doc);
  const hs = doc.parsed.headings;
  const plan = d.planMove(hs, input.heading, input.where, input.to);
  if (plan.error) throw new Error(plan.error);
  if (plan.order.every((v, i) => v === i)) return 'The section is already there. Nothing changed.';
  const f = d.findHeading(hs, input.heading);
  const { span } = await selectSection(host, doc, f.index, { includeBreak: true });
  // The destination, worked out from the text before the cut (the export lags behind an edit): the heading the section goes ahead of.
  const pos = plan.order.indexOf(span.from);
  const successor = plan.order.slice(pos + (span.to - span.from + 1)).find((i) => i !== undefined);
  const cutFrom = doc.loc[span.from].offset;
  const afterNext = doc.loc.slice(span.to + 1).find(Boolean);
  const cutTo = afterNext ? afterNext.offset : doc.text.length;
  const gone = doc.text.slice(0, cutFrom) + doc.text.slice(cutTo);
  const goneHeads = hs.map((h, i) => ({ h, i })).filter(({ i }) => i < span.from || i > span.to);
  const goneLoc = locate(gone, goneHeads.map(({ h }) => h));
  const where = (i) => goneLoc[goneHeads.findIndex((g) => g.i === i)];
  const atEnd = successor === undefined;
  if (!atEnd && !where(successor)) throw new Error('Could not work out where to paste. Nothing was changed.');
  const goneDoc = { text: gone, parsed: { headings: goneHeads.map(({ h }) => h) }, loc: goneLoc };
  let tidied = 0;
  await host.cutPaste(async () => {
    tidied = await tidyAfterCut(host, successorless(span, hs));
    if (atEnd) { await host.key('End', ['control']); await host.key('Enter'); }
    else await gotoHeading(host, goneDoc, goneHeads.findIndex((g) => g.i === successor));
  });
  run.undoSteps += 2 + tidied;
  run.expect.headings = plan.order.map((i) => ({ level: hs[i].level, text: hs[i].text }));
  run.edits.push(`moved "${hs[f.index].text}"`);
  const names = plan.order.map((i) => hs[i].text);
  const v = await verifyNow(host, run, { expectOrder: names });
  if (!v.orderOk || !v.res.ok) {
    await host.undo(2 + tidied);
    run.undoSteps -= 2 + tidied;
    run.edits.pop();
    const again = await verifyNow(host, run);
    return `The move did not come out right (${v.orderOk ? '' : 'the headings are not in the order planned; '}${v.res.problems.join('; ') || 'checked'}), so I undid it. ${again.res.ok ? 'The document matches the version from before my edits again.' : `Check the document: ${again.text}`}`;
  }
  return `Moved "${hs[f.index].text}" ${input.where} "${hs[d.findHeading(hs, input.to).index].text}" by cutting and pasting the real section (pictures, tables, equations and fonts come with it). New order: ${names.join(' > ')}. ${v.text}`;
}

async function styleAction(host, input) {
  const st = d.parseStyle(input.style);
  if (st.error) throw new Error(st.error);
  const key = d.styleShortcut(host.editor, st.level);
  if (!key) throw new Error(`${host.editor === 'gdocs' ? 'That style' : 'Styles'} are not available here through the keyboard. Use the editor's styles menu.`);
  const doc = await readDoc(host);
  const run = begin(host, doc);
  let what = 'the paragraph at the cursor';
  let styledIndex = -1;
  if (input.heading) {
    const f = d.findHeading(doc.parsed.headings, input.heading);
    if (f.error) throw new Error(f.error);
    await gotoHeading(host, doc, f.index);
    styledIndex = f.index;
    what = `"${f.heading.text}"`;
  }
  const [mod, ...rest] = key.split('+');
  await host.key(rest.pop(), [mod.toLowerCase(), ...rest.map((m) => m.toLowerCase())]);
  await wait(host, 150);
  run.undoSteps += 1;
  run.expect.headings = input.heading ? doc.parsed.headings.map((h, i) => (i === styledIndex ? { level: st.level, text: h.text } : { level: h.level, text: h.text })).filter((h) => h.level > 0) : 'any';
  run.edits.push(`styled ${what}`);
  const v = await verifyNow(host, run);
  return `Applied ${st.level ? `Heading ${st.level}` : 'Normal text'} to ${what}. ${v.text}`;
}

async function replaceAction(host, input) {
  if (typeof input.find !== 'string' || !input.find) throw new Error('find is required.');
  const doc = await readDoc(host);
  const run = begin(host, doc);
  const repl = String(input.replace ?? '');
  const hits = occurrences(doc.text, input.find, doc.text.length);
  if (!hits) return `"${input.find}" does not occur in the document. Nothing changed.`;
  const times = input.all ? hits : 1;
  const removed = Math.max(0, d.words(input.find).length - d.words(repl).length) * times;
  const gate = d.checkAction({ kind: 'replace', selection: 'range', removedWords: removed }, run.snap);
  if (gate.confirm && !(await host.confirm(gate.message))) throw new Error('The user did not allow that change. Ask them what to do instead.');
  const ok = await host.replaceDialog(input.find, repl, Boolean(input.all));
  if (!ok) throw new Error('Could not use the editor\'s Find and replace dialog (Ctrl+H). Nothing was changed.');
  run.undoSteps += 1;
  run.expect.removedWords += d.words(input.find).length * times;
  run.expect.addedWords += d.words(repl).length * times;
  if (doc.parsed.headings.some((h) => h.text.toLowerCase().includes(input.find.toLowerCase()))) run.expect.headings = 'any';
  run.edits.push(`replaced "${input.find}"`);
  const v = await verifyNow(host, run);
  return `Replaced ${input.all ? `all ${hits}` : 'the first'} match${input.all && hits !== 1 ? 'es' : ''} of "${input.find}" with the editor's own Find and replace (formatting around it untouched). ${v.text}`;
}

async function insertMarkdown(host, input) {
  const md = String(input.text ?? '');
  if (!md.trim()) throw new Error('text is required.');
  const doc = await readDoc(host);
  const run = begin(host, doc);
  const hs = doc.parsed.headings;
  if (input.heading) {
    const f = d.findHeading(hs, input.heading);
    if (f.error) throw new Error(f.error);
    if (input.where !== 'before' && input.where !== 'after') throw new Error('where must be "before" or "after" when a heading is given.');
    if (input.where === 'before') await gotoHeading(host, doc, f.index);
    else {
      const span = d.sectionSpan(hs, f.index);
      const nextIdx = span.to + 1;
      if (nextIdx < hs.length) await gotoHeading(host, doc, nextIdx);
      else { await host.key('End', ['control']); await host.key('Enter'); }
    }
  } else if (input.where === 'start') await host.key('Home', ['control']);
  else if (input.where === 'end') { await host.key('End', ['control']); await host.key('Enter'); }
  else {
    // At the cursor: whatever is selected would be replaced. Select-all then paste is the retyping failure: refused.
    const sel = d.words(await host.selectionText()).length;
    const gate = d.checkAction({ kind: 'paste', selection: sel >= run.snap.wordCount * 0.9 && sel > 0 ? 'all' : 'range', removedWords: sel }, run.snap);
    if (gate.refuse) throw new Error(gate.reason);
    if (gate.confirm && !(await host.confirm(gate.message))) throw new Error('The user did not allow that change. Ask them what to do instead.');
  }
  const html = d.markdownToHtml(md);
  await host.pasteRich(html, md);
  run.undoSteps += 1;
  run.expect.addedWords += d.words(md).length;
  run.expect.headings = 'any';
  run.edits.push('inserted text');
  const v = await verifyNow(host, run);
  return `Inserted the text as formatted content (headings, lists, bold and links become real formatting). ${v.text}`;
}

async function verifyAction(host) {
  const doc = await readDoc(host);
  const run = host.state.doc && host.state.doc.id === host.docId() ? host.state.doc : null;
  if (!run) { begin(host, doc); return 'No snapshot existed yet, so one was taken now; there is nothing earlier to compare. Edits made before this call are not covered.'; }
  const v = await verifyNow(host, run);
  return `${v.text}${run.edits.length ? ` (my edits so far: ${run.edits.join('; ')})` : ''}`;
}

// Take my edits back: press undo one step at a time and stop the moment the document matches the snapshot (words, pictures, tables,
// equations, headings). Never past that (an editor can group steps differently from how many I made), and never more than a few
// beyond the steps I counted: if it still differs then, those extra steps are redone (they could be the user's own) and it says so.
async function undoAction(host) {
  const run = host.state.doc && host.state.doc.id === host.docId() ? host.state.doc : null;
  if (!run || !run.undoSteps) return 'I have made no edits to this document in this run, so there is nothing to undo.';
  const n = run.undoSteps;
  const done = run.edits.splice(0);
  run.undoSteps = 0;
  run.expect = { removedWords: 0, addedWords: 0 };
  const same = async () => { await wait(host, 800); return check(host, run, await readDoc(host)).res.ok; };
  let pressed = 0, ok = await same();
  while (!ok && pressed < n + 3) { await host.undo(1); pressed++; ok = await same(); }
  if (!ok && pressed > n) { await host.redo(pressed - n); pressed = n; }
  const v = await verifyNow(host, run);
  const steps = `${pressed} edit step${pressed === 1 ? '' : 's'}`;
  return `Undid my ${steps} (${done.join('; ')}). ${v.res.ok ? 'The document matches the version from before my edits.' : `${v.text} File > Version history > See version history can restore ${run.snap.rev}.`}`;
}

const ACTIONS = {
  outline: [outline, false], select_section: [selectSectionAction, true], move_section: [moveSection, true], replace: [replaceAction, true],
  style: [styleAction, true], insert_markdown: [insertMarkdown, true], verify: [verifyAction, false], undo: [undoAction, true],
};

async function run(host, input) {
  const action = String(input?.action || '');
  if (action === 'read') return host.read();
  const entry = ACTIONS[action];
  if (!entry) throw new Error(`Unknown action "${action}". Use ${['outline', ...Object.keys(ACTIONS).filter((k) => k !== 'outline'), 'read'].join(', ')}.`);
  if (host.editor !== 'gdocs') {
    throw new Error(`The document tool works in Google Docs. ${host.editor === 'word' || host.editor === 'notion' ? 'In this editor, ' : 'Here, '}use read_page for the text, and press_key with Ctrl+X / Ctrl+V to move a selected range (never retype the content).`);
  }
  return entry[0](host, input);
}

// ---- raw edits on a Docs tab (the AI's own press_key / type_text, outside the tool): Ctrl+A then typing is the whole-document retype.
// Called before a key. Returns the card message when the call would replace or delete a lot (more than ~20% of the words, the whole
// document, or any picture, table or equation), else null. state.selAll remembers "everything is selected" for when the selection
// cannot be read. host.selectionInfo() -> { words, images, tables, equations } of the selection, by copying it.
const WHOLE = "This replaces the whole document's text. Retyping loses pictures, tables, equations and fonts. Continue?";
const isCommand = (input) => (input.modifiers || []).includes('control') || (input.modifiers || []).includes('meta');
const DESTROYS = (name, input) => name === 'type_text'
  || (name === 'press_key' && (/^(Delete|Backspace|Enter)$/.test(input.key) || ([...String(input.key)].length === 1 && (!(input.modifiers || []).length || (input.modifiers || []).every((m) => m === 'shift'))) || (/^[vx]$/i.test(input.key) && isCommand(input))));
async function rawEditGuard(host, state, name, input) {
  if (name === 'press_key' && /^a$/i.test(input.key) && isCommand(input)) { state.selAll = true; return null; }
  if (!DESTROYS(name, input)) { if (name === 'click' || name === 'click_at' || name === 'press_key') state.selAll = false; return null; }
  const wasAll = state.selAll;
  state.selAll = false;
  const info = await Promise.resolve(host.selectionInfo()).catch(() => null);
  if (!info) return wasAll ? WHOLE : null;
  if (!info.words && !info.images && !info.tables && !info.equations) return null; // nothing selected: an ordinary key
  let run = host.state.doc && host.state.doc.id === host.docId() ? host.state.doc : null;
  if (!run) { try { run = begin(host, await readDoc(host)); } catch { return wasAll ? WHOLE : null; } } // the first look at this document: the snapshot
  const everything = wasAll || (run.snap.wordCount > 0 && info.words >= run.snap.wordCount * 0.9);
  const kind = name === 'press_key' && /^x$/i.test(input.key) && isCommand(input) ? 'cut' : /^(Delete|Backspace)$/.test(input.key || '') ? 'delete' : 'type';
  const gate = d.checkAction({ kind, selection: everything ? 'all' : 'range', removedWords: info.words, images: info.images, tables: info.tables, equations: info.equations }, run.snap);
  if (gate.refuse) return WHOLE;
  return gate.confirm ? gate.message : null;
}

module.exports = { run, readDoc, locate, occurrences, sectionText, sectionObjects, sectionParagraphs, rawEditGuard, DESTROYS };
