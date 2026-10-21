// Content guard (src/ai/content-guard.js), plain Node: the diff and thresholds, what counts as risky, the journal, the report,
// and guardTool / undoEdits against a simulated page (no window).
const G = require('../../src/ai/content-guard');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);

const snapOf = (text, extra = {}) => ({ region: 1, kind: 'field', chars: text.length, text, images: 0, tables: 0, equations: 0, items: 0, rows: 0, styled: 0, selChars: 0, selImages: 0, selTables: 0, ...extra });
const para = (n, ch = 'a') => `${ch.repeat(n)}`;

// ---- classify
check('classify: type_text', G.classify('type_text', { text: 'x' }) === 'type');
check('classify: run_script', G.classify('run_script', { code: '1' }) === 'script');
check('classify: Delete and Backspace keys', G.classify('press_key', { key: 'Delete' }) === 'key' && G.classify('press_key', { key: 'Backspace' }) === 'key');
check('classify: cut is a key risk, select-all is only noted', G.classify('press_key', { key: 'x', modifiers: ['control'] }) === 'key' && G.classify('press_key', { key: 'a', modifiers: ['meta'] }) === 'selectall');
check('classify: plain keys are not risky', G.classify('press_key', { key: 'Enter' }) === null && G.classify('press_key', { key: 'a' }) === null);
check('classify: a click on Delete / Remove / Clear / Discard / Empty trash', ['Delete', 'Remove item', 'Clear all', 'Discard draft', 'Empty trash'].every((l) => G.classify('click', {}, l) === 'click'));
check('classify: other clicks are not', G.classify('click', {}, 'Save') === null && G.classify('click', { text: 'Submit' }) === null);
check('classify: a click named by its text', G.classify('click', { text: 'Delete' }, '') === 'click');
check('classify: reading tools are not', G.classify('read_page', {}) === null);

// ---- scripts that wipe
check('scriptWipes: innerHTML, textContent, value, replaceChildren, document.write, execCommand', [
  'document.querySelector("#e").innerHTML = ""', 'el.textContent=""', 'ta.value = "x"', 'e.replaceChildren()', 'document.write("x")', 'document.execCommand("selectAll")',
].every(G.scriptWipes));
check('scriptWipes: reading is fine', !G.scriptWipes('return document.title') && !G.scriptWipes('return el.innerHTML') && !G.scriptWipes('if (a.value == 3) return 1'));

// ---- the diff
{
  const before = snapOf(para(1000, 'x') + '\n' + para(500, 'y'));
  const none = G.diffRegion(before, before);
  check('diff: nothing changed', none.lostChars === 0 && none.lostImages === 0);
  const wiped = G.diffRegion(before, snapOf(''));
  check('diff: a wipe loses everything', wiped.lostChars === 1500, J(wiped));
  const appended = G.diffRegion(before, snapOf(before.text + ' more'));
  check('diff: appending loses nothing', appended.lostChars === 0 && appended.addedChars === 5, J(appended));
  const small = G.diffRegion(before, snapOf(before.text.replace('xxxxx', 'zzzzz')));
  check('diff: a small edit loses 5 characters', small.lostChars === 5 && !G.exceeds(small, before).over, J(small));
  const moved = snapOf(para(500, 'y') + '\n' + para(1000, 'x'));
  check('diff: moved paragraphs are not a loss', G.diffRegion(before, moved).lostChars === 0, J(G.diffRegion(before, moved)));
  const imgs = G.diffRegion(snapOf('hi', { images: 3, tables: 1, equations: 2, items: 9, rows: 8, styled: 20 }), snapOf('hi', { images: 1, tables: 0, equations: 0, items: 3, rows: 2, styled: 2 }));
  check('diff: counts what disappeared', imgs.lostImages === 2 && imgs.lostTables === 1 && imgs.lostEquations === 2 && imgs.lostItems === 6 && imgs.lostRows === 6 && imgs.lostStyled === 18, J(imgs));
  const gained = G.diffRegion(snapOf('hi', { images: 1 }), snapOf('hi', { images: 4 }));
  check('diff: more images is not a loss', gained.lostImages === 0);
}

