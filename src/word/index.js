// [word] The AI working with Microsoft Word documents directly (Settings > AI > "Let the AI use Microsoft Word", on by default; the Word helper
// itself only starts the first time the tool is used). One tool, word(action, ...), whose actions are in spec.js. docs/word.md has the whole model:
//   - Windows with Word installed: Word's own object model through a hidden helper (com.js): the real document, with its real undo and styles;
//   - no Word (or another system): a .docx file is read with its structure, and new paragraphs, headings and tables are written straight into the
//     file (docx.js), as tracked changes, after the user says yes to that file;
//   - an edit asks first (a card per document for this chat; every time once the AI has read content from elsewhere), saving over a file or to a
//     new path always shows the path, hands-off mode refuses all of it, text from a document is untrusted data, nothing is ever deleted and no
//     document is closed.
// Everything with a side effect comes in through `deps`, so test/word-units.js drives it with a stand-in helper in plain Node.
'use strict';

const spec = require('./spec');

const MAX_FILE = 100 * 1024 * 1024;
const READ_BUDGET = 9000;

// deps: settings { enabled() }, host (com.js shape), platform, fs, checkFile(path) -> real path (throws a plain sentence), checkTarget(path) (throws for a place the AI may not write),
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
  const getCard = () => deps.card || (card ||= require('./card').createWordCard({ host: getHost(), live: deps.live || null, now: deps.now, hooks: deps.hooks }));
  const cardUse = (ctx, doc, label, opts) => { try { getCard().use(ctx, doc, label, opts); } catch { /* the card is a courtesy */ } };
  const cardChanged = async (ctx, doc, opts) => { try { await getCard().changed(ctx, doc, opts); } catch { /* the card is a courtesy */ } };
  const cardRead = async (ctx, doc, got) => { try { await getCard().read(ctx, doc, { text: got?.text, offset: got?.offset }); } catch { /* the card is a courtesy */ } }; // (what it reads shows as the page when Word's picture is not there)
  const sources = new WeakMap(); // run -> Set(document keys it has read)
  const keyOf = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();

  const noteRead = (ctx, key) => { const k = ctx.signal || ctx; if (!sources.has(k)) sources.set(k, new Set()); sources.get(k).add(key); };
  const readElsewhere = (ctx, key) => { const set = sources.get(ctx.signal || ctx); return Boolean(set) && [...set].some((k) => k !== key); };
  const onceKey = (key) => `word:${key}`;

  // ---- permission
  // level 'read': a card only when the run has read content from elsewhere. 'edit': a card for the document, once per chat, but every time after
  // content from elsewhere (a page, an email, a connector, another document). 'save': always, with the path.
  async function authorize(ctx, level, doc, { detail = '', args = '' } = {}) {
    const key = doc.key;
    const name = doc.name;
    const tainted = Boolean(ctx.tainted?.()) || (level !== 'read' && readElsewhere(ctx, key));
    if (level === 'read') {
      if (!tainted || ctx.once?.has(onceKey(key))) return;
      const ok = await ctx.ask({ title: `The AI read content earlier in this chat. Allow it to read ${name}?`, detail: 'Text it read (a web page, an email, a connector, another document) could have been written to make it do this. Allow only if you asked for it.', args: args || doc.shown, noAlways: true, allowLabel: 'Allow reading' });
      if (!ok) throw new Error(`The user did not allow reading ${name}. Ask them what to do instead.`);
      ctx.once?.add(onceKey(key));
      return;
    }
    if (level === 'edit') {
      if (!tainted && ctx.once?.has(onceKey(key))) return;
      const ok = await ctx.ask(tainted
        ? { title: `The AI read content earlier in this chat. Allow it to change ${name}?`, detail: 'Text it read (a web page, an email, a connector, another document) could have been written to make it do this. Allow only if you asked for it. This answer covers this one change; it is asked again next time.', args: args || doc.shown, noAlways: true, allowLabel: 'Allow this change' }
        : { title: `Allow the AI to edit ${name}?`, detail: detail || 'It can add and change text, tables and formatting in this document while you watch. Nothing is saved to disk unless it asks to save, which shows the file first. Once allows it for this chat.', args: args || doc.shown, noAlways: true, allowLabel: 'Allow' });
      if (!ok) throw new Error(`The user did not allow changes to ${name}. Ask them what to do instead.`);
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
    const full = docs.find((d) => d.path && keyOf(d.path) === keyOf(want));
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
      if (win && (await installed())) { const docs = await openDocs(); open = docs.find((d) => d.path && keyOf(d.path) === keyOf(v.path)) || null; }
      const ref = open ? docRef(open) : fileRef(v.path);
      await authorize(ctx, 'read', ref);
      noteRead(ctx, ref.key);
      if (open) { cardUse(ctx, ref, spec.stepLabel(v, open.name)); const got = await getHost().read({ doc: open.path, offset: v.offset, budget: READ_BUDGET }); await cardRead(ctx, ref, got); return formatRead(got, open.name, 'word'); }
      if (/\.txt$/i.test(v.path)) { const { buf } = readFile(v.path); const t = buf.toString('utf8', 0, 200000); return formatRead({ total: t.split('\n').length, offset: 0, text: t, next: null }, ref.name, 'file'); }
      if (!isDocx(v.path)) { if (win && (await installed())) { await openThen(v, ctx); return run({ action: 'read', doc: v.path, offset: v.offset }, ctx); } throw new Error('Without Word only .docx files can be read.'); }
      const { buf } = readFile(v.path);
      const got = await docx().readDocx(buf, { offset: v.offset, budget: READ_BUDGET });
      cardUse(ctx, ref, spec.stepLabel(v, ref.name), { com: false });
      await cardChanged(ctx, ref, { lines: require('./card').pageLines(got.text.split('\n').slice(0, 12), -1, 0) });
      return formatRead(got, ref.name, 'file');
    }

    if ((A === 'new' || A === 'insert' || A === 'table') && v.path && !(await wordHasIt(v))) {
      if (win && (await installed())) {
        if (A !== 'new') await openThen(v, ctx); // Word is there: the document is opened in it and changed there
        else return newViaWord(v, ctx);
      } else return fileWrite(v, ctx);
    }

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
      case 'insert': { const r = await H.insert({ doc: target, at: v.at, heading: v.heading, text: v.text, style: v.style, bold: v.bold, italic: v.italic }); return done(`Added ${r.paragraphs} paragraph${r.paragraphs === 1 ? '' : 's'} to ${d.name}${placeText(v)}. Not saved yet.${hint}`); }
      case 'replace': { const r = await H.replace({ doc: target, find: v.find, replace: v.replace }); return done(r.replaced ? `Replaced ${r.replaced} match${r.replaced === 1 ? '' : 'es'} of “${spec.clip(v.find, 40)}” in ${d.name}${r.capped ? ' (stopped at the limit)' : ''}. Not saved yet.${hint}` : `No match for “${spec.clip(v.find, 40)}” in ${d.name}; nothing changed.`); }
      case 'style': { const r = await H.style({ doc: target, find: v.find, style: v.style, bold: v.bold, italic: v.italic }); return done(r.formatted ? `Formatted ${r.formatted} match${r.formatted === 1 ? '' : 'es'} in ${d.name}.` : `No match for “${spec.clip(v.find, 40)}” in ${d.name}; nothing changed.`); }
      case 'table': { const r = await H.table({ doc: target, at: v.at, heading: v.heading, rows: v.rows }); return done(`Added a table (${r.rows} rows, ${r.columns} columns) to ${d.name}${placeText(v)}. Not saved yet.${hint}`); }
      case 'image': { checkImage(v.image); await H.image({ doc: target, at: v.at, heading: v.heading, image: v.image }); return done(`Added the picture ${spec.baseName(v.image)} to ${d.name}${placeText(v)}. Not saved yet.${hint}`); }
      case 'comment': await H.comment({ doc: target, find: v.find, text: v.text }); return done(`Added a comment on “${spec.clip(v.find, 40)}” in ${d.name}.`);
      case 'track': { const r = await H.track({ doc: target, on: v.on }); return `Tracked changes are ${r.tracking ? 'on' : 'off'} in ${d.name}.`; }
      default: throw new Error('Unknown action.');
    }
  }

  const placeText = (v) => (v.at === 'start' ? ' at the start' : v.at === 'after' ? ` after “${spec.clip(v.heading, 40)}”` : v.at === 'section_end' ? ` at the end of “${spec.clip(v.heading, 40)}”` : ' at the end');
  function checkImage(p) {
    const real = checkFile(p);
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > spec.MAX.image) throw new Error('That picture is not a file of a size that can be inserted (at most 20 MB).');
  }

  async function wordHasIt(v) {
    if (platform !== 'win32' || !(await installed())) return false;
    return (await openDocs()).some((d) => d.path && keyOf(d.path) === keyOf(v.path));
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
    if (A === 'new') {
      checkTarget(v.path);
      if (fs.existsSync(v.path)) throw new Error('That file already exists.');
      await authorize(ctx, 'save', fileRef(v.path), { detail: `Allow the AI to create ${v.path}?`, args: `New file: ${v.path}\nMicrosoft Word is not used for this; the file is written directly.` });
      cardUse(ctx, fileRef(v.path), spec.stepLabel(v, spec.baseName(v.path)), { com: false });
      writeAtomic(v.path, docx().newDocx(), { create: true });
      return `Created ${spec.baseName(v.path)}. Microsoft Word is not in use here, so the file was written directly.`;
    }
    if (!isDocx(v.path)) throw new Error('Without Word only .docx files can be changed.');
    const { real, buf } = readFile(v.path);
    checkTarget(real);
    const ref = fileRef(real);
    await authorize(ctx, 'save', ref, { detail: `Allow the AI to write into ${real}?`, args: `File: ${real}\n${spec.stepLabel(v, ref.name)}\nWord is not in use, so the file itself is changed (the edit is marked as a tracked change by "${docx().AUTHOR}").${v.text ? `\n\n${String(v.text).slice(0, 400)}` : ''}` });
    const op = A === 'insert' ? { insert: { at: v.at, heading: v.heading, text: v.text, style: v.style } } : { table: { at: v.at, heading: v.heading, rows: v.rows } };
    cardUse(ctx, ref, spec.stepLabel(v, ref.name), { com: false });
    const before = (await docx().readDocx(buf, { budget: 1e6 })).text.split(String.fromCharCode(10));
    const r = await docx().editDocx(buf, op, { track: true });
    writeAtomic(real, r.buf);
    try { await cardChanged(ctx, ref, { lines: require('./card').pageAround(before, (await docx().readDocx(r.buf, { budget: 1e6 })).text.split(String.fromCharCode(10))) }); } catch { /* the preview is a courtesy */ }
    noteRead(ctx, ref.key);
    return A === 'insert' ? `Added ${r.paragraphs} paragraph${r.paragraphs === 1 ? '' : 's'} to ${ref.name}${placeText(v)} (saved in the file, as a tracked change).` : `Added a table (${r.rows} rows, ${r.columns} columns) to ${ref.name}${placeText(v)} (saved in the file, as a tracked change).`;
  }

  return {
    run, installed, host: () => host,
    finishRun(signal) { try { return card?.finishRun(signal); } catch { return null; } }, // the run is over: the card's last picture and "completed"
    openCard: (id) => (card ? card.open(id) : Promise.resolve(false)), // "Show in Word" on the card
    destroy() { try { card?.destroy(); } catch { /* none */ } try { host?.destroy?.(); } catch { /* not running */ } },
  };
}

module.exports = { createWord };
