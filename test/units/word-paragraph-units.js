// [word] The Word tool's paragraph-level work (src/word: spec.js, index.js, host.ps1), plain Node with a stand-in helper (real Word never runs):
// targeting by paragraph number (para, to) and heading path (under), finds that leave out the table of contents and fields, inspect (each
// paragraph's formatting read back), delete (paragraphs, empty headings, breaks; the remove card first and a checkpoint before), toc (add,
// update, rebuild), fields (list, update, unlink, content controls), checkpoint and restore (Word's copy and the file's), and the script's
// shape for each (Word's own calls, every Delete accounted for, plain ASCII, no value run as code).
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const spec = require('../../src/word/spec');
const { createWord } = require('../../src/word');
const { createWordHost } = require('../../src/word/com');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const J = JSON.stringify;
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const B = String.fromCharCode(92);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpu-'));
const DOC = { name: 'Report.docx', path: `C:${B}Docs${B}Report.docx`, active: true, saved: true, tracking: false, paragraphs: 40 };

// A stand-in helper: records every call, answers like host.ps1 does.
function rig({ answers = [], tainted = false, host: extra = {} } = {}) {
  const calls = [];
  const cards = [];
  const queue = answers.slice();
  const once = new Set();
  const rec = (name, out) => async (a) => { calls.push([name, a]); return typeof out === 'function' ? out(a) : out; };
  const host = {
    installed: () => true, status: async () => ({ installed: true }), list: async () => ({ docs: [DOC] }),
    replace: rec('replace', { replaced: 2, capped: false, skipped: 3, locked: 1, scope: { a: 30, b: 34, name: 'References' } }),
    style: rec('style', { formatted: 2, skipped: 1, paragraphs: true }),
    format: rec('format', { done: { text: { paragraphs: 3 } } }),
    insert: rec('insert', { paragraphs: 1 }),
    inspect: rec('inspect', { doc: 'Report.docx', total: 40, from: 1, next: 41, tocs: 1, body: { font: 'Calibri', size: 11, before: 0, after: 8, line: '1.08' }, sections: [{ o: 0, w: 612, h: 792, t: 72, r: 72, b: 72, l: 72, cols: 1, first: 0 }], rows: [{ i: 1, style: 'Title', font: 'Calibri Light', size: 28, before: 0, after: 0, line: '1', align: 'left', page: 1, text: 'Lab 3 report' }, { i: 2, style: 'TOC 1', font: 'Calibri', size: 11, before: 0, after: 5, line: '1.08', align: 'left', page: 1, toc: true, control: 1, locked: true, text: 'References\t9' }, { i: 7, style: 'Heading 1', font: 'Calibri Light', size: 16, bold: true, before: 12, after: 0, line: '1.08', align: 'left', page: 2, level: 1, pageBreakBefore: true, sectionBreak: 'new page', text: 'Methods' }] }),
    delete: rec('delete', (a) => (a.breaks ? { unbroken: { page: 2, section: 1, column: 0, before: 1 } } : a.preview ? { preview: { count: 3, lines: ['[11] ## Procedure', '[12] Step one.', '[13] Step two.'] } } : { deleted: 3, paragraphs: 37, tracking: false })),
    toc: rec('toc', (a) => (a.update ? { updated: 1, entries: 9 } : a.rebuild ? { rebuilt: true, upper: 1, lower: a.lower || 3, entries: 9 } : { added: true, upper: a.upper || 1, lower: a.lower || 3, title: a.title || '', entries: 9 })),
    fields: rec('fields', (a) => (a.update ? { updated: 12, headers: 2, tocs: 1, failed: false } : a.unlink !== undefined ? { unlinked: 'TOC', para: 2 } : a.control !== undefined ? { control: { i: a.control, title: 'Abstract', type: 'rich text' }, text: a.text !== undefined, unlocked: Boolean(a.unlock) } : { fields: [{ i: 1, kind: 'TOC', code: 'TOC \\o "1-3" \\h', result: 'Intro 1 Methods 2', para: 2 }, { i: 9, kind: 'REF', code: 'REF _Ref1 \\h', result: 'Figure 1', para: 20 }], fieldCount: 9, inToc: 7, more: 0, controls: [{ i: 1, type: 'building block', title: 'Table of Contents', tag: '', locked: true, fixed: false, text: 'Contents', para: 1 }], controlCount: 1, tocs: 1 })),
    checkpoint: rec('checkpoint', (a) => { fs.writeFileSync(a.file, '<pkg/>'); return { paragraphs: 40, sections: [{ o: 0 }], size: 6 }; }),
    restore: rec('restore', { paragraphs: 40, sections: 1 }),
    ...extra,
  };
  const ctx = { signal: {}, tainted: () => tainted, once: { has: (k) => once.has(k), add: (k) => once.add(k) }, ask: async (card) => { cards.push(card); return queue.length ? queue.shift() : true; } };
  const dir = fs.mkdtempSync(path.join(tmp, 'cp-'));
  const word = createWord({ settings: { enabled: () => true }, host, platform: 'win32', card: { use() {}, changed: async () => {}, read: async () => {}, busy() {} }, checkpointDir: dir, now: () => new Date(2026, 10, 24, 14, 5).getTime() });
  return { word, calls, cards, ctx, dir, of: (n) => calls.filter((c) => c[0] === n).map((c) => c[1]) };
}