// ---- text the AI typed itself
{
  const typed = para(600, 't');
  const before = snapOf(typed);
  check('owned: replacing text the AI typed in this run is not a loss', G.diffRegion(before, snapOf('new'), [typed]).lostChars === 0);
  const mixed = snapOf(typed + para(400, 'u'));
  check('owned: its own text plus the user\'s counts only the user\'s', G.diffRegion(mixed, snapOf(''), [typed]).lostChars === 400, J(G.diffRegion(mixed, snapOf(''), [typed])));
  check('owned: without it, it is a loss', G.diffRegion(before, snapOf('new')).lostChars === 600);
}

// ---- thresholds
{
  const big = snapOf(para(2000));
  const t = (lost, extra = {}, size = 2000) => G.exceeds({ lostChars: lost, lostImages: 0, lostTables: 0, lostEquations: 0, lostItems: 0, lostRows: 0, lostStyled: 0, ...extra }, snapOf(para(size), extra.before));
  check('threshold: 299 characters of 2000 is fine', !t(299).over);
  check('threshold: 300 characters is over', t(300).over);
  check('threshold: a fifth of a 1000-character field is over', t(200, {}, 1000).over && !t(149, {}, 1000).over);
  check('threshold: a short field rewritten is fine (under the minimum)', !t(100, {}, 100).over);
  check('threshold: any image, table or equation', t(0, { lostImages: 1 }).over && t(0, { lostTables: 1 }).over && t(0, { lostEquations: 1 }).over);
  check('threshold: 5 list items or rows, not 4', t(0, { lostItems: 5 }).over && t(0, { lostRows: 5 }).over && !t(0, { lostItems: 4, lostRows: 4 }).over);
  check('threshold: most of the formatting', G.exceeds({ lostChars: 0, lostStyled: 10, lostImages: 0, lostTables: 0, lostEquations: 0, lostItems: 0, lostRows: 0 }, snapOf('x', { styled: 12 })).over);
  check('threshold: a little formatting is fine', !G.exceeds({ lostChars: 0, lostStyled: 3, lostImages: 0, lostTables: 0, lostEquations: 0, lostItems: 0, lostRows: 0 }, snapOf('x', { styled: 4 })).over);
  void big;
}

check('describe: a summary in words', G.describeLoss({ lostChars: 1200, lostImages: 3, lostTables: 1 }, { chars: 1500 }) === 'about 1,200 characters (80% of the text), 3 images and 1 table', G.describeLoss({ lostChars: 1200, lostImages: 3, lostTables: 1 }, { chars: 1500 }));

// ---- prediction
{
  const before = snapOf(para(800), { images: 2 });
  const type = G.predictLoss('type', { text: 'short' }, before);
  check('predict: typing replaces the whole field', type.lostChars === 800 && type.lostImages === 2 && G.exceeds(type, before).over, J(type));
  check('predict: typing the same text plus a word keeps the text but loses the images', G.predictLoss('type', { text: before.text + ' x' }, before).lostChars === 0 && G.predictLoss('type', { text: before.text }, before).lostImages === 2);
  check('predict: a plain Backspace is unknown', G.predictLoss('key', {}, before) === null);
  const key = G.predictLoss('key', {}, snapOf(para(800), { selChars: 800 }));
  check('predict: Delete over a select-all', key.lostChars === 800);
  check('predict: a wiping script', G.predictLoss('script', { code: 'e.innerHTML=""' }, before).lostChars === 800 && G.predictLoss('script', { code: 'return 1' }, before) === null);
}

