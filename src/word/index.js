// [word] The AI working with Microsoft Word documents directly (Settings → AI → "Let the AI use Microsoft Word", on by default; the Word helper
// itself only starts the first time the tool is used). One tool, word(action, ...), whose actions are in spec.js. docs/word.md has the whole model:
//   - Windows with Word installed: Word's own object model through a hidden helper (com.js): the real document, with its real undo and styles;
//   - no Word (or another system): a .docx file is read with its structure, and new paragraphs, headings and tables are written straight into the
//     file (docx.js), as tracked changes, after the user says yes to that file;
//   - an edit asks first (a card per document for this chat; every time once the AI has read content from elsewhere; never for a saved document
//     the user chose "Always allow changes to this document" for, src/word/always.js), saving over a file or to a
//     new path always shows the path, hands-off mode refuses all of it, text from a document is untrusted data, nothing is ever deleted and no
//     document is closed.
// Everything with a side effect comes in through `deps`, so test/units/word-units.js drives it with a stand-in helper in plain Node.
'use strict';

const spec = require('./spec');

const MAX_FILE = 100 * 1024 * 1024;
const READ_BUDGET = 6000; // (characters of text per read; was 9000: a long document is paged with offset)
const MAX_CHECKPOINTS = 10; // (per document, while Lumen runs)
// Actions only Word's own object model does (each paragraph's formatting, deleting paragraphs, a table of contents, fields and content controls):
// a .docx that Word does not have open is opened in it first.
const WORD_ONLY = ['inspect', 'delete', 'toc', 'fields'];
// Paragraph numbers, heading paths and finds inside fields are Word's (the file route finds by text, outside fields).
const NEEDS_WORD = (v) => v.para !== undefined || Boolean(v.under) || v.fields !== undefined || ['breaks', 'paras', 'sectionBreaks', 'columnBreaks'].some((k) => Array.isArray(v[k]) && v[k].some((t) => typeof t === 'number'));

