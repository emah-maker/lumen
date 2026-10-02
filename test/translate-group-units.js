// On-device translation sends whole sentences, not one request per text node: the nodes of a block are
// joined with numbered markers (" ⟦1⟧ "), and the reply is cut at the markers again (features/translate.js).
// Plain Node: the page script (PAGE_SRC) runs against a small fake DOM through a fake tab.
const vm = require('vm');
const T = require('../src/features/translate');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const M = (n) => T.seamOf(n); // " ⟦n⟧ "
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = / ⟦\d+⟧ /g;

// ---- a tiny DOM ----
const INLINE = new Set(['B', 'A', 'I', 'EM', 'STRONG', 'SPAN', 'CODE', 'U', 'SMALL', 'TIME', 'BR', 'WBR']);
function el(tag, children = [], attrs = {}) {
  const node = { tagName: tag.toUpperCase(), nodeType: 1, children, parentElement: null, previousSibling: null, attrs, isContentEditable: false, classList: { contains: (c) => String(attrs.class || '').split(/\s+/).includes(c) },
    getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs, getBoundingClientRect: () => (attrs.offscreen || (node.parentElement && node.parentElement.attrs.offscreen) ? { width: 10, height: 10, top: 5000, bottom: 5010, left: 0, right: 10 } : { width: 10, height: 10, top: 10, bottom: 20, left: 0, right: 10 }) };
  children.forEach((c, i) => { c.parentElement = node; c.previousSibling = children[i - 1] || null; });
  return node;
}
const text = (data) => ({ nodeType: 3, data, parentElement: null, previousSibling: null, isConnected: true });
function makeDom(blocks) {
  const body = el('body', blocks);
  const nodes = [];
  (function walk(n) { for (const c of n.children) { if (c.nodeType === 3) nodes.push(c); else walk(c); } })(body);
  body.innerText = 'Bonjour le monde, ceci est une page écrite en français pour les tests.';
  const document = { body, title: 'Titre', documentElement: { lang: 'fr' }, createTreeWalker: () => { let i = -1; return { nextNode: () => nodes[++i] || null }; } };
  return { document, nodes };
}
function fakeTab(dom) {
  const ctx = vm.createContext({
    document: dom.document, NodeFilter: { SHOW_TEXT: 4 }, innerWidth: 1000, innerHeight: 800, Date, JSON, Map, WeakMap, WeakSet, Promise,
    getComputedStyle: (e) => ({ display: INLINE.has(e.tagName) ? 'inline' : 'block' }),
    MutationObserver: class { observe() {} disconnect() {} },
  });
  ctx.globalThis = ctx;
  const wc = {
    isDestroyed: () => false, getURL: () => 'https://example.test/page', getTitle: () => '', session: { isPersistent: () => true },
    executeJavaScriptInIsolatedWorld: async (_w, [{ code }]) => vm.runInContext(code, ctx),
    on() {}, once() {},
  };
  return { view: { webContents: wc } };
}

// A fake on-device engine. mode: 'keep' (upper-case each part, markers intact), 'drop' (markers lost), 'extra' (an invented
// marker), 'swap' (parts reversed, markers in order: a legitimate reorder), 'lose-one' (one marker lost), 'garble' (markers
// turned into private-use junk), or a function (text) -> reply for full control.
function fakeLocal(mode, log, hooks = {}) {
  return {
    supports: () => true,
    plan: async () => ({ route: [['fr', 'en']], missing: 0, total: 0 }),
    warm: async () => {},
    ensure: async () => {},
    translate: async (_route, texts) => {
      log.push([...texts]);
      hooks.onRequest?.(texts);
      return texts.map((t) => {
        if (typeof mode === 'function') return mode(t);
        const marks = t.match(MARK);
        if (!marks) return t.toUpperCase();
        const parts = t.split(MARK).map((p) => p.toUpperCase());
        const joinWith = (list) => parts.reduce((out, p, i) => out + (i ? list[i - 1] : '') + p, '');
        if (mode === 'drop') return parts.join(' ');
        if (mode === 'extra') return `${joinWith(marks)} ⟦9⟧ `;
        if (mode === 'lose-one') return [parts[0] + ' ' + parts[1], ...parts.slice(2)].reduce((out, p, i) => out + (i ? marks[i] : '') + p, '');
        if (mode === 'garble') return parts.join('');
        if (mode === 'swap') return [...parts].reverse().reduce((out, p, i) => out + (i ? marks[i - 1] : '') + p, '');
        return joinWith(marks);
      });
    },
  };
}
const newTr = (local, settings = {}, extra = {}) => T.createTranslate({ readSettings: () => settings, writeSettings() {}, t: (k) => k, uiLocale: () => 'en', engine: () => null, aiAllowed: () => true, sendTabs() {}, popupMenu() {}, openUrl() {}, local, ...extra });