(async () => {
  // ---- validation: targets, and each new action's fields
  {
    const v = (i) => spec.validate(i);
    check('targets: para and to, "12-15", and a heading path under "A > B" (leading # and spaces dropped)', J(v({ action: 'replace', find: 'a', replace: 'b', para: 12, to: 15 })) === J({ action: 'replace', find: 'a', replace: 'b', para: 12, to: 15 }) && v({ action: 'replace', find: 'a', replace: 'b', para: '12-15' }).to === 15 && J(v({ action: 'style', find: 'a', bold: true, under: '## Results >  Discussion' }).under) === J(['Results', 'Discussion']));
    check('targets: to without para, to before para, para with under, a path deeper than 6 are refused', /to goes with para/.test(throws(() => v({ action: 'replace', find: 'a', replace: 'b', to: 3 }))) && /later paragraph/.test(throws(() => v({ action: 'replace', find: 'a', replace: 'b', para: 5, to: 3 }))) && /not both/.test(throws(() => v({ action: 'replace', find: 'a', replace: 'b', para: 5, under: 'A' }))) && /at most 6/.test(throws(() => v({ action: 'replace', find: 'a', replace: 'b', under: 'a>b>c>d>e>f>g' }))));
    check('targets: include_fields is a boolean, kept as fields; actions that do not take targets refuse them', v({ action: 'replace', find: 'a', replace: 'b', include_fields: true }).fields === true && /does not take para/.test(throws(() => v({ action: 'track', on: true, para: 3 })) || ''));
    check('style: para or under alone styles those whole paragraphs (no find needed); without either, find is still required', v({ action: 'style', para: 4, style: 'Heading 2' }).find === undefined && /find is required/.test(throws(() => v({ action: 'style', style: 'Heading 2' }))));
    check('format: para / under pick paragraphs, may go with find, not with style or paragraphs; list takes them too', J(v({ action: 'format', para: 5, to: 9, font: 'Calibri' })) === J({ action: 'format', font: 'Calibri', para: 5, to: 9 }) && v({ action: 'format', under: 'Methods', find: 'Step', bold: true }).find === 'Step' && /para and under pick/.test(throws(() => v({ action: 'format', para: 3, style: 'Normal', bold: true }))) && v({ action: 'format', under: 'Steps', list: 'number' }).list === 'number');
    check('format: page and section breaks take paragraph numbers as well as texts', J(v({ action: 'format', page_break_before: [12, 'Results'] }).breaks) === J([12, 'Results']) && J(v({ action: 'format', section_break_before: 30 }).sectionBreaks) === J([30]) && /paragraph texts \(as read shows them\) or paragraph numbers/.test(throws(() => v({ action: 'format', page_break_before: [0] }))));
    check('insert / table / image: para goes after that paragraph, under at the end of that section; another at is refused', J(v({ action: 'insert', para: 4, text: 'x' })) === J({ action: 'insert', at: 'after', para: 4, text: 'x' }) && v({ action: 'table', under: 'Data', rows: [['a']] }).at === 'section_end' && /after that paragraph/.test(throws(() => v({ action: 'insert', para: 4, at: 'end', text: 'x' }))) && /heading .* or para/.test(throws(() => v({ action: 'image', para: 4, heading: 'x', image: 'C:\\a\\b.png' }))));
    check('read: para starts there (offset para - 1), numbers true shows [n]', J(v({ action: 'read', para: 10, numbers: true })) === J({ action: 'read', offset: 9, numbers: true }) && /offset or para/.test(throws(() => v({ action: 'read', para: 2, offset: 4 }))));
    check('delete: para / to, under, empty_headings, empty, breaks page|section|column|all; nothing to delete is refused, breaks go alone', v({ action: 'delete', para: 3, to: 5 }).to === 5 && v({ action: 'delete', empty_headings: true }).emptyHeadings === true && v({ action: 'delete', breaks: true }).breaks === 'all' && v({ action: 'delete', breaks: 'Sections', under: 'Appendix' }).breaks === 'section' && /delete takes para/.test(throws(() => v({ action: 'delete' }))) && /delete takes para/.test(throws(() => v({ action: 'delete', empty: false }))) && /a call of its own/.test(throws(() => v({ action: 'delete', breaks: 'page', empty: true }))) && /breaks must be/.test(throws(() => v({ action: 'delete', breaks: 'line' }))) && /does not take find/.test(throws(() => v({ action: 'delete', find: 'x' })) || ''));
    check('toc: levels 3 or "2-4", title, para (0 is the start) or heading; update and rebuild alone', J(v({ action: 'toc', levels: '2-4', title: 'Contents', para: 0 })) === J({ action: 'toc', upper: 2, lower: 4, title: 'Contents', para: 0 }) && v({ action: 'toc', levels: 2 }).lower === 2 && /not both/.test(throws(() => v({ action: 'toc', update: true, rebuild: true }))) && /update keeps its levels/.test(throws(() => v({ action: 'toc', update: true, levels: 3 }))) && /rebuild keeps the title/.test(throws(() => v({ action: 'toc', rebuild: true, title: 'x' }))) && /levels is/.test(throws(() => v({ action: 'toc', levels: '4-2' }))));
    check('fields: nothing lists; update true; unlink a number or "toc"; control with text or unlock; one at a time', J(v({ action: 'fields' })) === J({ action: 'fields' }) && v({ action: 'fields', unlink: 'TOC' }).unlink === 'toc' && v({ action: 'fields', unlink: 4 }).unlink === 4 && v({ action: 'fields', control: 2, text: '' }).text === '' && /Give one of/.test(throws(() => v({ action: 'fields', update: true, unlink: 1 }))) && /control takes text/.test(throws(() => v({ action: 'fields', control: 2 }))) && /go with control/.test(throws(() => v({ action: 'fields', unlock: true }))) && /update must be true/.test(throws(() => v({ action: 'fields', update: false }))));
    check('fields: only update, unlink and control change the document (spec.fieldsChange)', !spec.fieldsChange({ action: 'fields' }) && spec.fieldsChange({ update: true }) && spec.fieldsChange({ unlink: 'toc' }) && spec.fieldsChange({ control: 1 }));
    check('checkpoint / restore: an optional short name, list alone; a name that is not a label is refused', v({ action: 'checkpoint', name: 'before toc' }).name === 'before toc' && v({ action: 'restore', name: 2 }).name === '2' && v({ action: 'checkpoint', list: true }).list === true && /short label/.test(throws(() => v({ action: 'restore', name: 'a/b' }))) && /give it alone/.test(throws(() => v({ action: 'checkpoint', list: true, name: 'x' }))));
    check('kinds: inspect and checkpoint read; delete, toc, fields and restore are edits (refused in hands-off, asked about)', spec.kind('inspect') === 'read' && spec.kind('checkpoint') === 'read' && ['delete', 'toc', 'fields', 'restore'].every((a) => spec.kind(a) === 'edit'));
    check('labels: the card says which paragraphs, which section, and what', spec.stepLabel({ action: 'delete', para: 3, to: 5 }, 'R.docx') === 'Editing R.docx: deleting paragraphs 3–5' && spec.stepLabel({ action: 'replace', find: 'a', replace: 'b', under: 'References' }, 'R.docx') === 'Editing R.docx: replacing “a” with “b” under “References”' && spec.stepLabel({ action: 'style', para: 4, style: 'Heading 2' }, 'R.docx') === 'Formatting R.docx: paragraph 4 as Heading 2' && spec.stepLabel({ action: 'toc', rebuild: true }, 'R.docx') === 'Rebuilding the table of contents in R.docx' && spec.stepLabel({ action: 'fields', unlink: 'toc' }, 'R.docx') === 'Editing R.docx: making the table of contents plain text' && spec.stepLabel({ action: 'restore' }, 'R.docx') === 'Restoring R.docx to its last checkpoint');
    check('help: every new action and the targets have a line', ['targets', 'inspect', 'delete', 'toc:', 'fields', 'checkpoint'].every((t) => spec.help().includes(t)) && /include_fields/.test(spec.help('targets')));
  }

  // ---- replace and style: where, and what was left out
  {
    const r = rig();
    const said = await r.word.run({ action: 'replace', find: 'References', replace: 'Works Cited', under: 'References' }, r.ctx);
    check('replace under a heading: the helper gets the path and the default skip; the answer names the section, the matches left in the table of contents, and the locked control', J(r.of('replace')[0].under) === J(['References']) && r.of('replace')[0].fields === undefined && /Replaced 2 matches of “References” in Report\.docx under “References” \(paragraphs 30–34\)\./.test(said) && /3 matches in the table of contents or fields were left as they are/.test(said) && /include_fields true/.test(said) && /locked content control, unlocked for the change and locked again/.test(said), said);
    const s2 = await r.word.run({ action: 'style', para: 7, to: 8, style: 'Heading 2' }, r.ctx);
    check('style by paragraph number: para and to go to the helper with no find', r.of('style')[0].para === 7 && r.of('style')[0].to === 8 && r.of('style')[0].find === undefined && /1 match in the table of contents or a field was left as it is/.test(s2), s2);
  }

  // ---- inspect: formatting read back, a read (no edit card), wrapped as document text
  {
    const r = rig();
    const said = await r.word.run({ action: 'inspect', under: 'Methods' }, r.ctx);
    check('inspect: a read (no card on a clean run), the helper gets the scope', r.cards.length === 0 && J(r.of('inspect')[0].under) === J(['Methods']), J(r.cards));
    check('inspect: body font, page setup, and each paragraph with its number, style, font, spacing, page, breaks and where it sits', /Body text \(Normal style\): Calibri 11 pt, before 0 pt, after 8 pt, line 1\.08/.test(said) && /section 1: portrait 8\.5 × 11 in, margins 1 1 1 1 in/.test(said) && /\[7\] Heading 1 \| Calibri Light 16 pt bold \| before 12 pt, after 0 pt, line 1\.08 \| left \| page 2 \| page break before, section break after \(new page\) \| “Methods”/.test(said) && /\[2\] TOC 1 .*table of contents, content control 1 \(locked\)/.test(said) && /More: inspect with para 41/.test(said), said);
    check('inspect: what the document says is untrusted data, in the wrapper', /^<untrusted_page_content source="word: Report\.docx">/.test(said));
    const t = rig({ tainted: true });
    await t.word.run({ action: 'inspect' }, t.ctx);
    check('inspect: after content from elsewhere it asks before reading, like read', t.cards.length === 1 && /Allow it to read Report\.docx/.test(t.cards[0].title));
  }

  // ---- delete: the edit card, then the remove card with what goes, a checkpoint, then the delete
  {
    const r = rig();
    const said = await r.word.run({ action: 'delete', under: 'Methods > Procedure' }, r.ctx);
    const loss = r.cards.find((c) => c.kind === 'content-loss');
    const d = r.of('delete');
    check('delete: preview first, the remove card lists the paragraphs that go, a checkpoint before, then the delete', d.length === 2 && d[0].preview === true && !d[1].preview && loss && loss.title === 'The AI is about to delete 3 paragraphs from Report.docx' && /\[11\] ## Procedure\n\[12\] Step one\.\n\[13\] Step two\./.test(loss.args) && r.calls.findIndex((c) => c[0] === 'checkpoint') > r.calls.findIndex((c) => c[0] === 'delete') && r.calls.findIndex((c) => c[0] === 'checkpoint') < r.calls.length - 1, J(r.calls.map((c) => c[0])));
    check('delete: the answer says how many went and which checkpoint brings them back', /Deleted 3 paragraphs from Report\.docx; it has 37 now\. Checkpoint “before delete” has the document as it was: restore with name “before delete” brings them back/.test(said), said);
    const no = rig({ answers: [true, false] });
    const refused = await rejects(() => no.word.run({ action: 'delete', para: 11, to: 13 }, no.ctx));
    check('delete: a No on the remove card deletes nothing and saves no checkpoint (only the preview was asked)', /did not allow deleting those paragraphs/.test(refused || '') && no.of('delete').length === 1 && no.of('delete')[0].preview === true && no.of('checkpoint').length === 0, refused);
    const none = rig({ host: { delete: async () => ({ count: 0 }) } });
    check('delete: nothing matching changes nothing and asks no remove card', /Nothing to delete in Report\.docx: there are no empty headings in it/.test(await none.word.run({ action: 'delete', empty_headings: true }, none.ctx)) && !none.cards.some((c) => c.kind === 'content-loss'));
    const br = rig();
    const sb = await br.word.run({ action: 'delete', breaks: 'all', para: 20, to: 40 }, br.ctx);
    check('delete breaks: no remove card (nothing written goes), the answer counts each kind', !br.cards.some((c) => c.kind === 'content-loss') && /Removed 2 page breaks, "page break before" on 1 paragraph, 1 section break \(the text before each now takes the page setup of the section after it\) in Report\.docx \(in the paragraphs given\)/.test(sb), sb);
  }

  // ---- toc and fields
  {
    const r = rig();
    const add = await r.word.run({ action: 'toc', title: 'Contents', levels: '1-2', heading: 'Abstract' }, r.ctx);
    check('toc: a new one goes to the helper with its title, levels and place; the answer says so', J(r.of('toc')[0]) === J({ doc: DOC.path, upper: 1, lower: 2, title: 'Contents', heading: 'Abstract' }) && /Added a table of contents to Report\.docx under “Contents”, from Heading 1 to 2 \(9 lines\)/.test(add), add);
    const reb = await r.word.run({ action: 'toc', rebuild: true }, r.ctx);
    check('toc rebuild: a checkpoint first, then it is made again in its place', r.of('checkpoint').length === 1 && /Rebuilt the table of contents in Report\.docx from Heading 1 to 3, in the same place with its title/.test(reb) && /checkpoint “before toc”/.test(reb), reb);
    check('toc update: no checkpoint, the lines are counted', /Updated the table of contents in Report\.docx \(9 lines\)/.test(await r.word.run({ action: 'toc', update: true }, r.ctx)) && r.of('checkpoint').length === 1);
    const list = await r.word.run({ action: 'fields' }, r.ctx);
    check('fields: the list is a read (wrapped), numbered fields with their paragraph, the table of contents\' own links counted not listed, and content controls with their lock', /^<untrusted_page_content/.test(list) && /\[1\] TOC \(paragraph 2\): TOC \\o "1-3" \\h → “Intro 1 Methods 2”/.test(list) && /\[9\] REF \(paragraph 20\)/.test(list) && /7 of them are the table of contents' own links/.test(list) && /\[1\] building block “Table of Contents” \(paragraph 1\), contents locked: “Contents”/.test(list) && /fields unlink "toc" makes it plain text/.test(list), list);
    const un = await r.word.run({ action: 'fields', unlink: 'toc' }, r.ctx);
    check('fields unlink: a checkpoint first; the answer says its lines are now editable and Word no longer updates it', r.of('checkpoint').length === 2 && /Made the table of contents at paragraph 2 of Report\.docx plain text: its lines can now be edited or deleted one by one/.test(un) && /Checkpoint “before unlink”/.test(un), un);
    check('fields update and control: the answers say what happened', /Updated 12 fields in Report\.docx and 2 in headers and footers, and the table of contents\./.test(await r.word.run({ action: 'fields', update: true }, r.ctx)) && /Content control 1 “Abstract” in Report\.docx: its text was set/.test(await r.word.run({ action: 'fields', control: 1, text: 'Short abstract.' }, r.ctx)) && /unlocked, so replace and delete can change it/.test(await r.word.run({ action: 'fields', control: 1, unlock: true }, r.ctx)));
    const t = rig({ tainted: true });
    await t.word.run({ action: 'fields' }, t.ctx);
    await t.word.run({ action: 'fields', update: true }, t.ctx);
    check('fields: listing asks like a read after content from elsewhere; a change asks like an edit', t.cards.length === 2 && /read Report\.docx/.test(t.cards[0].title) && /change Report\.docx/.test(t.cards[1].title), J(t.cards.map((c) => c.title)));
  }

  // ---- checkpoint and restore (Word)
  {
    const r = rig();
    const s1 = await r.word.run({ action: 'checkpoint', name: 'before toc' }, r.ctx);
    const file = r.of('checkpoint')[0].file;
    check('checkpoint: no card, the helper writes into Lumen\'s own folder, the answer names it', r.cards.length === 0 && path.dirname(file) === r.dir && /\.xml$/.test(file) && fs.existsSync(file) && /Saved checkpoint “before toc” of Report\.docx \(40 paragraphs, 14:05\)/.test(s1), s1);
    await r.word.run({ action: 'checkpoint' }, r.ctx);
    check('checkpoint list: newest last, with their times', /Checkpoints of Report\.docx \(newest last\): “before toc” at 14:05 \(40 paragraphs\); “checkpoint 2” at 14:05/.test(await r.word.run({ action: 'checkpoint', list: true }, r.ctx)));
    const said = await r.word.run({ action: 'restore', name: 'before toc' }, r.ctx);
    const loss = r.cards.find((c) => c.kind === 'content-loss');
    const rs = r.of('restore')[0];
    check('restore: the remove card says the document is replaced, the current state is saved first, then the helper puts back the named copy with its page setup', loss && /put Report\.docx back as it was at checkpoint “before toc” \(14:05\)/.test(loss.title) && rs.file === file && J(rs.sections) === J([{ o: 0 }]) && r.of('checkpoint').length === 3 && /Restored Report\.docx to checkpoint “before toc” \(14:05\)\. What was there just before is checkpoint “before restore”/.test(said), said);
    check('restore: an unknown name lists what there is; no checkpoint at all says to make one', /has no checkpoint called “nope”\. It has: “before toc”/.test(await rejects(() => r.word.run({ action: 'restore', name: 'nope' }, r.ctx)) || '') && /has no checkpoint in this Lumen session/.test(await rejects(() => rig().word.run({ action: 'restore' }, rig().ctx)) || ''));
    const keep = rig();
    for (let i = 0; i < 12; i++) await keep.word.run({ action: 'checkpoint' }, keep.ctx);
    check('checkpoints: the last 10 per document are kept, older files removed', fs.readdirSync(keep.dir).length === 10 && !fs.existsSync(keep.of('checkpoint')[0].file), fs.readdirSync(keep.dir).length);
    const den = rig({ answers: [true, false] });
    await den.word.run({ action: 'checkpoint' }, den.ctx);
    check('restore: a No on the remove card restores nothing', /did not allow restoring/.test(await rejects(() => den.word.run({ action: 'restore' }, den.ctx)) || '') && den.of('restore').length === 0);
  }

  // ---- checkpoint and restore of a file Word does not have open
  {
    const f = path.join(tmp, 'Lab 3 (draft).docx');
    fs.writeFileSync(f, 'first version');
    const r = rig({ host: { list: async () => ({ docs: [] }) } });
    const s1 = await r.word.run({ action: 'checkpoint', path: f }, r.ctx);
    fs.writeFileSync(f, 'second version');
    const s2 = await r.word.run({ action: 'restore', path: f }, r.ctx);
    check('file checkpoint: a copy of the bytes; restore asks with the path, keeps the current file as a checkpoint, and puts the old bytes back', /Saved checkpoint “checkpoint 1” of Lab 3 \(draft\)\.docx \(a copy of the file/.test(s1) && fs.readFileSync(f, 'utf8') === 'first version' && r.cards.length === 1 && r.cards[0].args.includes(f) && /Restored Lab 3 \(draft\)\.docx to checkpoint “checkpoint 1”/.test(s2) && r.of('checkpoint').length === 0, `${s1} / ${s2}`);
    const docs = [];
    const both = rig({ host: { list: async () => ({ docs }) } });
    await both.word.run({ action: 'checkpoint', path: f }, both.ctx);
    docs.push({ ...DOC, name: 'Lab 3 (draft).docx', path: f });
    const mixed = await rejects(() => both.word.run({ action: 'restore' }, both.ctx));
    check('file checkpoint: a copy of the file is not put into the document Word has open (it says how it is restored)', /is a copy of the file on disk, so it is restored the same way: with path, while Word does not have the file open/.test(mixed || '') && both.of('restore').length === 0, mixed);
  }

  // ---- routing: Word-only actions and targets never silently fall back to the file route
  {
    const f = path.join(tmp, 'Plain.docx');
    fs.writeFileSync(f, 'x');
    const linux = createWord({ settings: { enabled: () => true }, platform: 'linux', card: { use() {}, changed: async () => {}, read: async () => {}, busy() {} } });
    const ctx = { signal: {}, tainted: () => false, once: { has: () => false, add: () => {} }, ask: async () => true };
    check('file route: inspect, delete, toc and fields say they need Word', /inspect works through Microsoft Word/.test(await rejects(() => linux.run({ action: 'inspect', path: f }, ctx)) || '') && /delete works through Microsoft Word/.test(await rejects(() => linux.run({ action: 'delete', path: f, para: 2 }, ctx)) || ''));
    check('file route: para, under and include_fields are refused rather than ignored (the edit would land somewhere else)', /para, to, under, include_fields and paragraph numbers need Microsoft Word/.test(await rejects(() => linux.run({ action: 'replace', path: f, find: 'a', replace: 'b', under: 'Intro' }, ctx)) || '') && /need Microsoft Word/.test(await rejects(() => linux.run({ action: 'format', path: f, page_break_before: [3] }, ctx)) || ''));
  }

  // ---- the helper's protocol and script
  {
    const sent = [];
    const h = createWordHost({ platform: 'win32', client: { call: async (cmd, args, o) => { sent.push([cmd, args, o.timeoutMs]); return {}; } } });
    for (const m of ['inspect', 'delete', 'toc', 'fields', 'checkpoint', 'restore']) await h[m]({ doc: 'R.docx' });
    check('com: each new action is one command with its arguments as data', J(sent.map((s) => s[0])) === J(['inspect', 'delete', 'toc', 'fields', 'checkpoint', 'restore']) && sent.every((s) => s[1].doc === 'R.docx'));
    const ps = read('src/word/host.ps1');
    check('script: still plain ASCII and no value run as code', !/[^\x00-\x7f]/.test(ps) && !/Invoke-Expression|\biex\b|-EncodedCommand|Start-Process/.test(ps));
    check('script: each command is dispatched', ['inspect', 'delete', 'toc', 'fields', 'checkpoint', 'restore'].every((c) => new RegExp(`'${c}' \\{ return Cmd-`).test(ps)));
    check('script: find walks forward from its last match (a match Word hands back again inside a field cannot loop), within the scope, leaving the table of contents and fields out', /if \(\$rs -lt \$pos\) \{ \$pos\+\+; continue \}/.test(ps) && /\$pos = \[Math\]::Max\(\$re, \$pos \+ 1\)/.test(ps) && /if \(\$skip -and \(In-Spans \$rs \$re \$skip\)\) \{ \$script:skipped\+\+ \}/.test(ps) && /\[int\]\$f\.Type -eq 88\) \{ continue \}/.test(ps));
    check('script: heading paths look inside the section of the heading before, never in the table of contents', /function Under-Span/.test(ps) && /if \(In-Spans \$row\.s \$row\.e \$toc\) \{ continue \}/.test(ps) && /\[int\]\$rows\[\$k\]\.lv -le \$hl/.test(ps));
    check('script: inspect reads Word\'s own formatting (style, Font, ParagraphFormat, page via Information, sections\' PageSetup)', /\$p\.Style\.NameLocal/.test(ps) && /\$pf\.SpaceBefore/.test(ps) && /Information\(3\)/.test(ps) && /PageSetup\.SectionStart/.test(ps));
    check('script: delete keeps a table whole, never every paragraph, and unlocks a locked control only for the change', /start or end inside a table, so nothing was deleted/.test(ps) && /That is every paragraph of the document, so nothing was deleted/.test(ps) && /\$cc = Unlock-Around \$gone[\s\S]{0,400}finally \{ Relock \$cc \}/.test(ps));
    check('script: rebuild keeps the table of contents (its place, title and block) and never deletes it first', /function Cmd-Toc[\s\S]*?\$toc\.LowerHeadingLevel = \$lo[\s\S]*?\$toc\.Update\(\)/.test(ps) && !/TablesOfContents\.Item\(1\)\.Delete|\$old\.Delete/.test(ps));
    check('script: unlink uses Word\'s own Field.Unlink; update uses Fields.Update and each TOC\'s Update; content controls through LockContents', /\$f\.Unlink\(\)/.test(ps) && /\$d\.Fields\.Update\(\)/.test(ps) && /\$c\.LockContents = \$false/.test(ps));
    check('script: checkpoints are WordOpenXML in the file Lumen names, restored with InsertXML (tracking off for it, back after), each section\'s page setup set again', /\$d\.WordOpenXML/.test(ps) && /\$d\.Content\.InsertXML\(\$xml\)/.test(ps) && /\$d\.TrackRevisions = \$false[\s\S]{0,600}finally \{ \$d\.TrackRevisions = \$track \}/.test(ps) && /Set-PageSetup \$s\.PageSetup/.test(ps));
    check('script: format\'s page breaks no longer clobber the paragraph list (they had the same variable: page_break_before failed in Word)', /\$marks = @\(\); foreach \(\$b in \$breaks\)/.test(ps) && !/\$targets = @\(\); foreach \(\$b in \$breaks\)/.test(ps));
  }

  // ---- the agent's tool
  {
    const { requestFor, DEFAULT_MODEL } = require('../../src/ai/agent');
    const msgs = Object.assign([{ role: 'user', content: 'hi' }], { settings: { model: DEFAULT_MODEL } });
    const def = requestFor(msgs.settings, msgs, undefined, { word: true }).tools.find((t) => t.name === 'word');
    check('tool: the new actions are listed, with para, to and under', ['inspect', 'delete', 'toc', 'fields', 'checkpoint', 'restore'].every((a) => def.input_schema.properties.action.enum.includes(a)) && ['para', 'to', 'under'].every((k) => def.input_schema.properties[k]) && /inspect/.test(def.description) && /under/.test(def.description));
  }

  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nAll checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