// deps: settings { enabled(), always() -> [{ key, name, added }], addAlways(key, name) }, host (com.js shape), platform, fs, checkFile(path) -> real path (throws a plain sentence), checkTarget(path) (throws for a place the AI may not write),
// docx (stand-in for ./docx), now, hooks
function createWord(deps = {}) {
  const platform = deps.platform || process.platform;
  const S = deps.settings || { enabled: () => true };
  const fs = deps.fs || require('fs');
  const checkFile = deps.checkFile || ((p) => fs.realpathSync(p));
  const checkTarget = deps.checkTarget || (() => {});
  let host = deps.host || null;
  const getHost = () => (host ||= require('./com').createWordHost({ test: deps.hostTest }));
  const docx = () => deps.docx || require('./docx');
  // The chat's live card (card.js): created with the first action; it never gets in the way of the work (every call to it is guarded).
  let card = null;
  const getCard = () => deps.card || (card ||= require('./card').createWordCard({ host: getHost(), live: deps.live || null, now: deps.now, hooks: deps.hooks, foreground: deps.foreground || null, openPath: deps.openPath || null }));
  const cardUse = (ctx, doc, label, opts) => { try { getCard().use(ctx, doc, label, opts); } catch { /* the card is a courtesy */ } };
  const cardChanged = async (ctx, doc, opts) => { try { await getCard().changed(ctx, doc, opts); } catch { /* the card is a courtesy */ } };
  const cardRead = async (ctx, doc, got) => { try { await getCard().read(ctx, doc, { text: got?.text, offset: got?.offset }); } catch { /* the card is a courtesy */ } }; // (what it reads shows as the page when Word's picture is not there)
  const sources = new WeakMap(); // run -> Set(document keys it has read)
  const keyOf = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();

  const noteRead = (ctx, key) => { const k = ctx.signal || ctx; if (!sources.has(k)) sources.set(k, new Set()); sources.get(k).add(key); };
  const readElsewhere = (ctx, key) => { const set = sources.get(ctx.signal || ctx); return Boolean(set) && [...set].some((k) => k !== key); };
  const onceKey = (key) => `word:${key}`;
  let autoSeq = 0; // ("Allowed automatically" steps)

  // ---- permission
  // level 'read': a card only when the run has read content from elsewhere. 'edit': a card for the document, once per chat, but every time after
  // content from elsewhere (a page, an email, a connector, another document). 'save': always, with the path.
  async function authorize(ctx, level, doc, { detail = '', args = '' } = {}) {
    const key = doc.key;
    const name = doc.name;
    const tainted = Boolean(ctx.tainted?.()) || (level !== 'read' && readElsewhere(ctx, key));
    const canAlways = Boolean(doc.path) && typeof S.addAlways === 'function';
    const kept = canAlways ? (S.always?.() || []).find((e) => e.key === key) : null;
    // "Allowed automatically" (an Always document): one step per chat and kind, then nothing.
    const autoStep = (what) => {
      if (ctx.once?.has(onceKey(`auto:${what}:${key}`))) return;
      ctx.once?.add(onceKey(`auto:${what}:${key}`));
      const id = `word-auto-${++autoSeq}`;
      try { ctx.emit?.({ type: 'tool', id, name: 'auto_allowed', label: `Allowed automatically: ${what} ${name} (always allowed in Settings → AI → Privacy)` }); ctx.emit?.({ type: 'tool_done', id, ok: true }); } catch { /* a closed view: the allow still stands */ }
    };
    if (level === 'read') {
      if (!tainted || ctx.once?.has(onceKey(key))) return;
      // "Always allow reading this document": no card for reading it in any chat, even after content from elsewhere (a document whose changes
      // are always allowed is read without a card too). It never allows changes.
      if (kept) { autoStep('reading'); return; }
      const always = canAlways ? { noAlways: false, alwaysLabel: 'Always allow reading this document', alwaysTitle: 'Lumen stops asking before the AI reads this document, in every chat, even after it read something else. Changes still ask. Remove it in Settings → AI → Privacy.' } : { noAlways: true };
      const ok = await ctx.ask({ title: `The AI read content earlier in this chat. Allow it to read ${name}?`, detail: 'Text it read (a web page, an email, a connector, another document) could have been written to make it do this. Allow only if you asked for it.', args: args || doc.shown, ...always, allowLabel: 'Allow reading' });
      if (!ok) throw new Error(`The user did not allow reading ${name}. Ask them what to do instead.`);
      if (ok === 'always' && canAlways) { try { S.addAlways(key, name, 'read'); } catch { /* not kept: it asks again next time */ } }
      ctx.once?.add(onceKey(key));
      return;
    }
    if (level === 'edit') {
      // "Always allow changes to this document" (a saved document only, by its full path): no card for its edits in any chat, even after the
      // AI read content from elsewhere; a step says so, once per chat. Saving still asks every time. Settings → AI → Privacy removes it.
      if (kept && kept.kind !== 'read') { autoStep('changes to'); return; } // (an entry without a kind is an edit one)
      if (!tainted && ctx.once?.has(onceKey(key))) return;
      const always = canAlways ? { noAlways: false, alwaysLabel: 'Always allow changes to this document', alwaysTitle: 'Lumen stops asking before the AI changes this document, in every chat, even after it read something else. Saving still asks. Remove it in Settings → AI → Privacy.' } : { noAlways: true };
      const ok = await ctx.ask(tainted
        ? { title: `The AI read content earlier in this chat. Allow it to change ${name}?`, detail: `Text it read (a web page, an email, a connector, another document) could have been written to make it do this. Allow only if you asked for it. Allow this change covers this one change; it is asked again next time.${canAlways ? ' Always stops asking for this document.' : ''}`, args: args || doc.shown, ...always, allowLabel: 'Allow this change' }
        : { title: `Allow the AI to edit ${name}?`, detail: detail || `It can add and change text, tables and formatting in this document while you watch. Nothing is saved to disk unless it asks to save, which shows the file first. Allow covers this chat${canAlways ? '; Always covers every chat' : ''}.`, args: args || doc.shown, ...always, allowLabel: 'Allow' });
      if (!ok) throw new Error(`The user did not allow changes to ${name}. Ask them what to do instead.`);
      if (ok === 'always' && canAlways) { try { S.addAlways(key, name, 'edit'); } catch { /* not kept: it asks again next time */ } }
      if (!tainted) ctx.once?.add(onceKey(key));
      return;
    }
    const ok = await ctx.ask({ title: detail, detail: 'The file is written exactly where shown. Nothing is deleted, and a file that is already there is replaced only if it is named here.', args: args || doc.shown, noAlways: true, allowLabel: 'Allow this save' });
    if (!ok) throw new Error(`The user did not allow that save. Ask them what to do instead.`);
  }

  // ---- finding the document
  async function installed() {
    if (platform !== 'win32') return false;
    const h = getHost();
    if (typeof h.installed === 'function' && h.installed() !== null && h.installed() !== undefined) return h.installed();
    const st = await h.status();
    return st.installed === true;
  }
  async function openDocs() { const r = await getHost().list(); return Array.isArray(r.docs) ? r.docs : []; }
  function pick(docs, v) {
    const want = String(v.action === 'save_as' ? (v.doc ?? '') : (v.doc ?? v.path ?? '')).trim().toLowerCase(); // (save_as: the path is where it goes, not which document)
    if (!docs.length) throw new Error('No document is open in Word. Use open (with a path) or new.');
    if (!want) return docs.find((d) => d.active) || docs[0];
    const full = docs.find((d) => spec.sameDoc(d.path, want)); // (a OneDrive document is listed by its web address)
    if (full) return full;
    const named = docs.filter((d) => String(d.name).toLowerCase() === want || String(d.name).toLowerCase().replace(/\.[^.]+$/, '') === want);
    if (named.length === 1) return named[0];
    if (named.length > 1) throw new Error(`More than one open document is called ${v.doc}. Use its full path (list shows them).`);
    throw new Error(`No open document matches ${v.doc ?? v.path}. Use list to see what is open, or open it.`);
  }
  const docRef = (d) => ({ name: d.name, key: d.path ? keyOf(d.path) : String(d.name).toLowerCase(), shown: `Document: ${d.name}${d.path ? `\nFile: ${d.path}` : '\n(not saved yet)'}`, path: d.path || '' });
  const fileRef = (p) => ({ name: spec.baseName(p), key: keyOf(p), shown: `File: ${p}`, path: p });

  // ---- text for the AI
  const tell = (lines) => lines.filter((l) => l !== null && l !== undefined && l !== '').join('\n');
  function formatRead(res, name, how) {
    const first = res.offset || 0;
    const head = `${name}: ${res.total} ${how === 'file' ? 'blocks (a table is one block)' : 'paragraphs'}, showing from ${first}.`;
    const extras = [];
    if (res.revisions && res.revisions.total) extras.push(`Tracked changes: ${res.revisions.total} (${res.revisions.inserted} insertions, ${res.revisions.deleted} deletions${res.revisions.other ? `, ${res.revisions.other} formatting` : ''}) by ${(res.revisions.authors || []).join(', ') || 'unknown'}.${how === 'file' ? '' : res.revisions.deleted ? ' The text below still includes the deleted words.' : ''}`);
    if (res.commentCount) extras.push(`Comments (${res.commentCount}): ${(res.comments || []).map((c) => `${c.author || 'someone'}${c.on ? ` on “${c.on}”` : ''}: ${c.text}`).join(' | ')}`);
    const body = [head, res.text, ...extras].join('\n');
    return tell([spec.wrap(body, name), res.next !== null && res.next !== undefined ? `More: call read again with offset ${res.next}.` : 'That is the end of the document.']);
  }

  // ---- the file way (no Word)
  function readFile(p) {
    const real = checkFile(p);
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAX_FILE) throw new Error('That file is not a Word document this size can be read here.');
    return { real, buf: fs.readFileSync(real) };
  }
  function writeAtomic(target, buf, { create = false } = {}) {
    const tmp = `${target}.lumen-${process.pid}-${Date.now().toString(36)}.tmp`;
    try {
      fs.writeFileSync(tmp, buf, { flag: 'wx' });
      if (create && fs.existsSync(target)) throw new Error('That file already exists. Open it instead.');
      fs.renameSync(tmp, target);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* it was never made */ }
      throw new Error(/EBUSY|EPERM|EACCES/.test(String(err.code)) ? `${spec.baseName(target)} is open in another program or read-only, so it could not be changed. Close it there and try again.` : err.message);
    }
  }
  const isDocx = (p) => /\.docx$/i.test(p);

  // Settings → AI → "Work on files in their apps" (aiFilesInApps): app = open a .docx in Word to read and edit it, file = read and write the .docx itself, auto = as before (Word when it has the document open or for anything but a plain read).
  const mode = () => { try { const v = S.filesInApps?.(); return v === 'app' || v === 'file' ? v : 'auto'; } catch { return 'auto'; } };

  // ---- run
  async function run(input, ctx) {
    if (!S.enabled()) throw new Error(spec.OFF_TEXT);
    try { getCard().busy(true); } catch { /* none */ }
    try { return await runInner(input, ctx); } finally { try { getCard().busy(false); } catch { /* none */ } }
  }

  async function runInner(input, ctx) {
    const v = spec.validate(input);
    const win = platform === 'win32';
    const fileOnly = !win; // no Word to drive here: files only
    const A = v.action;

    if (A === 'help') return spec.help(v.topic);

    if (A === 'list') {
      if (fileOnly) throw new Error(spec.NOT_WINDOWS);
      if (!(await installed())) return `${spec.NO_WORD}`;
      const docs = await openDocs();
      if (!docs.length) return 'Word has no documents open.';
      return spec.wrap(docs.map((d) => `- ${d.name}${d.path ? ` (${d.path})` : ' (not saved yet)'}${d.active ? ' [active]' : ''}${d.saved ? '' : ' unsaved changes'}${d.tracking ? ', tracked changes on' : ''}, ${d.paragraphs} paragraphs`).join('\n'), 'open documents');
    }

    // The file route: a path to a .docx and either no Word to use, or Word does not have it open.
    if (A === 'read' && v.path) {
      let open = null;
      if (win && (await installed())) { const docs = await openDocs(); open = docs.find((d) => spec.sameDoc(d.path, v.path)) || null; }
      const ref = open ? docRef(open) : fileRef(v.path);
      await authorize(ctx, 'read', ref);
      noteRead(ctx, ref.key);
      if (open) { cardUse(ctx, ref, spec.stepLabel(v, open.name)); const got = await getHost().read({ doc: open.path, offset: v.offset, budget: READ_BUDGET }); await cardRead(ctx, ref, got); return formatRead(got, open.name, 'word'); }
      if (/\.txt$/i.test(v.path)) { const { buf } = readFile(v.path); const t = buf.toString('utf8', 0, 200000); return formatRead({ total: t.split('\n').length, offset: 0, text: t, next: null }, ref.name, 'file'); }
      if (!isDocx(v.path) || (mode() === 'app' && win && (await installed()))) { if (win && (await installed())) { await openThen(v, ctx); return run({ action: 'read', doc: v.path, offset: v.offset }, ctx); } throw new Error('Without Word only .docx files can be read.'); }
      const { buf } = readFile(v.path);
      const got = await docx().readDocx(buf, { offset: v.offset, budget: READ_BUDGET });
      cardUse(ctx, ref, spec.stepLabel(v, ref.name), { com: false });
      await cardChanged(ctx, ref, { lines: require('./card').pageLines(got.text.split('\n').slice(0, 12), -1, 0) });
      return formatRead(got, ref.name, 'file');
    }

    if (['new', 'insert', 'table', 'format', 'style', 'image', 'replace', 'comment', 'track', ...WORD_ONLY].includes(A) && v.path && !(await wordHasIt(v))) {
      if (win && (mode() !== 'file' || !isDocx(v.path)) && (await installed())) { // (file: a .docx is changed in the file itself; any other kind still needs Word)
        if (A !== 'new') await openThen(v, ctx); // Word is there: the document is opened in it and changed there
        else return newViaWord(v, ctx);
      } else return fileWrite(v, ctx);
    }
    // checkpoint and restore of a .docx Word does not have open: a copy of the file itself
    if ((A === 'checkpoint' || A === 'restore') && v.path && !(await wordHasIt(v))) return fileCheckpoint(v, ctx);

    if (fileOnly) throw new Error(spec.NOT_WINDOWS);
    if (!(await installed())) throw new Error(spec.NO_WORD);

    switch (A) {
      case 'open': return openThen(v, ctx, true);
      case 'new': return newViaWord(v, ctx);
      case 'read': {
        const d = docRef(pick(await openDocs(), v));
        await authorize(ctx, 'read', d);
        noteRead(ctx, d.key);
        cardUse(ctx, d, spec.stepLabel(v, d.name));
        const got = await getHost().read({ doc: d.path || d.name, offset: v.offset, budget: READ_BUDGET });
        await cardRead(ctx, d, got);
        return formatRead(got, d.name, 'word');
      }
      case 'show': { const d = pick(await openDocs(), v); cardUse(ctx, docRef(d), spec.stepLabel(v, d.name)); const r = await getHost().show({ doc: d.path || d.name }); return `Word is showing ${d.name}${r.shown === false ? ' (its window stays hidden in this run)' : ''}.`; }
      case 'save': {
        const d = pick(await openDocs(), v);
        if (!d.path) throw new Error(`${d.name} has never been saved. Use save_as with a path.`);
        const ref = docRef(d);
        cardUse(ctx, ref, spec.stepLabel(v, d.name));
        await authorize(ctx, 'save', ref, { detail: `Allow the AI to save changes over ${d.path}?`, args: `File: ${d.path}\nThis replaces what is in the file with the document as it is now.` });
        await getHost().save({ doc: d.path });
        return `Saved ${d.name} to ${d.path}.`;
      }
      case 'save_as': {
        const d = pick(await openDocs(), v);
        checkTarget(v.path);
        cardUse(ctx, docRef(d), spec.stepLabel(v, d.name));
        const exists = fs.existsSync(v.path);
        await authorize(ctx, 'save', docRef(d), { detail: `Allow the AI to save ${d.name} as ${v.path}?`, args: `New file: ${v.path}${exists ? '\nA file with this name is already there and would be replaced.' : ''}\nFormat: ${v.format === 'pdf' ? 'PDF (the document stays as it is)' : 'Word document'}` });
        const r = await getHost().saveAs({ doc: d.path || d.name, path: v.path, format: v.format });
        return `Saved as ${r.path || v.path}${v.format === 'docx' ? `. The open document is now called ${r.doc}.` : '.'}`;
      }
      case 'inspect': {
        const d = docRef(pick(await openDocs(), v));
        await authorize(ctx, 'read', d);
        noteRead(ctx, d.key);
        cardUse(ctx, d, spec.stepLabel(v, d.name));
        return inspectText(await getHost().inspect({ doc: d.path || d.name, ...formatFields(v) }), d.name, v);
      }
      case 'fields': {
        if (spec.fieldsChange(v)) break; // (update, unlink, control: an edit, below)
        const d = docRef(pick(await openDocs(), v));
        await authorize(ctx, 'read', d);
        noteRead(ctx, d.key);
        cardUse(ctx, d, spec.stepLabel(v, d.name));
        return fieldsText(await getHost().fields({ doc: d.path || d.name }), d.name);
      }
      case 'checkpoint': {
        const d = docRef(pick(await openDocs(), v));
        if (v.list) return checkpointList(d);
        cardUse(ctx, d, spec.stepLabel(v, d.name));
        const cp = await takeCheckpoint(d, d.path || d.name, v.name);
        return `Saved checkpoint “${cp.name}” of ${d.name} (${cp.paragraphs} paragraphs, ${clock(cp.at)}). restore with name “${cp.name}” puts the document back as it is now. Lumen keeps checkpoints while it runs (the last ${MAX_CHECKPOINTS} per document).`;
      }
      default: break;
    }

    // everything else changes the document
    const docs = await openDocs();
    const d = pick(docs, v);
    const ref = docRef(d);
    await authorize(ctx, 'edit', ref, { args: `${ref.shown}\n${spec.stepLabel(v, d.name)}${v.text ? `\n\n${String(v.text).slice(0, 400)}${v.text.length > 400 ? '…' : ''}` : ''}` });
    const target = d.path || d.name;
    const H = getHost();
    cardUse(ctx, ref, spec.stepLabel(v, d.name));
    const done = async (text) => { await cardChanged(ctx, ref); return text; };
    const hint = d.tracking ? '' : ' Tracked changes are off, so the edit is not marked; track with on:true shows later edits as revisions.';
    switch (A) {
      case 'insert': { if (v.find) { const r = await H.insert({ doc: target, ...formatFields(v) }); return done(`${atDone(r.done || {}, d.name, v)} Not saved yet.${hint}`); } const r = await H.insert({ doc: target, at: v.at, heading: v.heading, text: v.text, style: v.style, levels: v.levels, bold: v.bold, italic: v.italic }); return done(`Added ${r.paragraphs} paragraph${r.paragraphs === 1 ? '' : 's'} to ${d.name}${placeText(v)}. Not saved yet.${hint}`); }
      case 'replace': { const r = await H.replace({ doc: target, ...formatFields(v) }); return done(r.replaced ? `Replaced ${r.replaced} match${r.replaced === 1 ? '' : 'es'} of “${spec.clip(v.find, 40)}” in ${d.name}${scopeText(r.scope)}${r.capped ? ' (stopped at the limit)' : ''}.${skipText(r.skipped)}${r.locked ? ` ${r.locked} ${r.locked === 1 ? 'was' : 'were'} in a locked content control, unlocked for the change and locked again.` : ''} Not saved yet.${hint}` : `No match for “${spec.clip(v.find, 40)}” in ${d.name}${scopeText(r.scope)}; nothing changed.${skipText(r.skipped)} find must be the document's text exactly as read shows it (same case, spaces and punctuation); each line of read is a paragraph, and a shorter find within one paragraph is surer.`); }
      case 'format': { const r = await H.format({ doc: target, ...formatFields(v) }); return done(`${formatDone(r.done || {}, d.name, v, false)} Not saved yet.${d.tracking ? '' : ' Tracked changes are off, so the edit is not marked.'}`); }
      case 'style': { const r = await H.style({ doc: target, ...formatFields(v) }); return done(`${styleDone(r, d.name, v)}${skipText(r.skipped)}`); }
      case 'delete': {
        if (v.breaks) { const r = await H.delete({ doc: target, ...formatFields(v) }); return done(`${unbreakDone(r.unbroken || {}, d.name, v)} Not saved yet.${hint}`); }
        const p = await H.delete({ doc: target, ...formatFields(v), preview: true });
        if (!p.preview || !p.preview.count) return `Nothing to delete in ${d.name}: there ${v.emptyHeadings ? 'are no empty headings' : v.empty ? 'are no empty paragraphs' : 'is nothing'} ${v.para !== undefined || v.under ? 'there' : 'in it'}; nothing changed.`;
        const n = p.preview.count;
        const ok = await ctx.ask({ kind: 'content-loss', site: d.name, title: `The AI is about to delete ${n} paragraph${n === 1 ? '' : 's'} from ${d.name}`, args: `${(p.preview.lines || []).join('\n')}\n\nA checkpoint of the document is saved first, so restore brings them back.` });
        if (!ok) throw new Error(`The user did not allow deleting those paragraphs. Nothing was changed. Ask them what to do instead.`);
        const cp = await takeCheckpoint(ref, target, 'before delete');
        const r = await H.delete({ doc: target, ...formatFields(v) });
        return done(`Deleted ${r.deleted} paragraph${r.deleted === 1 ? '' : 's'} from ${d.name}${r.tracking ? ' (marked as tracked deletions)' : ''}; it has ${r.paragraphs} now. Checkpoint “${cp.name}” has the document as it was: restore with name “${cp.name}” brings them back. Not saved yet.`);
      }
      case 'toc': {
        const cp = v.rebuild ? await takeCheckpoint(ref, target, 'before toc') : null;
        const r = await H.toc({ doc: target, ...formatFields(v) });
        return done(`${tocDone(r, d.name, v)}${cp ? ` (checkpoint “${cp.name}” has it as it was)` : ''}. Not saved yet.`);
      }
      case 'fields': {
        const cp = v.unlink !== undefined ? await takeCheckpoint(ref, target, 'before unlink') : null;
        const r = await H.fields({ doc: target, ...formatFields(v) });
        return done(`${fieldsDone(r, d.name, v)}${cp ? ` Checkpoint “${cp.name}” has it as it was.` : ''} Not saved yet.`);
      }
      case 'restore': {
        const cp = pickCheckpoint(ref, v.name, 'word');
        const ok = await ctx.ask({ kind: 'content-loss', site: d.name, title: `The AI is about to put ${d.name} back as it was at checkpoint “${cp.name}” (${clock(cp.at)})`, args: `Everything in the document now is replaced by that copy (${cp.paragraphs} paragraphs). What is there now is saved first as a checkpoint, so this can be undone.` });
        if (!ok) throw new Error('The user did not allow restoring that checkpoint. Nothing was changed. Ask them what to do instead.');
        const now = await takeCheckpoint(ref, target, 'before restore');
        await H.restore({ doc: target, file: cp.file, sections: cp.sections });
        return done(`Restored ${d.name} to checkpoint “${cp.name}” (${clock(cp.at)}). What was there just before is checkpoint “${now.name}”. Not saved yet.`);
      }
      case 'table': { if (isEdit(v)) { if (v.deleteRows || v.deleteColumns) await confirmLoss(ctx, d.name, v, (await H.table({ doc: target, ...formatFields(v), preview: true })).preview); const r = await H.table({ doc: target, ...formatFields(v) }); return done(`${tableDone(r.done || {}, d.name, v)} Not saved yet.${hint}`); } const r = await H.table({ doc: target, ...formatFields(v) }); return done(`Added a table (${r.rows} rows, ${r.columns} columns) to ${d.name}${placeText(v)}${r.caption ? `, captioned “Table ${r.caption}${v.caption ? `: ${spec.clip(v.caption, 40)}` : ''}”` : ''}. Not saved yet.${hint}`); }
      case 'image': { const pic = await pictureFor(v); let r; try { r = await H.image({ doc: target, ...formatFields(v), url: undefined, image: pic.file }); } finally { pic.done(); } return done(`${imageDone(r, d.name, v, pic)} Not saved yet.${hint}`); }
      case 'comment': await H.comment({ doc: target, find: v.find, text: v.text }); return done(`Added a comment on “${spec.clip(v.find, 40)}” in ${d.name}.`);
      case 'track': { const r = await H.track({ doc: target, ...formatFields(v) }); if (v.review) return done(reviewDone(r.reviewed, d.name, v)); return `Tracked changes are ${r.tracking ? 'on' : 'off'} in ${d.name}.`; }
      default: throw new Error('Unknown action.');
    }
  }

  // format: the fields formatDocx and the helper take, and what was done, in words.
  const formatFields = (v) => { const { action, path, doc, ...f } = v; void action; void path; void doc; return f; };

  // ---- checkpoints: a copy of the whole document (Word's WordOpenXML, or the .docx file's bytes) in Lumen's own temp folder, kept while Lumen
  // runs (the last MAX_CHECKPOINTS per document), put back by restore after the user saw what it does. Removed when Lumen closes.
  const checkpoints = new Map(); // document key -> [{ n, name, at, file, kind, sections, paragraphs }]
  let cpDir = null;
  const P = require('path');
  const cpFolder = () => { if (!cpDir) { cpDir = deps.checkpointDir || P.join(require('os').tmpdir(), 'lumen-word-checkpoints', `${process.pid}-${Date.now().toString(36)}`); fs.mkdirSync(cpDir, { recursive: true }); } return cpDir; };
  const nowMs = () => (deps.now ? Number(deps.now()) : Date.now());
  const clock = (ms) => { const t = new Date(ms); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
  const keyHash = (k) => require('crypto').createHash('sha1').update(k).digest('hex').slice(0, 12);
  function newCheckpoint(ref, name, kind) {
    const list = checkpoints.get(ref.key) || [];
    const n = (list.length ? list[list.length - 1].n : 0) + 1;
    let label = name || `checkpoint ${n}`;
    if (list.some((c) => c.name.toLowerCase() === label.toLowerCase())) label = `${label} ${n}`;
    return { list, cp: { n, name: label, at: nowMs(), kind, file: P.join(cpFolder(), `${keyHash(ref.key)}-${n}.${kind === 'word' ? 'xml' : 'docx'}`) } };
  }
  function keep(ref, list, cp) {
    list.push(cp);
    while (list.length > MAX_CHECKPOINTS) { const old = list.shift(); try { fs.unlinkSync(old.file); } catch { /* gone */ } }
    checkpoints.set(ref.key, list);
    return cp;
  }
  async function takeCheckpoint(ref, target, name) {
    const { list, cp } = newCheckpoint(ref, name, 'word');
    const r = await getHost().checkpoint({ doc: target, file: cp.file });
    return keep(ref, list, { ...cp, sections: r.sections || [], paragraphs: r.paragraphs });
  }
  function pickCheckpoint(ref, name, kind) {
    const list = checkpoints.get(ref.key) || [];
    if (!list.length) throw new Error(`${ref.name} has no checkpoint in this Lumen session. Save one with checkpoint before a big edit.`);
    const cp = name ? list.find((c) => c.name.toLowerCase() === name.toLowerCase()) || list.find((c) => String(c.n) === name) : list[list.length - 1];
    if (!cp) throw new Error(`${ref.name} has no checkpoint called “${name}”. It has: ${list.map((c) => `“${c.name}” (${clock(c.at)})`).join(', ')}.`);
    if (cp.kind !== kind) throw new Error(`Checkpoint “${cp.name}” is a copy of the ${cp.kind === 'word' ? 'document as Word had it open' : 'file on disk'}, so it is restored the same way: ${cp.kind === 'word' ? 'with the document open in Word' : 'with path, while Word does not have the file open'}.`);
    return cp;
  }
  function checkpointList(ref) {
    const list = checkpoints.get(ref.key) || [];
    if (!list.length) return `${ref.name} has no checkpoints yet.`;
    return `Checkpoints of ${ref.name} (newest last): ${list.map((c) => `“${c.name}” at ${clock(c.at)}${c.paragraphs !== undefined ? ` (${c.paragraphs} paragraphs)` : ''}`).join('; ')}.`;
  }
  async function fileCheckpoint(v, ctx) {
    if (!isDocx(v.path)) throw new Error('Checkpoints of a file work on .docx files; other kinds open in Word first.');
    const { real, buf } = readFile(v.path);
    const ref = fileRef(real);
    if (v.action === 'checkpoint') {
      if (v.list) return checkpointList(ref);
      await authorize(ctx, 'read', ref);
      const { list, cp } = newCheckpoint(ref, v.name, 'file');
      fs.writeFileSync(cp.file, buf, { flag: 'wx' });
      keep(ref, list, cp);
      return `Saved checkpoint “${cp.name}” of ${ref.name} (a copy of the file, ${clock(cp.at)}). restore with path and name “${cp.name}” puts the file back as it is now.`;
    }
    const cp = pickCheckpoint(ref, v.name, 'file');
    checkTarget(real);
    await authorize(ctx, 'save', ref, { detail: `Allow the AI to put ${real} back as it was at checkpoint “${cp.name}” (${clock(cp.at)})?`, args: `File: ${real}\nThe file is replaced by the copy Lumen saved then. The file as it is now is saved first as a checkpoint, so this can be undone.` });
    const { list, cp: now } = newCheckpoint(ref, 'before restore', 'file');
    fs.writeFileSync(now.file, buf, { flag: 'wx' });
    keep(ref, list, now);
    writeAtomic(real, fs.readFileSync(cp.file));
    return `Restored ${ref.name} to checkpoint “${cp.name}” (${clock(cp.at)}), saved in the file. The file as it was just before is checkpoint “${now.name}”.`;
  }

  // ---- text for the new actions
  const scopeText = (s) => (s ? (s.name ? ` under “${spec.clip(s.name, 40)}” (paragraphs ${s.a}–${s.b})` : s.a === s.b ? ` in paragraph ${s.a}` : ` in paragraphs ${s.a}–${s.b}`) : '');
  const skipText = (n) => (n ? ` ${n} match${n === 1 ? ' in the table of contents or a field was' : 'es in the table of contents or fields were'} left as ${n === 1 ? 'it is' : 'they are'} (Word writes that text; include_fields true changes ${n === 1 ? 'it' : 'them'} too, and toc update refreshes the contents).` : '');
  const pt = (x) => `${Math.round(Number(x) * 10) / 10}`;
  const inch = (x) => `${Math.round(Number(x) / 72 * 100) / 100}`;
  const fontWords = (o = {}) => [o.font || 'mixed fonts', o.size !== undefined ? `${pt(o.size)} pt` : 'mixed sizes', o.bold === true && 'bold', o.bold === 'mixed' && 'partly bold', o.italic === true && 'italic', o.italic === 'mixed' && 'partly italic'].filter(Boolean).join(' ');
  function inspectText(r, name, v) {
    const rows = (r.rows || []).map((x) => {
      const bits = [x.style || '(no style)', fontWords(x), `before ${pt(x.before)} pt, after ${pt(x.after)} pt, line ${x.line}`, x.align];
      if (x.indent !== undefined || x.firstLine !== undefined) bits.push(`indent ${x.indent ?? 0} in${x.firstLine !== undefined ? `, first line ${x.firstLine} in` : ''}`);
      if (x.page !== undefined) bits.push(`page ${x.page}`);
      const flags = [x.pageBreakBefore && 'page break before', x.pageBreaks && `${x.pageBreaks === 1 ? 'a page break' : `${x.pageBreaks} page breaks`} in it`, x.sectionBreak && `section break after (${x.sectionBreak})`, x.columnBreaks && 'column break', x.keepNext && 'keep with next', x.list && `list ${x.list}`, x.table && 'in a table', x.toc && 'table of contents', x.fields && `fields: ${x.fields.join(', ')}`, x.control && `content control ${x.control}${x.locked ? ' (locked)' : ''}`].filter(Boolean);
      return `[${x.i}] ${bits.join(' | ')}${flags.length ? ` | ${flags.join(', ')}` : ''} | “${x.text || ''}”`;
    });
    const b = r.body || {};
    const secs = (r.sections || []).slice(0, 6).map((s, k) => `section ${k + 1}: ${s.o === 1 ? 'landscape' : 'portrait'} ${inch(s.w)} × ${inch(s.h)} in, margins ${inch(s.t)} ${inch(s.r)} ${inch(s.b)} ${inch(s.l)} in (top right bottom left)${s.cols > 1 ? `, ${s.cols} columns` : ''}${s.first ? ', different first page' : ''}`);
    const head = [`${name}: ${r.total} paragraphs${r.scope ? `; ${scopeText(r.scope).trim()}` : ''}${v.find ? `; ${r.matched || 0} paragraph${r.matched === 1 ? '' : 's'} with “${spec.clip(v.find, 40)}”` : ''}.`, `Body text (Normal style): ${fontWords(b)}, before ${pt(b.before)} pt, after ${pt(b.after)} pt, line ${b.line}.`, `Pages: ${secs.join('; ')}${(r.sections || []).length > 6 ? `; and ${r.sections.length - 6} more sections` : ''}.`, r.tocs ? `Tables of contents: ${r.tocs}.` : 'No table of contents.', 'Each line: [paragraph number] style | font size | spacing | alignment | page | breaks and where it sits | its text. para / to / under take these numbers.'];
    const body = [...head, ...rows].join('\n');
    return [spec.wrap(body, name), r.next ? `More: inspect with para ${r.next}.` : rows.length ? '' : 'No paragraphs there.', skipText(r.skipped).trim()].filter(Boolean).join('\n');
  }
  function fieldsText(r, name) {
    const fl = (r.fields || []).map((f) => `[${f.i}] ${f.kind} (paragraph ${f.para}): ${f.code}${f.result ? ` → “${f.result}”` : ''}`);
    const cl = (r.controls || []).map((c) => `[${c.i}] ${c.type}${c.title ? ` “${c.title}”` : ''}${c.tag ? ` (tag ${c.tag})` : ''} (paragraph ${c.para})${c.locked ? ', contents locked' : ''}${c.fixed ? ', cannot be deleted' : ''}: “${c.text}”`);
    const lines = [`Fields in ${name}: ${r.fieldCount || 0}${r.inToc ? ` (${r.inToc} of them are the table of contents' own links and page numbers, not listed)` : ''}.`, ...fl, r.more ? `...and ${r.more} more.` : '', `Content controls: ${r.controlCount || 0}.`, ...cl].filter(Boolean);
    const tip = r.tocs ? 'To change one line of the table of contents: fields unlink "toc" makes it plain text (delete or replace then work line by line, but toc update no longer does), or toc rebuild remakes it from the headings. fields update true updates every field.' : 'fields update true updates every field (cross-references, page numbers, captions).';
    return `${spec.wrap(lines.join('\n'), name)}\n${tip}`;
  }
  function unbreakDone(u, name, v) {
    const parts = [u.page && `${u.page} page break${u.page === 1 ? '' : 's'}`, u.before && `"page break before" on ${u.before} paragraph${u.before === 1 ? '' : 's'}`, u.section && `${u.section} section break${u.section === 1 ? '' : 's'} (the text before each now takes the page setup of the section after it)`, u.column && `${u.column} column break${u.column === 1 ? '' : 's'}`].filter(Boolean);
    return parts.length ? `Removed ${parts.join(', ')} in ${name}${v.para !== undefined || v.under ? ' (in the paragraphs given)' : ''}.` : `There were no ${v.breaks === 'all' ? '' : `${v.breaks} `}breaks to remove in ${name}${v.para !== undefined || v.under ? ' there' : ''}; nothing changed.`;
  }
  function tocDone(r, name) {
    if (r.updated) return `Updated the table of contents in ${name} (${r.entries} lines)`;
    if (r.rebuilt) return `Rebuilt the table of contents in ${name} from Heading ${r.upper} to ${r.lower}, in the same place with its title (${r.entries} lines)`;
    return `Added a table of contents to ${name}${r.title ? ` under “${spec.clip(r.title, 40)}”` : ''}, from Heading ${r.upper} to ${r.lower} (${r.entries} lines)`;
  }
  function fieldsDone(r, name, v) {
    if (v.update) return `Updated ${r.updated} field${r.updated === 1 ? '' : 's'} in ${name}${r.headers ? ` and ${r.headers} in headers and footers` : ''}${r.tocs ? `, and ${r.tocs === 1 ? 'the table of contents' : `${r.tocs} tables of contents`}` : ''}.${r.failed ? ' Word said at least one field has an error (read shows "Error!" where it is).' : ''}`;
    if (v.unlink !== undefined) return `Made ${r.unlinked === 'TOC' ? 'the table of contents' : `the ${r.unlinked} field`} at paragraph ${r.para} of ${name} plain text: its lines can now be edited or deleted one by one, and Word no longer updates ${r.unlinked === 'TOC' ? 'it (toc adds a new one)' : 'it'}.`;
    const c = r.control || {};
    return `Content control ${c.i}${c.title ? ` “${spec.clip(c.title, 40)}”` : ''} in ${name}: ${[r.text && 'its text was set (its lock is as it was)', r.unlocked && 'unlocked, so replace and delete can change it'].filter(Boolean).join('; ')}.`;
  }
  function formatDone(r, name, v, file) {
    const out = [];
    const q = (t) => `“${spec.clip(t, 40)}”`;
    if (r.headings) out.push(`styled ${r.headings} heading${r.headings === 1 ? '' : 's'}`);
    if (r.toc) out.push(r.toc.already ? (file ? 'the table of contents was already there; Word updates it when the document opens' : 'updated the table of contents that was already there') : `added a table of contents${r.toc.title ? ` under ${q(r.toc.title)}` : ''}${r.toc.replaced ? ` in place of the typed list (${r.toc.replaced} line${r.toc.replaced === 1 ? '' : 's'})` : ''}${file ? ' (Word fills it in from the Heading 1 to 3 paragraphs when the document opens: it asks to update fields)' : ' from the Heading 1 to 3 paragraphs'}`);
    if (r.breaks) {
      if (r.breaks.added?.length) out.push(`page break${r.breaks.added.length === 1 ? '' : 's'} before ${r.breaks.added.map(q).join(', ')}`);
      if (r.breaks.had?.length) out.push(`${r.breaks.had.map(q).join(', ')} already start${r.breaks.had.length === 1 ? 's' : ''} a page`);
    }
    if (r.text) {
      const what = [r.text.created && `made the style ${q(v.style)}${v.basedOn ? ` (based on ${v.basedOn})` : ''}`, !r.text.created && v.basedOn && `based ${q(v.style)} on ${v.basedOn}`, v.list && (v.list === 'none' ? 'took them out of the list' : `made them a ${v.list === 'bullet' ? 'bulleted' : 'numbered'} list${v.level > 1 ? ` (level ${v.level})` : ''}`), ...charWords(v), v.line !== undefined && (v.line > 5 ? `${v.line} pt lines` : `${v.line} line spacing`), v.before !== undefined && `${v.before} pt before`, v.after !== undefined && `${v.after} pt after`, v.align && `${v.align} aligned`, v.indent !== undefined && `indent ${v.indent} in`, v.firstLine !== undefined && (v.firstLine < 0 ? `hanging indent ${-v.firstLine} in` : `first line ${v.firstLine} in`), v.keepNext !== undefined && (v.keepNext ? 'kept with the next paragraph' : 'not kept with the next')].filter(Boolean).join(', ');
      const where = r.text.style ? `the ${r.text.style} style` : r.text.find ? `${r.text.paragraphs ?? 'the'} ${file ? 'paragraph' : 'place'}${r.text.paragraphs === 1 ? '' : 's'} with ${q(r.text.find)}` : r.text.paragraphs ? `${r.text.paragraphs} paragraph${r.text.paragraphs === 1 ? '' : 's'}` : 'the whole document (Normal and the headings)';
      out.push(r.text.created && !hasLook(v) ? what : `${what} for ${where}`);
    }
    for (const [k, what] of [['sectionBreaks', `${{ continuous: 'continuous section break', evenPage: 'even-page section break', oddPage: 'odd-page section break' }[v.sectionBreak] || 'section break (new page)'}`], ['columnBreaks', 'column break']]) {
      if (r[k]?.added?.length) out.push(`${what}${r[k].added.length === 1 ? '' : 's'} before ${r[k].added.map(q).join(', ')}`);
      if (r[k]?.had?.length) out.push(`${r[k].had.map(q).join(', ')} already start${r[k].had.length === 1 ? 's' : ''} one`);
    }
    const hfText = (p) => [p.left, p.center, p.right].filter(Boolean).join(' | ');
    const page = [v.margins && 'margins', v.orientation, v.header && `header “${spec.clip(hfText(v.header), 40)}”`, v.footer && `footer “${spec.clip(hfText(v.footer), 40)}”`, v.firstPage === true && 'a first page without them', v.firstPage === false && 'the same header and footer on the first page', v.pageStart !== undefined && `page numbers from ${v.pageStart}`, v.columns !== undefined && (v.columns > 1 ? `${v.columns} columns` : 'one column')].filter(Boolean);
    if (r.properties?.length) out.push(`the document's ${r.properties.join(', ')} (File > Info)`);
    if (r.sections && page.length) out.push(`${page.join(', ')} in ${r.sections} section${r.sections === 1 ? '' : 's'}`);
    return `Formatted ${name}: ${out.join('; ') || 'nothing needed changing'}.`;
  }
  const charWords = (v) => [v.font && `font ${v.font}`, v.size && `size ${v.size} pt`, v.bold !== undefined && (v.bold ? 'bold' : 'not bold'), v.italic !== undefined && (v.italic ? 'italic' : 'not italic'), v.underline && (v.underline === 'none' ? 'no underline' : `${v.underline === 'single' ? '' : `${v.underline} `}underline`), v.strike !== undefined && (v.strike ? 'struck through' : 'not struck through'), v.color && `color ${v.color === 'auto' ? 'automatic' : `#${v.color}`}`, v.highlight && (v.highlight === 'none' ? 'no highlight' : `${v.highlight} highlight`)].filter(Boolean);
  const hasLook = (v) => charWords(v).length > 0 || ['line', 'before', 'after', 'align', 'indent', 'firstLine', 'keepNext'].some((k) => v[k] !== undefined);
  const styleDone = (r, name, v) => (r.formatted ? `Formatted ${r.formatted} match${r.formatted === 1 ? '' : 'es'} of ${`“${spec.clip(v.find, 40)}”`} in ${name}: ${[v.style && `style ${v.style}`, ...charWords(v), r.links && `${r.links === 1 ? 'a link' : `${r.links} links`} to ${v.link.startsWith('#') ? `the bookmark ${v.link.slice(1)}` : spec.clip(v.link, 60)}`, r.bookmark && `bookmarked as ${r.bookmark} (ref and #links can point at it)`].filter(Boolean).join(', ')}.` : `No match for “${spec.clip(v.find, 40)}” in ${name}; nothing changed.`);
  // insert with find: what went in after the match
  const atDone = (r, name, v) => `${r.ref ? `Added a cross-reference to ${r.ref}` : r.note ? `Added ${r.note.kind === 'endnote' ? 'an endnote' : 'a footnote'}${r.note.id ? ` (${r.note.kind} ${r.note.id})` : ''}` : 'Added the text'} after “${spec.clip(v.find, 40)}” in ${name}.${r.ref ? ' Word keeps it up to date (it updates fields on opening and printing).' : ''}`;
  const isEdit = (v) => v.index !== undefined || v.find !== undefined;
  // [content guard] rows or columns taken out: the remove card, every time (after the document's edit card), with what goes.
  async function confirmLoss(ctx, name, v, p) {
    const what = v.deleteRows ? (p.count === 1 ? 'row' : 'rows') : (p.count === 1 ? 'column' : 'columns');
    const ok = await ctx.ask({ kind: 'content-loss', site: name, title: `The AI is about to delete ${p.count} ${what} from table ${p.index} in ${name}`, args: `${(p.lines || []).join('\n')}` });
    if (!ok) throw new Error(`The user did not allow deleting those ${what}. Nothing was changed. Ask them what to do instead.`);
  }
  // a table that is there, changed: what was done, in words
  function tableDone(r, name, v) {
    const out = [];
    if (r.deletedRows) out.push(`${r.deletedRows} row${r.deletedRows === 1 ? '' : 's'} deleted`);
    if (r.deletedColumns) out.push(`${r.deletedColumns} column${r.deletedColumns === 1 ? '' : 's'} deleted`);
    if (r.cells) out.push(`${r.cells} cell${r.cells === 1 ? '' : 's'} filled in`);
    if (r.rows) out.push(`${r.rows} row${r.rows === 1 ? '' : 's'} added`);
    if (r.column) out.push(`a column added (now column ${r.column})`);
    const look = [v.header !== undefined && (v.header ? 'a header row' : 'no header row'), v.widths && 'column widths', v.borders && `borders ${v.borders}`, v.shading && `header fill #${v.shading}`, v.align && `${v.align} aligned`].filter(Boolean);
    if (look.length) out.push(look.join(', '));
    return `Changed table ${r.index ?? v.index ?? ''}${r.tables ? ` of ${r.tables}` : ''} in ${name}: ${out.join('; ') || 'nothing needed changing'}.`;
  }
  const reviewDone = (n, name, v) => (n ? `${v.review === 'accept' ? 'Accepted' : 'Rejected'} ${n} tracked change${n === 1 ? '' : 's'}${v.author ? ` by ${v.author}` : ''}${v.find ? ` around “${spec.clip(v.find, 40)}”` : ''} in ${name}.` : `There are no tracked changes${v.author ? ` by ${v.author}` : ''}${v.find ? ` around “${spec.clip(v.find, 40)}”` : ''} in ${name}; nothing changed.`);
  const placeText = (v) => (v.at === 'start' ? ' at the start' : v.at === 'after' ? ` after “${spec.clip(v.heading, 40)}”` : v.at === 'section_end' ? ` at the end of “${spec.clip(v.heading, 40)}”` : ' at the end');
  function checkImage(p) {
    const real = checkFile(p);
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > spec.MAX.image) throw new Error('That picture is not a file of a size that can be inserted (at most 20 MB).');
    return real;
  }
  // The picture an image call names: a file (checked by the AI's file rules, and by its bytes) or a web address (fetched only after the card,
  // into a temp file for Word). -> { buf, info, file, name, done() (removes a temp file) }
  async function pictureFor(v) {
    const P = require('./picture');
    if (v.url) {
      const got = await (deps.fetchPicture || P.fetchPicture)(v.url);
      const name = (() => { try { return decodeURIComponent(new URL(v.url).pathname.split('/').pop() || '') || 'picture'; } catch { return 'picture'; } })().replace(/[^\w .()-]/g, '_').slice(0, 80);
      let file = null;
      if (platform === 'win32') {
        const dir = require('path').join(require('os').tmpdir(), 'lumen-word-pictures');
        fs.mkdirSync(dir, { recursive: true });
        file = require('path').join(dir, `${process.pid}-${Date.now().toString(36)}.${got.info.ext}`);
        fs.writeFileSync(file, got.buf, { flag: 'wx' });
      }
      return { ...got, file, name, from: new URL(v.url).hostname, done: () => { if (file) try { fs.unlinkSync(file); } catch { /* gone */ } } };
    }
    const real = checkImage(v.image);
    const buf = fs.readFileSync(real);
    const info = P.pictureInfo(buf);
    if (!info) throw new Error('That file is not a PNG, JPEG, GIF or BMP picture (by its contents), so nothing was inserted.');
    return { buf, info, file: real, name: spec.baseName(real), done: () => {} };
  }
  function imageDone(r, name, v, pic) {
    const size = r?.size ? ` (${r.size.width} × ${r.size.height} in)` : '';
    const wrap = v.wrap && v.wrap !== 'inline' ? `, text wrapped ${v.wrap.replace('_', ' and ')}` : '';
    const cap = r?.caption ? `, captioned “Figure ${r.caption}${v.caption ? `: ${spec.clip(v.caption, 40)}` : ''}”` : '';
    return `Added the picture ${pic.from ? `from ${pic.from}` : pic.name}${size} to ${name}${placeText(v)}${wrap}${cap}.`;
  }

  async function wordHasIt(v) {
    if (platform !== 'win32' || !(await installed())) return false;
    return (await openDocs()).some((d) => spec.sameDoc(d.path, v.path));
  }

  // open: a card only when the run has read content from elsewhere.
  async function openThen(v, ctx, report = false) {
    const real = checkFile(v.path);
    const ref = fileRef(real);
    await authorize(ctx, 'read', ref, { args: `File: ${real}` });
    const r = await getHost().open({ path: real });
    ctx.once?.add(onceKey(keyOf(real)));
    cardUse(ctx, { ...ref, name: r.doc.name || ref.name }, spec.stepLabel(v, r.doc.name || ref.name));
    await cardChanged(ctx, ref);
    return report ? `${r.already ? 'Already open' : 'Opened'}: ${r.doc.name}. ${r.doc.paragraphs} paragraphs.` : null;
  }

  async function newViaWord(v, ctx) {
    if (v.path) {
      checkTarget(v.path);
      if (fs.existsSync(v.path)) throw new Error('That file already exists. Open it instead, or choose another name.');
      await authorize(ctx, 'save', fileRef(v.path), { detail: `Allow the AI to create ${v.path}?`, args: `New file: ${v.path}` });
    }
    const r = await getHost().new({});
    cardUse(ctx, { name: r.doc.name, key: String(r.doc.name).toLowerCase(), path: '', shown: r.doc.name }, spec.stepLabel(v, r.doc.name));
    ctx.once?.add(onceKey(String(r.doc.name).toLowerCase())); // a document the AI made is the AI's to fill in
    if (v.path) { await getHost().saveAs({ doc: r.doc.name, path: v.path, format: 'docx' }); ctx.once?.add(onceKey(keyOf(v.path))); return `Created ${spec.baseName(v.path)} (open in Word).`; }
    return `Started a new document: ${r.doc.name}. It is not saved yet (save_as with a path saves it).`;
  }

  async function fileWrite(v, ctx) {
    const A = v.action;
    if (WORD_ONLY.includes(A)) throw new Error(`${A} works through Microsoft Word (it needs Word's own view of the document)${platform === 'win32' ? ', and Word is not used for this file here (Settings → AI → "Work on files in their apps", or Word is not installed)' : ', which is on Windows only'}. On the file, read, replace, format, table and insert still work.`);
    if (NEEDS_WORD(v)) throw new Error('para, to, under, include_fields and paragraph numbers need Microsoft Word with the document open (open it first). On the file itself, find, heading and paragraph texts pick the place.');
    if (A === 'new') {
      checkTarget(v.path);
      if (fs.existsSync(v.path)) throw new Error('That file already exists.');
      await authorize(ctx, 'save', fileRef(v.path), { detail: `Allow the AI to create ${v.path}?`, args: `New file: ${v.path}\nMicrosoft Word is not used for this; the file is written directly.` });
      cardUse(ctx, fileRef(v.path), spec.stepLabel(v, spec.baseName(v.path)), { com: false });
      writeAtomic(v.path, docx().newDocx(), { create: true });
      return `Created ${spec.baseName(v.path)}. Microsoft Word is not in use here, so the file was written directly.`;
    }
    if (!isDocx(v.path)) throw new Error('Without Word only .docx files can be changed.');
    if (A === 'image' && !v.url) checkImage(v.image); // (a picture that is not there says so before the card)
    const { real, buf } = readFile(v.path);
    checkTarget(real);
    const ref = fileRef(real);
    await authorize(ctx, 'save', ref, { detail: `Allow the AI to write into ${real}?`, args: `File: ${real}\n${spec.stepLabel(v, ref.name)}\nWord is not in use, so the file itself is changed (the edit is marked as a tracked change by "${docx().AUTHOR}").${v.text ? `\n\n${String(v.text).slice(0, 400)}` : ''}` });
    const op = A === 'insert' ? { insert: { at: v.at, heading: v.heading, text: v.text, style: v.style, levels: v.levels, bold: v.bold, italic: v.italic } } : { table: formatFields(v) };
    cardUse(ctx, ref, spec.stepLabel(v, ref.name), { com: false });
    const before = (await docx().readDocx(buf, { budget: 1e6 })).text.split(String.fromCharCode(10));
    const pic = A === 'image' ? await pictureFor(v) : null;
    const r = A === 'replace' ? await docx().replaceDocx(buf, formatFields(v), { track: true }) : A === 'comment' ? await docx().commentDocx(buf, formatFields(v)) : A === 'track' ? (v.review ? await docx().reviewDocx(buf, formatFields(v)) : await docx().trackDocx(buf, v.on)) : A === 'insert' && v.find ? await docx().insertDocx(buf, formatFields(v), { track: true }) : A === 'image' ? await docx().imageDocx(buf, { ...formatFields(v), data: pic.buf, info: pic.info, name: pic.name }, { track: true }) : A === 'format' ? await docx().formatDocx(buf, formatFields(v), { track: true }) : A === 'style' ? await docx().styleDocx(buf, formatFields(v)) : A === 'table' && isEdit(v) ? await (async () => { if (v.deleteRows || v.deleteColumns) await confirmLoss(ctx, ref.name, v, await docx().tableDeletion(buf, formatFields(v))); return docx().tableDocx(buf, formatFields(v), { track: true }); })() : await docx().editDocx(buf, op, { track: true });
    if (r.buf !== buf) writeAtomic(real, r.buf);
    try { await cardChanged(ctx, ref, { lines: require('./card').pageAround(before, (await docx().readDocx(r.buf, { budget: 1e6 })).text.split(String.fromCharCode(10))) }); } catch { /* the preview is a courtesy */ }
    noteRead(ctx, ref.key);
    if (A === 'replace') return r.replaced ? `Replaced ${r.replaced} match${r.replaced === 1 ? '' : 'es'} of “${spec.clip(v.find, 40)}” in ${ref.name}${charWords(v).length ? ` (the new text ${charWords(v).join(', ')})` : ''}. Saved in the file, as tracked changes.` : `No match for “${spec.clip(v.find, 40)}” in ${ref.name}; nothing changed. find must be the text exactly as read shows it, inside one paragraph.`;
    if (A === 'comment') return `Added a comment on “${spec.clip(v.find, 40)}” in ${ref.name} (saved in the file).`;
    if (A === 'track') return v.review ? `${reviewDone(r.count, ref.name, v)}${r.count ? ' Saved in the file.' : ''}` : `Tracked changes are ${v.on ? 'on' : 'off'} in ${ref.name} (saved in the file): Word marks the next edits as revisions.`;
    if (A === 'insert' && v.find) return `${atDone(r.done, ref.name, v)} Saved in the file, as a tracked change.`;
    if (A === 'image') return `${imageDone(r, ref.name, v, pic)} Saved in the file, as a tracked change.`;
    if (A === 'table' && isEdit(v)) return `${tableDone(r.done, ref.name, v)} Saved in the file; ${v.deleteRows || v.deleteColumns ? 'the deletion is not a tracked change (merged cells were mended).' : 'new and replaced text and new rows are tracked changes, the look is not.'}`;
    if (A === 'style') return `${styleDone(r, ref.name, v)} Saved in the file (formatting is not a tracked change).`;
    if (A === 'format') return `${formatDone(r.done, ref.name, v, true)}${v.header || v.footer ? ' Page numbers and other fields show their real values when Word updates them (it does on opening and printing).' : ''} Saved in the file; new text, page breaks and removed lines are tracked changes, and style and page changes are not.`;
    return A === 'insert' ? `Added ${r.paragraphs} paragraph${r.paragraphs === 1 ? '' : 's'} to ${ref.name}${placeText(v)} (saved in the file, as a tracked change).` : `Added a table (${r.rows} rows, ${r.columns} columns) to ${ref.name}${placeText(v)}${r.caption ? `, captioned “Table ${r.caption}${v.caption ? `: ${spec.clip(v.caption, 40)}` : ''}”` : ''} (saved in the file, as a tracked change).`;
  }

  return {
    run, installed, host: () => host,
    finishRun(signal) { try { return card?.finishRun(signal); } catch { return null; } }, // the run is over: the card's last picture and "completed"
    openCard: (id, hint) => getCard().open(id, hint || {}), // "Show in Word" on the card: { ok } or { ok: false, message } (a card from before a restart opens its file by hint.path)
    destroy() { try { card?.destroy(); } catch { /* none */ } try { host?.destroy?.(); } catch { /* not running */ } if (cpDir && !deps.checkpointDir) { try { fs.rmSync(cpDir, { recursive: true, force: true }); } catch { /* left for the system's temp cleanup */ } } }, // (the checkpoints are Lumen's own copies)
  };
}

module.exports = { createWord };