// ---- a simulated page for guardTool / undoEdits
function page(initial, extra = {}) {
  const st = { text: initial, images: extra.images || 0, tables: extra.tables || 0, saves: new Map(), n: 0, undoStack: [], redoStack: [], kind: extra.kind || 'field' };
  const read = (more = {}) => ({ region: 1, kind: st.kind, chars: st.text.length, text: st.text, images: st.images, tables: st.tables, equations: 0, items: 0, rows: 0, styled: 0, selChars: 0, selImages: 0, selTables: 0, ...more });
  const tools = {
    st,
    snap: async (opts = {}) => {
      const out = read(extra.selAll ? { selChars: st.text.length } : {});
      if (opts.keep) { const id = ++st.n; st.saves.set(id, { text: st.text, images: st.images, tables: st.tables }); out.save = id; out.firstSave = st.first ??= id; }
      return out;
    },
    restore: async ({ save }) => { const s = st.saves.get(save); if (!s) return false; Object.assign(st, { text: s.text, images: s.images, tables: s.tables }); return true; },
    undo: async () => { const s = st.undoStack.pop(); if (s) { st.redoStack.push({ text: st.text, images: st.images, tables: st.tables }); Object.assign(st, s); } },
    redo: async () => { const s = st.redoStack.pop(); if (s) { st.undoStack.push({ text: st.text, images: st.images, tables: st.tables }); Object.assign(st, s); } },
    edit: (fn) => { st.undoStack.push({ text: st.text, images: st.images, tables: st.tables }); fn(st); },
  };
  return tools;
}
const ctxOf = (p, journal, answers = [], over = {}) => {
  const asked = [];
  return { asked, ctx: { journal, tabId: 1, site: 'example.com', id: 3, label: '', bypass: false, snap: p.snap, restore: p.restore, undo: p.undo, redo: p.redo, ask: async (card) => { asked.push(card); return answers.length ? answers.shift() : true; }, ...over } };
};