async function run(blocks, mode, { local = null, settings = {}, tr = null, hooks = {}, after = null, via = 'local', extra = {} } = {}) {
  const dom = makeDom(blocks);
  const tab = fakeTab(dom);
  const log = [];
  const engine = fakeLocal(mode, log, hooks);
  const api = tr || newTr(local ? local(engine) : engine, settings, extra);
  api.start(tab, { want: via });
  for (let i = 0; i < 150 && !api.isTranslated(tab) && api.stateOf(tab)?.phase !== 'error'; i++) await sleep(20);
  const state = api.stateOf(tab);
  const snap = dom.nodes.map((n) => n.data); // what the page showed when the run finished
  const afterResult = after ? await after(tab.view.webContents, dom) : null;
  api.act(tab, 'original');
  return { dom, log, state, snap, flat: log.flat(), extra: afterResult, api };
}
const withSeams = (log) => log.flat().filter((t) => /⟦/.test(t));

(async () => {
  // ---- pure helpers ----
  const items = [
    { id: 1, text: 'A', v: false, g: 1, l: false, t: true }, { id: 2, text: 'quick', v: true, g: 1, l: false, t: true }, { id: 3, text: 'brown', v: false, g: 1, l: false, t: false },
    { id: 4, text: 'Other', v: false, g: 2, l: false, t: false }, { id: 0, text: 'Title', v: true },
  ];
  const grouped = T.groupItems(items);
  check('group: nodes of one block become one segment, other blocks and the title stay alone', grouped.length === 3 && grouped[0].nodes.length === 3 && grouped[0].id === 1 && grouped[1].id === 4 && grouped[2].id === 0, JSON.stringify(grouped));
  check('group: numbered markers stand between the nodes, and the segment is visible if any node is', grouped[0].text === `A${M(1)}quick${M(2)}brown` && grouped[0].v === true, JSON.stringify(grouped[0].text));
  check('group: a lone node is passed through untouched', grouped[1] === items[3], '');
  check('group: a very long block is cut into several segments', T.groupItems(Array.from({ length: 10 }, (_v, i) => ({ id: i + 1, text: 'x'.repeat(300), g: 1 }))).length > 1, '');
  const withOwn = T.groupItems([{ id: 1, text: 'Use ⟦1⟧ for', g: 1 }, { id: 2, text: 'quotes', g: 1 }, { id: 3, text: 'fine', g: 2 }, { id: 4, text: 'also', g: 2 }]);
  check('group: a block whose own text holds a marker is not grouped (no doomed double request); other blocks still are', withOwn.length === 3 && !withOwn[0].nodes && !withOwn[1].nodes && withOwn[2].nodes?.length === 2, JSON.stringify(withOwn));
  const seg = grouped[0];
  const cut = T.splitSegment(seg, `UN${M(1)}RAPIDE${M(2)}BRUN`);
  check('split: a reply with the same markers is cut back into nodes (tagged with the segment)', JSON.stringify(cut) === '[[1,"UN",1],[2,"RAPIDE",1],[3,"BRUN",1]]', JSON.stringify(cut));
  check('split: tolerant of the engine\'s spacing around a marker', T.splitSegment(seg, 'UN⟦1⟧RAPIDE   ⟦2⟧ BRUN')?.length === 3 && T.splitSegment(seg, 'UN  ⟦1⟧  RAPIDE ⟦2⟧BRUN')?.length === 3, '');
  check('split: dropped, extra, repeated, reordered, renumbered or garbled markers are refused',
    T.splitSegment(seg, 'UN RAPIDE BRUN') === null && T.splitSegment(seg, `UN${M(1)}RAPIDE${M(2)}BRUN${M(3)}`) === null && T.splitSegment(seg, `UN RAPIDE${M(2)}BRUN`) === null
    && T.splitSegment(seg, `UN${M(2)}RAPIDE${M(1)}BRUN`) === null && T.splitSegment(seg, `UN${M(1)}${M(1)}BRUN`) === null && T.splitSegment(seg, `UN ⟦1 RAPIDE ⟦2⟧ BRUN`) === null && T.splitSegment(seg, 'UNRAPIDEBRUN') === null, '');
  check('split: an empty part is accepted (the engine moved that node words into a neighbour) as long as the markers are all there', T.splitSegment(seg, `UN RAPIDE${M(1)}${M(2)}BRUN`)?.length === 3, '');
  // CJK -> spaced language: the page had nothing between the nodes, so the words must not be glued
  const cjk = T.groupItems([{ id: 1, text: '私は', g: 1, l: false, t: false }, { id: 2, text: '猫', g: 1, l: false, t: false }, { id: 3, text: 'が好きです', g: 1, l: false, t: false }])[0];
  const glued = T.splitSegment(cjk, `I${M(1)}like${M(2)}cats`);
  check('CJK source: words that the page did not separate get a space in a spaced target', glued.map((p) => p[1]).join('') === 'I like cats', JSON.stringify(glued));
  const latin = T.groupItems([{ id: 1, text: 'un', g: 1, l: false, t: false }, { id: 2, text: 'able', g: 1, l: false, t: false }])[0];
  check('Latin source mid-word: no space is invented', T.splitSegment(latin, `un${M(1)}able`).map((p) => p[1]).join('') === 'unable', '');
  const spaced = T.groupItems([{ id: 1, text: '私は', g: 1, l: false, t: true }, { id: 2, text: '猫', g: 1, l: false, t: false }])[0];
  check('CJK source: where the page had a space, nothing extra is added', T.splitSegment(spaced, `I${M(1)}cats`).map((p) => p[1]).join('') === 'Icats', '');
  const zhToJa = T.groupItems([{ id: 1, text: '我', g: 1, l: false, t: false }, { id: 2, text: '猫', g: 1, l: false, t: false }])[0];
  check('CJK to CJK: no space is added', T.splitSegment(zhToJa, `私${M(1)}猫`).map((p) => p[1]).join('') === '私猫', '');

  // ---- through the page script and the run ----
  {
    const { dom, log, state, flat, snap } = await run([
      el('p', [text('A '), el('b', [text('quick')]), text(' brown '), el('a', [text('fox')]), text(' jumps.')]),
    ], 'keep');
    check('inline markup: A <b>quick</b> brown <a>fox</a> jumps. goes as one sentence in one request', state.phase === 'done' && log.length === 1 && flat.length === 1 && flat[0] === `A${M(1)}quick${M(2)}brown${M(3)}fox${M(4)}jumps.`, JSON.stringify(log));
    check('inline markup: each node gets its own part back, its spaces kept', snap.join('') === 'A QUICK BROWN FOX JUMPS.' && dom.nodes.length === 5, snap.join('|'));
  }
  {
    const { snap, flat } = await run([
      el('p', [text('Hello '), el('b', [text('world')])]),
      el('ul', [el('li', [text('First '), el('i', [text('item')])]), el('li', [text('Second')])]),
    ], 'keep');
    check('blocks: each p / li is its own sentence', flat.filter((t) => /⟦/.test(t)).length === 2 && flat.includes('Second'), JSON.stringify(flat));
    check('blocks: text of other blocks never mixes', snap.join('') === 'HELLO WORLDFIRST ITEMSECOND', snap.join('|'));
  }
  {
    const { dom, flat } = await run([
      el('p', [text('Use '), el('code', [text('npm install')]), text(' now')]),
      el('p', [text('Name '), el('textarea', [text('draft text')]), text(' please'), el('span', [text('skip me')], { translate: 'no' }), text(' tail')]),
    ], 'keep');
    const code = dom.nodes.find((n) => n.data === 'npm install');
    const area = dom.nodes.find((n) => n.data === 'draft text');
    const skip = dom.nodes.find((n) => n.data === 'skip me');
    check('excluded: code, textarea and translate=no text are never sent and never changed', code && area && skip && !flat.some((t) => /npm install|draft text|skip me/.test(t)), JSON.stringify(flat));
    check('excluded: they also break the sentence (no marker stands in for them)', flat.includes('Use') && flat.includes('now') && flat.includes('Name') && !flat.some((t) => /Use .*now/.test(t)), JSON.stringify(flat));
  }
  {
    const { flat, snap } = await run([el('p', [el('a', [text('Home')]), text(' '), el('a', [text('About')]), text(' '), el('a', [text('Contact')])])], 'keep');
    check('whitespace-only node between inline elements: the links are one segment', flat.length === 1 && flat[0] === `Home${M(1)}About${M(2)}Contact`, JSON.stringify(flat));
    check('whitespace-only node: the space stays where the page had it', snap.join('|') === 'HOME| |ABOUT| |CONTACT', snap.join('|'));
  }
  {
    const { flat } = await run([el('p', [text('Line one '), el('br', []), text('Line two '), el('b', [text('bold')])])], 'keep');
    check('<br> ends a group: text on either side of a line break is not one sentence', flat.includes('Line one') && flat.some((t) => t === `Line two${M(1)}bold`) && !flat.some((t) => /Line one.*⟦/.test(t)), JSON.stringify(flat));
    const wbr = await run([el('p', [text('super'), el('wbr', []), text('califragilistic'), el('b', [text(' word')])])], 'keep');
    check('<wbr> is only a break opportunity: it does not split a word\'s pieces apart', wbr.flat.length === 1 && /⟦1⟧/.test(wbr.flat[0]), JSON.stringify(wbr.flat));
  }
  for (const mode of ['drop', 'extra', 'lose-one', 'garble']) {
    const { log, state, snap } = await run([el('p', [text('A '), el('b', [text('quick')]), text(' brown')])], mode);
    const perNode = log.slice(1).flat();
    check(`fallback (${mode}): a reply with broken markers is not used; the nodes are translated one by one instead`, state.phase === 'done' && /⟦/.test(log[0]?.[0] || '') && ['A', 'quick', 'brown'].every((w) => perNode.includes(w)) && snap.map((d) => d.trim()).join('|') === 'A|QUICK|BROWN', `${JSON.stringify(log)} ${snap}`);
  }
  {
    const { snap, state } = await run([el('p', [text('one '), el('b', [text('two')])])], 'swap');
    check('reorder: a reply that moves the words but keeps every marker in order is applied', state.phase === 'done' && snap.map((d) => d.trim()).join('|') === 'TWO|ONE', snap);
  }
  {
    const { log } = await run([
      el('p', [text('far below '), el('b', [text('the fold')])], { offscreen: true }),
      el('p', [text('on '), el('b', [text('screen')])]),
    ], 'keep');
    check('order: what is on screen is sent first, whole sentences', log[0] && log[0][0].startsWith('on ') && log[0][0].includes('screen'), JSON.stringify(log));
  }
  {
    const { log } = await run([el('p', [text('Alpha '), el('b', [text('beta')])]), el('p', [text('Gamma')])], 'keep');
    const first = log[0] || [];
    check('first chunk: the small first request still holds whole segments', first.length >= 1 && first.every((t) => !/⟦\d+⟧\s*$/.test(t) && !/^\s*⟦/.test(t)), JSON.stringify(log));
  }

  // ---- a page that changes under us: a segment is applied whole or not at all ----
  {
    const dom = makeDom([el('p', [text('A '), el('b', [text('quick')]), text(' brown')])]);
    const tab = fakeTab(dom);
    const log = [];
    const engine = fakeLocal('keep', log, { onRequest: () => { dom.nodes[1].data = 'quick (edited by the page)'; } });
    const api = newTr(engine);
    api.start(tab, { want: 'local' });
    for (let i = 0; i < 150 && !api.isTranslated(tab) && api.stateOf(tab)?.phase !== 'error'; i++) await sleep(20);
    const data = dom.nodes.map((n) => n.data);
    check('changed mid-run: when one node of a segment changed, none of its pieces is applied (no half-translated sentence)', data[0] === 'A ' && data[1] === 'quick (edited by the page)' && data[2] === ' brown', data.join('|'));
    const again = await tab.view.webContents.executeJavaScriptInIsolatedWorld(1010, [{ code: `${T.PAGE_SRC}\n;__lumenTr.collect(250000)` }]);
    check('changed mid-run: the skipped nodes are collected again for the next pass, not lost', again.items.length === 3, JSON.stringify(again.items));
    api.act(tab, 'original');
  }

  // ---- budgets and the kill switch ----
  {
    // one chunk: a segment whose markers always fail, and a plain node the engine always answers with nothing
    const { log } = await run([el('p', [text('A '), el('b', [text('quick')]), text(' brown')]), el('p', [text('Alpha')])], (t) => (t === 'Alpha' ? '' : t.replace(MARK, ' ').toUpperCase()));
    const alphaRequests = log.flat().filter((t) => t === 'Alpha').length;
    check('budget: a plain node gets its own 2 requests, even when a segment in its chunk needs a third round', alphaRequests === 2, `${alphaRequests} ${JSON.stringify(log)}`);
  }
  {
    // many blocks, the engine always drops the markers: after SEAM_FAILS bad segments in a row the rest goes node by node
    const blocks = Array.from({ length: 10 }, (_v, i) => el('p', [text(`Sentence number ${i} is long enough ${'x'.repeat(380)} `), el('b', [text(`bold ${i}`)])]));
    const r1 = await run(blocks, 'drop');
    const grouped1 = withSeams(r1.log).length;
    check(`kill switch: after ${T.SEAM_FAILS} failed segments in a row the run stops grouping (${grouped1} of 10 segments were ever tried)`, grouped1 >= T.SEAM_FAILS && grouped1 < 10 && r1.state.phase === 'done', `${grouped1} ${r1.state.phase}`);
    const requests1 = r1.log.length;
    check('kill switch: every node still ends up translated', r1.snap.every((d) => d === d.toUpperCase() || d.trim() === ''), r1.snap.slice(0, 3));
    // the same pair in a later run of the same session: grouping is off from the start
    const r2 = await run(blocks, 'drop', { tr: r1.api });
    check('kill switch: the language pair is remembered for the session (no markers sent at all next time)', withSeams(r2.log).length === 0 && r2.state.phase === 'done', `${withSeams(r2.log).length}`);
    check('kill switch: a bad engine costs a bounded number of requests', requests1 <= 2 + Math.ceil(10 / 2) + 2 && r2.log.length <= requests1, `${requests1} ${r2.log.length}`);
  }
  {
    // one good segment between failures resets the streak
    const blocks = [0, 1, 2, 3, 4, 5].map((i) => el('p', [text(`Sentence ${i} ${'y'.repeat(700)} `), el('b', [text(`bold ${i}`)])]));
    let n = 0;
    const flaky = (t) => { if (!/⟦/.test(t)) return t.toUpperCase(); n++; return n % 3 === 0 ? t.toUpperCase() : t.replace(MARK, ' ').toUpperCase(); };
    const r = await run(blocks, flaky);
    check('kill switch: a segment that works resets the count (a mostly fine engine keeps grouping)', withSeams(r.log).length >= 6, `${withSeams(r.log).length}`);
  }

  // ---- numbers, prices, dates and percentages inside a sentence ----
  {
    const r = await run([
      el('p', [text('Showing '), el('b', [text('10')]), text(' of '), el('b', [text('200')]), text(' results')]),
      el('p', [text('Posted '), el('span', [text('5')]), text(' days ago')]),
      el('p', [text('Total: '), el('b', [text('$5.99')]), text(' with tax')]),
      el('p', [text('Updated '), el('time', [text('2024-05-01')]), text(' by Ann')]),
      el('p', [el('b', [text('45%')]), text(' off today')]),
    ], 'keep');
    check('numbers: "Showing 10 of 200 results" is one sentence with its numbers inside', r.flat.includes(`Showing${M(1)}10${M(2)}of${M(3)}200${M(4)}results`), JSON.stringify(r.flat));
    check('numbers: counts, prices, dates and percentages all travel with their sentence', r.flat.includes(`Posted${M(1)}5${M(2)}days ago`) && r.flat.includes(`Total:${M(1)}$5.99${M(2)}with tax`) && r.flat.includes(`Updated${M(1)}2024-05-01${M(2)}by Ann`) && r.flat.includes(`45%${M(1)}off today`), JSON.stringify(r.flat));
    check('numbers: the translated page keeps every number where it was, in one request', r.snap.join('') === 'SHOWING 10 OF 200 RESULTSPOSTED 5 DAYS AGOTOTAL: $5.99 WITH TAXUPDATED 2024-05-01 BY ANN45% OFF TODAY' && r.log.length === 1, r.snap.join('|'));
    const bare = await run([el('table', [el('tr', [el('td', [text('10')]), el('td', [text('$4.50')])])])], 'keep');
    check('numbers: a number or price on its own is not sent at all', bare.log.length === 0 && bare.state.phase === 'done', JSON.stringify(bare.log));
    const kept = T.groupItems([{ id: 1, text: 'Posted', g: 1, l: false, t: true }, { id: 2, text: '5', g: 1, n: true, l: false, t: true }, { id: 3, text: 'days ago', g: 1, l: false, t: false }])[0];
    const cutN = T.splitSegment(kept, `Il y a${M(1)}${M(2)}5 jours`);
    check('numbers: a bare number whose part comes back empty is left as written', cutN && cutN.length === 2 && !cutN.some(([id]) => id === 2), JSON.stringify(cutN));
    const sent = [];
    const ai = { id: 'x', label: 'X', run: async (_sys, user) => { const list = JSON.parse(user).items; sent.push(...list.map((i) => i.text)); return { items: list.map((i) => ({ id: i.id, text: i.text.toUpperCase() })) }; } };
    const aiRun = await run([el('p', [text('Showing '), el('b', [text('10')]), text(' results')])], 'keep', { via: 'ai', settings: { translateConsent: ['x'] }, extra: { engine: () => ai } });
    check('numbers: with the AI engine the bare number is not sent (as before)', sent.length > 0 && !sent.includes('10') && sent.includes('Showing'), JSON.stringify([sent, aiRun.state]));
  }

  // ---- the marker's number in other digits ----
  {
    const two = T.groupItems([{ id: 1, text: 'a', g: 1 }, { id: 2, text: 'b', g: 1 }, { id: 3, text: 'c', g: 1 }])[0];
    check('digits: Arabic-Indic, Extended, Devanagari and full-width numbers in a marker are read as 1, 2', ['٠١٢٣٤٥٦٧٨٩', '۰۱۲۳۴۵۶۷۸۹', '०१२३४५६७८९', '０１２３４５６７８９'].every((d) => T.splitSegment(two, `x ⟦${d[1]}⟧ y ⟦${d[2]}⟧ z`)?.length === 3), '');
    check('digits: but in the wrong order they are still refused', T.splitSegment(two, 'x ⟦٢⟧ y ⟦١⟧ z') === null && T.splitSegment(two, 'x ⟦١٢⟧ y ⟦٢⟧ z') === null, '');
  }

  // ---- bounds, and words landing next to the wrong element ----
  {
    const many = T.groupItems(Array.from({ length: 30 }, (_v, i) => ({ id: i + 1, text: `w${i}`, g: 1, l: true, t: true })));
    check(`cap: a block with 30 nodes is cut into segments of at most ${T.MAX_NODES} nodes`, many.length >= 3 && many.every((x) => !x.nodes || x.nodes.length <= T.MAX_NODES) && many.reduce((n, x) => n + (x.nodes ? x.nodes.length : 1), 0) === 30, JSON.stringify(many.map((x) => x.nodes?.length)));
    const sw = await run([el('p', [text('one '), el('b', [text('two')]), text(' three')])], 'swap');
    check('limit: when the engine moves words across a marker the text is still complete (the styling may sit on a neighbouring word)', sw.state.phase === 'done' && sw.snap.join(' ').split(/\s+/).filter(Boolean).sort().join() === 'ONE,THREE,TWO', sw.snap.join('|'));
  }

  // ---- the kill switch lets go again ----
  {
    let clock = 1000;
    const mode = { current: 'drop' };
    const log = [];
    const engine = fakeLocal((t) => {
      const marks = t.match(MARK);
      if (!marks) return t.toUpperCase();
      const parts = t.split(MARK).map((p) => p.toUpperCase());
      return mode.current === 'drop' ? parts.join(' ') : parts.reduce((o, p, i) => o + (i ? marks[i - 1] : '') + p, '');
    }, log);
    const api = newTr(engine, {}, { now: () => clock });
    const blocks = () => [0, 1, 2, 3, 4].map((i) => el('p', [text(`Sentence ${i} ${'z'.repeat(60)} `), el('b', [text(`bold ${i}`)])]));
    const count = () => withSeams(log).length;
    await run(blocks(), 'x', { tr: api });
    const first = count();
    check('decay: three bad segments in a row pause grouping for the pair', first >= T.SEAM_FAILS, first);
    log.length = 0;
    clock += 60 * 1000;
    await run(blocks(), 'x', { tr: api });
    check('decay: during the pause no markers are sent', count() === 0, count());
    log.length = 0;
    clock += T.SEAM_PAUSE_MS;
    await run(blocks(), 'x', { tr: api });
    check('decay: after the pause the next run probes with grouping again, and one failure pauses the pair again', count() >= 1 && count() <= first, `${count()} ${first}`);
    log.length = 0;
    clock += T.SEAM_PAUSE_MS + 1000; // the second pause is twice as long
    await run(blocks(), 'x', { tr: api });
    check('decay: the second pause lasts longer than the first', count() === 0, count());
    log.length = 0;
    clock += T.SEAM_PAUSE_MS * 2;
    mode.current = 'keep';
    await run(blocks(), 'x', { tr: api });
    const good = count();
    log.length = 0;
    api.clearCache(); // otherwise the second run is answered from the first run's translations
    await run(blocks(), 'x', { tr: api });
    check('decay: when the probe works the pair is grouped again, and stays so', good > 0 && count() > 0, `${good} ${count()}`);
  }

  // ---- a download that is stopped from elsewhere ----
  {
    let ensures = 0;
    const { state } = await run([el('p', [text('Hello '), el('b', [text('world')])])], 'keep', {
      settings: { translateLocalAuto: true },
      local: (base) => ({ ...base, plan: async () => ({ route: [['fr', 'en']], missing: 1000, total: 1000 }), ensure: async () => { ensures++; if (ensures === 1) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); } }),
    });
    check('download: a "cancelled" the run did not ask for is retried, and the page is translated', state.phase === 'done' && ensures === 2, `${state.phase} ${state.error} ensures=${ensures}`);
  }
  {
    const { state } = await run([el('p', [text('Hello '), el('b', [text('world')])])], 'keep', {
      settings: { translateLocalAuto: true },
      local: (base) => ({ ...base, plan: async () => ({ route: [['fr', 'en']], missing: 1000, total: 1000 }), ensure: async () => { throw Object.assign(new Error('The language pack was deleted.'), { code: 'removed' }); } }),
    });
    check('download: a pack deleted mid-download shows its own message, not "cancelled"', state.phase === 'error' && state.error === 'pack-removed', `${state.phase} ${state.error}`);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