(async () => {
  const BIG = para(1500, 'q');

  { // select-all then type: card before acting
    const p = page(BIG);
    const j = G.createJournal('t1');
    const { ctx, asked } = ctxOf(p, j, [false]);
    let ran = false;
    let err = null;
    try { await G.guardTool(ctx, 'type_text', { element_id: 3, text: 'tiny' }, async () => { ran = true; p.edit((s) => { s.text = 'tiny'; }); return 'Typed.'; }); } catch (e) { err = e; }
    check('type over a big field: asks BEFORE acting', asked.length === 1 && asked[0].phase === 'before' && /1,500 characters/.test(asked[0].title), J(asked));
    check('type over a big field: "no" stops it, nothing ran', err && !ran && p.st.text === BIG, err?.message);
  }
  { // answered yes: runs, no second card
    const p = page(BIG);
    const j = G.createJournal('t2');
    const { ctx, asked } = ctxOf(p, j, [true]);
    const out = await G.guardTool(ctx, 'type_text', { element_id: 3, text: 'tiny' }, async () => { p.edit((s) => { s.text = 'tiny'; }); return 'Typed.'; });
    check('type over a big field: "yes" runs it with one card only', out === 'Typed.' && asked.length === 1 && p.st.text === 'tiny', J(asked));
  }
  { // a script wipe is caught, undone and carded
    const p = page(BIG, { images: 1 });
    const j = G.createJournal('t3');
    const { ctx, asked } = ctxOf(p, j, [true, false]); // allow the pre-card, refuse after? (pre-card only here)
    // a script the pre-check can't see (no assignment in the text): caught after
    const sneaky = { code: 'run(function(){ target()["inner"+"HTML"] = "" })' };
    ctx.ask = async (c) => { asked.push(c); return false; };
    let err = null;
    try { await G.guardTool(ctx, 'run_script', sneaky, async () => { p.edit((s) => { s.text = ''; s.images = 0; }); return 'ok'; }); } catch (e) { err = e; }
    check('script wipe: caught after the fact, put back, carded', asked.length === 1 && asked[0].phase === 'after' && asked[0].undone === true && p.st.text === BIG && p.st.images === 1, J({ asked, text: p.st.text.length, images: p.st.images }));
    check('script wipe: "undo it" tells the model not to retry', err && /undid that change/.test(err.message), err?.message);
  }
  { // keep the change
    const p = page(BIG);
    const j = G.createJournal('t4');
    const { ctx, asked } = ctxOf(p, j, [true]);
    const out = await G.guardTool(ctx, 'run_script', { code: 'x()' }, async () => { p.edit((s) => { s.text = ''; }); return 'ok'; });
    check('keep the change: it comes back as the tool left it, with a note', asked.length === 1 && p.st.text === '' && /chose to keep/.test(out), J({ asked, out }));
  }
  { // an image removed
    const p = page('short text', { images: 2, kind: 'rich' });
    const j = G.createJournal('t5');
    const { ctx, asked } = ctxOf(p, j, [false]);
    let err = null;
    try { await G.guardTool(ctx, 'click', {}, async () => { p.edit((s) => { s.images = 1; }); return 'Clicked.'; }); } catch (e) { err = e; }
    // (click without a dangerous label is not classified: use the label)
    check('click on an ordinary control is not guarded', err === null && asked.length === 0 && p.st.images === 1);
    const p2 = page('short text', { images: 2, kind: 'rich' });
    const c2 = ctxOf(p2, G.createJournal('t5b'), [false], { label: 'Delete image' });
    let err2 = null;
    try { await G.guardTool(c2.ctx, 'click', { element_id: 4 }, async () => { p2.edit((s) => { s.images = 1; }); return 'Clicked.'; }); } catch (e) { err2 = e; }
    check('removing an image is caught and put back', c2.asked.length === 1 && /1 image/.test(c2.asked[0].title) && p2.st.images === 2 && err2, J(c2.asked));
  }
  { // text the AI typed itself does not card
    const p = page('');
    const j = G.createJournal('t6');
    const { ctx, asked } = ctxOf(p, j);
    const typed1 = para(500, 'm');
    await G.guardTool(ctx, 'type_text', { element_id: 3, text: typed1 }, async () => { p.edit((s) => { s.text = typed1; }); return 'ok'; });
    await G.guardTool(ctx, 'type_text', { element_id: 3, text: para(500, 'n') }, async () => { p.edit((s) => { s.text = para(500, 'n'); }); return 'ok'; });
    await G.guardTool(ctx, 'run_script', { code: 'document.body.textContent = ""' }, async () => { p.edit((s) => { s.text = ''; }); return 'ok'; });
    check('its own typed text: replacing or removing it never cards', asked.length === 0, J(asked));
  }
  { // the run's edits added up
    const p = page(para(1000, 'w'));
    const j = G.createJournal('t7');
    const { ctx, asked } = ctxOf(p, j, [true]);
    for (let i = 0; i < 5; i++) await G.guardTool(ctx, 'press_key', { key: 'Backspace' }, async () => { p.edit((s) => { s.text = s.text.slice(0, -45); }); return 'ok'; });
    check('combined removals over the threshold card, single ones under it do not', asked.length === 1 && asked[0].phase === 'after', J(asked));
  }
  { // bypass: no undo, still asks (the step), journal kept
    const p = page(BIG);
    const j = G.createJournal('t8');
    const { ctx, asked } = ctxOf(p, j, [true], { bypass: true });
    const out = await G.guardTool(ctx, 'run_script', { code: 'x()' }, async () => { p.edit((s) => { s.text = ''; }); return 'ok'; });
    check('bypass: nothing is undone, the step is logged, the model is told', p.st.text === '' && asked.length === 1 && asked[0].undone === false && /bypass is on/.test(out), J({ asked, out }));
    check('bypass: the undo stays available', G.changedRegions(j).length === 1);
    const tabs = new Map([[1, { snap: p.snap, restore: p.restore, undo: p.undo, redo: p.redo, site: 'example.com' }]]);
    const r = await G.undoEdits(j, tabs);
    check('bypass: "Undo the AI\'s edits" brings it back', p.st.text === BIG && r.done.length === 1, J({ r, len: p.st.text.length }));
  }
  { // native undo is used for rich editors
    const p = page(BIG, { kind: 'rich' });
    const j = G.createJournal('t9');
    const { ctx } = ctxOf(p, j, [true], { bypass: true });
    await G.guardTool(ctx, 'type_text', { element_id: 3, text: para(1500, 'q') + ' ok' }, async () => { p.edit((s) => { s.text = `${BIG} ok`; }); return 'ok'; });
    await G.guardTool(ctx, 'press_key', { key: 'Backspace' }, async () => { p.edit((s) => { s.text = s.text.slice(0, -1); }); return 'ok'; });
    const tabs = new Map([[1, { snap: p.snap, restore: p.restore, undo: p.undo, redo: p.redo, site: 'docs.example' }]]);
    const r = await G.undoEdits(j, tabs);
    check('undo edits: replays native undo until the start state', p.st.text === BIG && r.done.length === 1, J({ r, text: p.st.text.length }));
  }
  { // can't restore: honest
    const p = page(BIG, { kind: 'rich' });
    const j = G.createJournal('t10');
    const { ctx } = ctxOf(p, j, [true], { bypass: true });
    await G.guardTool(ctx, 'run_script', { code: 'x()' }, async () => { p.edit((s) => { s.text = 'changed by a server'; }); return 'ok'; });
    const tabs = new Map([[1, { snap: p.snap, restore: async () => false, undo: async () => {}, redo: async () => {}, site: 'docs.example' }]]);
    const r = await G.undoEdits(j, tabs);
    check('undo edits: says so and points to version history when it cannot', r.done.length === 0 && /version history/.test(r.skipped[0]), J(r));
    const gone = await G.undoEdits(j, new Map());
    check('undo edits: a closed tab is skipped with the same pointer', /version history/.test(gone.skipped[0]), J(gone));
  }
  { // the report
    const p = page('hello world', { images: 2, tables: 1 });
    const j = G.createJournal('t11');
    const { ctx } = ctxOf(p, j);
    await G.guardTool(ctx, 'type_text', { element_id: 3, text: 'hello world!' }, async () => { p.edit((s) => { s.text = 'hello world!'; }); return 'ok'; });
    const cur = new Map([[`1:1`, await p.snap()]]);
    const report = G.verifyReport(j, cur, new Map([[1, 'example.com']]));
    check('verify: stats before and after', /example\.com \(text field\): text 11 → 12 characters, images 2 → 2, tables 1 → 1/.test(report) && /1 character added/.test(report), report);
    const noEdits = G.verifyReport(G.createJournal('x'), new Map());
    check('verify: nothing tracked says so', /nothing to compare/.test(noEdits));
    const lost = G.verifyReport(j, new Map([['1:1', null]]));
    check('verify: an unreadable region is not called unchanged', /Don't claim it is unchanged/.test(lost));
    const un = G.createJournal('u');
    un.unmeasured.push({ site: 'docs.google.com', count: 2, tools: ['type_text'] });
    check('verify: edits it could not measure are reported', /2 edits .* could not be measured/.test(G.verifyReport(un, new Map())));
  }
  { // nothing measurable: just runs, and is noted
    const j = G.createJournal('t12');
    const ctx = { journal: j, tabId: 1, site: 'docs.google.com', snap: async () => ({ none: true }), ask: async () => { throw new Error('no card'); } };
    const out = await G.guardTool(ctx, 'type_text', { text: 'x' }, async () => 'Typed.');
    check('no editable region: runs unguarded and is noted as unmeasured', out === 'Typed.' && j.unmeasured[0]?.count === 1);
  }
  { // a field typed into a few times, under the limit: journal has one region with the first snapshot
    const p = page('abc');
    const j = G.createJournal('t13');
    const { ctx, asked } = ctxOf(p, j);
    for (const text of ['abcd', 'abcde']) await G.guardTool(ctx, 'type_text', { element_id: 3, text }, async () => { p.edit((s) => { s.text = text; }); return 'ok'; });
    check('journal: one record per region, first snapshot kept, no cards', j.regions.size === 1 && j.regions.get('1:1').first.text === 'abc' && asked.length === 0);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
