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
    const flaky = (t) => { if (!/⟦/.test(t)) return t.toUpperCase(); n++; return n % 3 === 1 ? t.toUpperCase() : t.replace(MARK, ' ').toUpperCase(); };
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
    check('decay: bad segments in a row pause grouping for the pair (a pair that never worked trips one sooner)', first >= T.SEAM_FAILS - 1, first);
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

  // ---- the pause doubles each time (10, 20, 40, then 60 minutes at most) and clears when a probe works ----
  {
    let clock = 5000;
    const mode = { current: 'drop' };
    const log = [];
    const engine = fakeLocal((t) => {
      const marks = t.match(MARK);
      if (!marks) return t.toUpperCase();
      const parts = t.split(MARK).map((p) => p.toUpperCase());
      return mode.current === 'drop' ? parts.join(' ') : parts.reduce((o, p, i) => o + (i ? marks[i - 1] : '') + p, '');
    }, log);
    const api = newTr(engine, {}, { now: () => clock });
    const blocks = () => [0, 1, 2].map((i) => el('p', [text(`Backoff ${i} ${'q'.repeat(50)} `), el('b', [text(`bold ${i}`)])]));
    const grouping = async () => { log.length = 0; api.clearCache(); await run(blocks(), 'x', { tr: api }); return withSeams(log).length > 0; };
    const MIN = 60 * 1000;
    check('backoff: the first failures pause the pair (10 minutes)', (await grouping()) === true && (clock += 9 * MIN, (await grouping()) === false), '');
    clock += 1 * MIN + 1; // 10 minutes passed
    check('backoff: after 10 minutes one grouped run probes, and its failure pauses for 20', (await grouping()) === true, '');
    clock += 19 * MIN;
    check('backoff: still paused 19 minutes into the 20', (await grouping()) === false, '');
    clock += 1 * MIN + 1;
    check('backoff: probes again after 20, fails, and now pauses for 40', (await grouping()) === true, '');
    clock += 39 * MIN;
    check('backoff: still paused 39 minutes into the 40', (await grouping()) === false, '');
    clock += 1 * MIN + 1;
    check('backoff: probes again after 40, fails, and pauses for 60', (await grouping()) === true, '');
    clock += 59 * MIN;
    check('backoff: still paused 59 minutes into the 60', (await grouping()) === false, '');
    clock += 1 * MIN + 1;
    check('backoff: probes after 60, fails, and the pause stays at 60 (the cap), not 80', (await grouping()) === true, '');
    clock += 61 * MIN;
    mode.current = 'keep';
    check('backoff: after the cap it probes again; a probe that works clears the pause', (await grouping()) === true && (await grouping()) === true, '');
    mode.current = 'drop';
    clock += 1 * MIN;
    await grouping(); // a fresh failure after a success starts from 10 minutes again
    clock += 11 * MIN;
    check('backoff: a pair that worked and then failed starts again at 10 minutes', (await grouping()) === true, '');
  }

  // ---- bare numbers keep their digits ----
  {
    const segOf = (nums) => T.groupItems([{ id: 1, text: 'Showing', g: 1, l: false, t: true }, { id: 2, text: nums, g: 1, n: true, l: false, t: true }, { id: 3, text: 'results', g: 1, l: false, t: false }])[0];
    const ids = (cut) => (cut || []).map((p) => p[0]).join();
    const cases = [
      ['200', '٢٠٠', true, 'Arabic-Indic digits for the same number'],
      ['200', '۲۰۰', true, 'Persian digits for the same number'],
      ['200', '२००', true, 'Devanagari digits for the same number'],
      ['1,000.5', '1.000,5', true, 'a German separator style'],
      ['1,000.5', '١٬٠٠٠٫٥', true, 'Arabic separators and digits'],
      ['$5.99', '5,99 €', true, 'a price in the other style, other currency sign'],
      ['$5.99', '5.99 dollars', false, 'a currency word inside the number node (the number stays, the words are not written there)', 0],
      ['2024-05-01', '01/05/2024', false, 'a date reordered (benign: kept as written, counts for nothing)', 0],
      ['200', '٢٠٠٠', false, 'an extra digit'],
      ['200', '20', false, 'a dropped digit'],
      ['200', '300', false, 'a different number'],
      ['45%', '٪٤٥', true, 'a percentage with a percent sign moved'],
      ['1st', '1.', true, 'an ordinal mark (letters in the page: not a bare number)'],
    ];
    for (const [orig, reply, accepted, why, extra] of cases) {
      if (orig === '1st') continue; // has letters, so it is an ordinary node, covered elsewhere
      const cut = T.splitSegment(segOf(orig), `Showing${M(1)}${reply}${M(2)}results`);
      const kept = cut && !cut.some((p) => p[0] === 2);
      check(`numbers: ${why} (${orig} -> ${reply}) is ${accepted ? 'applied' : 'kept as written'}`, cut && (accepted ? ids(cut) === '1,2,3' : kept && cut.numberMismatches === (extra === undefined ? 1 : extra)), `${ids(cut)} ${cut?.numberMismatches}`);
    }
    check('numbers: the other words of the segment are still applied when a number is rejected', ids(T.splitSegment(segOf('200'), `Showing${M(1)}300${M(2)}results`)) === '1,3', '');
    // through a run: a locale-converting engine, then one that mangles digits
    const convert = (t) => {
      const marks = t.match(MARK);
      if (!marks) return t.toUpperCase();
      const parts = t.split(MARK).map((p) => (/^\d/.test(p) ? p.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]) : p.toUpperCase()));
      return parts.reduce((o, p, i) => o + (i ? marks[i - 1] : '') + p, '');
    };
    const conv = await run([el('p', [text('Showing '), el('b', [text('200')]), text(' results')])], convert);
    check('numbers: through a run, a number rewritten in the target\'s digits lands on the page', conv.state.phase === 'done' && conv.snap.join('') === 'SHOWING ٢٠٠ RESULTS', conv.snap.join('|'));
    const mangle = (t) => {
      const marks = t.match(MARK);
      if (!marks) return t.toUpperCase();
      const parts = t.split(MARK).map((p) => (/^\d/.test(p) ? `${p}0` : p.toUpperCase()));
      return parts.reduce((o, p, i) => o + (i ? marks[i - 1] : '') + p, '');
    };
    const bad = await run([el('p', [text('Showing '), el('b', [text('200')]), text(' results')])], mangle);
    check('numbers: through a run, a changed number never reaches the page (the rest is translated)', bad.state.phase === 'done' && bad.snap.join('') === 'SHOWING 200 RESULTS', bad.snap.join('|'));

    // after NUMBER_MISMATCHES such segments the pair's numbers are left out of its sentences
    let clock = 9000;
    const log = [];
    const api = newTr(fakeLocal(mangle, log), {}, { now: () => clock });
    const nums = () => [0, 1, 2, 3].map((i) => el('p', [text(`Count ${'abcd'[i]} is `), el('b', [text(`${100 + i}`)]), text(' items')]));
    await run(nums(), 'x', { tr: api });
    log.length = 0;
    api.clearCache();
    await run(nums(), 'x', { tr: api });
    const sent = log.flat();
    check('numbers: after repeated changed numbers the pair\'s numbers are left out of its sentences (nothing numeric is sent)', sent.length > 0 && !sent.some((t) => /\d/.test(t)) && !sent.some((t) => /⟦/.test(t)), JSON.stringify(sent));
    log.length = 0;
    api.clearCache();
    clock += T.SEAM_PAUSE_MS + 1;
    await run(nums(), 'x', { tr: api });
    check('numbers: and numbers come back into sentences once the pause is over', log.flat().some((t) => /\d/.test(t)), JSON.stringify(log.flat()));
  }

  // ---- a pair that has never worked starts with a small first request ----
  {
    const log = [];
    const engine = fakeLocal('drop', log);
    const blocks = Array.from({ length: 8 }, (_v, i) => el('p', [text(`Probe ${i} ${'w'.repeat(80)} `), el('b', [text(`bold ${i}`)])]));
    await run(blocks, 'x', { tr: newTr(engine) });
    const firstRequest = log[0] || [];
    check(`first request: with no history a pair's first request stays under ${T.LOCAL_PROBE_FIRST + 200} characters, so a bad engine costs one small request`, firstRequest.join('').length <= T.LOCAL_PROBE_FIRST + 200 && firstRequest.some((t) => /⟦/.test(t)), JSON.stringify(firstRequest.map((t) => t.length)));
  }

  // ---- numeric value, not just digits ----
  {
    const v = (a, b) => T.checkNumber(a, b);
    check('value: 1.5 -> 1,5 is the same number', v('1.5', '1,5') === 'ok' && v('1.5', '١٫٥') === 'ok', v('1.5', '1,5'));
    check('value: 1.5 -> 15 lost its decimal mark (corruption)', v('1.5', '15') === 'corrupt', v('1.5', '15'));
    check('value: 1,000 -> 1.000 is the same number (thousands in both)', v('1,000', '1.000') === 'ok' && v('1,000', '1 000') === 'ok' && v('1,000', '1’000') === 'ok', v('1,000', '1.000'));
    check('value: 1,000 -> 1,0 is a different number', v('1,000', '1,0') === 'corrupt', v('1,000', '1,0'));
    check('value: $5.99 -> 5,99 € is the same number; 5.99 -> 599 is not', v('$5.99', '5,99 €') === 'ok' && v('5.99', '599') === 'corrupt' && v('$5.99', '$599') === 'corrupt', '');
    check('value: 1,234,567.89 -> 1.234.567,89 and 1 234 567,89 are the same number', v('1,234,567.89', '1.234.567,89') === 'ok' && v('1,234,567.89', '1 234 567,89') === 'ok' && v('1,234,567.89', '1.234.567,8') === 'corrupt', '');
    check('value: percentages and plain integers', v('45%', '45 %') === 'ok' && v('45%', '٤٥٪') === 'ok' && v('45%', '54%') === 'corrupt' && v('200', '2000') === 'corrupt', '');
    check('value: 0.5 -> 0,5 stays 0.5 (not read as a thousands mark)', v('0.500', '0,500') === 'ok' && v('0.5', '0,5') === 'ok', '');
    check('value: dates, times and words are a benign reformat (kept as written), never corruption', v('2024-05-01', '01/05/2024') === 'keep' && v('22:30', '10:30 PM') === 'keep' && v('5', 'five') === 'keep' && v('2024-05-01', 'May 1, 2024') === 'keep' && v('22:30', '22.30') === 'keep', `${v('22:30', '10:30 PM')} ${v('22:30', '22.30')}`);
    check('value: a date with the same digits and shape is applied', v('2024-05-01', '2024/05/01') === 'ok', v('2024-05-01', '2024/05/01'));
    check('symbols: € -> euro is left alone, € -> $ is applied, empty is left alone', v('€', 'euro') === 'keep' && v('€', '$') === 'ok' && v('—', '–') === 'ok', '');
    const seg = T.groupItems([{ id: 1, text: 'Price', g: 1, l: false, t: true }, { id: 2, text: '€', g: 1, n: true, l: false, t: true }, { id: 3, text: 'only', g: 1, l: false, t: false }])[0];
    const cut = T.splitSegment(seg, `Prix${M(1)}euro${M(2)}seulement`);
    check('symbols: a symbol-only node that came back as a word stays as written and counts for nothing', cut.length === 2 && !cut.some((p) => p[0] === 2) && cut.numberMismatches === 0, JSON.stringify(cut));
  }

  // ---- every Unicode decimal digit is readable ----
  {
    let nd = 0;
    let unreadable = [];
    for (let cp = 0; cp < 0x1fc00; cp++) {
      if (cp >= 0xd800 && cp < 0xe000) continue;
      const ch = String.fromCodePoint(cp);
      if (!/\p{Nd}/u.test(ch)) continue;
      nd++;
      const d = T.asciiDigits(ch);
      if (d === null) unreadable.push(cp.toString(16));
    }
    check(`digits: all ${nd} Unicode decimal digits map to 0-9 (none unreadable)`, nd > 600 && unreadable.length === 0, unreadable.join(' '));
    const val = (zero) => T.asciiDigits(String.fromCodePoint(zero) + String.fromCodePoint(zero + 7) + String.fromCodePoint(zero + 9));
    check('digits: Khmer, Mongolian, Myanmar (incl. Shan), Tibetan, Thai, Lao, full-width and mathematical digits read as 0, 7, 9', [0x17e0, 0x1810, 0x1040, 0x1090, 0xf20, 0xe50, 0xed0, 0xff10, 0x1d7ce, 0x1d7f6, 0x1fbf0].every((z) => val(z) === '079'), [0x17e0, 0x1810, 0x1040, 0x1090, 0xf20].map(val).join());
    const two = T.groupItems([{ id: 1, text: 'a', g: 1 }, { id: 2, text: 'b', g: 1 }, { id: 3, text: 'c', g: 1 }])[0];
    check('digits: a marker numbered in Khmer or Mongolian digits is read', T.splitSegment(two, 'x ⟦១⟧ y ⟦២⟧ z')?.length === 3 && T.splitSegment(two, 'x ⟦᠑⟧ y ⟦᠒⟧ z')?.length === 3, '');
  }

  // ---- signs, words around a number, ranges, a leading point, and the target's own number style ----
  {
    const v = (a, b, loc) => T.checkNumber(a, b, loc);
    const MINUS = String.fromCharCode(0x2212);
    const RLM = String.fromCharCode(0x200f);
    check('sign: -5 -> 5 and −5 -> 5 lost the sign (corruption); the same sign is fine', v('-5', '5') === 'corrupt' && v(`${MINUS}5`, '5') === 'corrupt' && v('5', '-5') === 'corrupt' && v('-5', `${MINUS}5`) === 'ok' && v('-5', '-5') === 'ok', `${v('-5', '5')} ${v(`${MINUS}5`, '5')}`);
    check('sign: a trailing minus (Arabic style "5-") and brackets mean negative, and equal each other', v('-5', '5-') === 'ok' && v('(5)', '-5') === 'ok' && v('(1,250)', '1,250') === 'corrupt' && v('(5)', '5') === 'keep' && v('-5', '(5)') === 'ok', `${v('-5', '5-')} ${v('(1,250)', '1,250')}`);
    check('sign: signed prices and decimals', v('-$5.99', '-5,99 €') === 'ok' && v('-$5.99', '5,99 €') === 'corrupt' && v('-1.5', '-1,5') === 'ok', '');
    check('sign: direction marks around the number are ignored', v('-5', `${RLM}-5${RLM}`) === 'ok' && v('200', `${RLM}200`) === 'ok', '');
    check('words: 200 -> "200 results" and "de 200" are not written into the number node (kept as written, not corruption)', v('200', '200 results') === 'keep' && v('200', 'de 200') === 'keep', `${v('200', '200 results')} ${v('200', 'de 200')}`);
    check('range: 5-10 vs 51-0 is corruption (token values in order); 5-10 vs 5–10 is fine', v('5-10', '51-0') === 'corrupt' && v('5-10', '5–10') === 'ok' && v('5-10', '10-5') === 'keep' && v('2024-05-01', '2024/05/01') === 'ok', `${v('5-10', '51-0')} ${v('5-10', '5–10')}`);
    check('leading mark: 0.5 -> .5, ,5 and 0,5 are the same number; .5 -> 5 is not', v('0.5', '.5') === 'ok' && v('0.5', ',5') === 'ok' && v('.5', '0,5') === 'ok' && v('.5', '5') === 'corrupt' && v('.500', '0.5') === 'ok', `${v('0.5', '.5')} ${v('.5', '5')}`);
    const en2de = { source: 'en', target: 'de' };
    check('target locale: English "1,234" is 1234: "1.234" and "1 234" are right for a German target, "1,23" is not; an English "1.234" (1.234) written as "1234" for German is a corruption', v('1,234', '1.234', en2de) === 'ok' && v('1,234', '1 234', en2de) === 'ok' && v('1,234', '1,23', en2de) === 'corrupt' && v('1.234', '1234', en2de) === 'corrupt', `${v('1,234', '1.234', en2de)} ${v('1.234', '1234', en2de)}`);
    const de2en = { source: 'de', target: 'en' };
    check('target locale: German "1,5" is 1.5 and "1.234" is 1234; the English forms are accepted, a German 1,234 (1.234) written as 1234 is not', v('1,5', '1.5', de2en) === 'ok' && v('1.234', '1,234', de2en) === 'ok' && v('1,234', '1234', de2en) === 'corrupt' && v('1,234', '1.234', de2en) === 'ok', `${v('1,234', '1234', de2en)}`);
    check('target locale: with no languages given the old rule still reads 1,000 -> 1.000 as the same', v('1,000', '1.000') === 'ok' && v('1,000', '1,0') === 'corrupt', '');
    check('target locale: a point-decimal target reads a lone point as decimal, so 5.000 stays 5.0 against a German source 5,000', v('5,000', '5.000', { source: 'de', target: 'en' }) === 'ok' && v('5,000', '5000', { source: 'de', target: 'en' }) === 'corrupt', '');
    // through splitSegment with the locales of the run
    const seg = T.groupItems([{ id: 1, text: 'Total', g: 1, l: false, t: true }, { id: 2, text: '1,234', g: 1, n: true, l: false, t: true }, { id: 3, text: 'euros', g: 1, l: false, t: false }])[0];
    const asIs = T.splitSegment(seg, `Gesamt${M(1)}1,23${M(2)}Euro`, en2de);
    check('target locale: through a segment, a changed number is kept as it was and counted', asIs && !asIs.some((p) => p[0] === 2) && asIs.numberMismatches === 1, JSON.stringify(asIs));
    const fine = T.splitSegment(seg, `Gesamt${M(1)}1.234${M(2)}Euro`, en2de);
    check('target locale: and the right style is applied', fine && fine.some((p) => p[0] === 2 && p[1] === '1.234') && fine.numberMismatches === 0, JSON.stringify(fine));
  }

  // ---- a number the engine moved into a neighbouring part must not show twice ----
  {
    const seg5 = T.groupItems([{ id: 1, text: 'Showing', g: 1, l: false, t: true }, { id: 2, text: '10', g: 1, n: true, l: false, t: true }, { id: 3, text: 'of', g: 1, l: false, t: true }, { id: 4, text: '200', g: 1, n: true, l: false, t: true }, { id: 5, text: 'results', g: 1, l: false, t: false }])[0];
    const moved = T.splitSegment(seg5, `Zeige 10 von${M(1)}${M(2)}von${M(3)}${M(4)}Ergebnisse`);
    check('moved number: "Zeige 10 von | (empty) | von | (empty) | Ergebnisse" is flagged for a node-by-node redo (the 10 would show twice)', moved && moved.redo === true, JSON.stringify(moved));
    const fine5 = T.splitSegment(seg5, `Zeige${M(1)}10${M(2)}von${M(3)}200${M(4)}Ergebnisse`);
    check('moved number: the normal reply is applied, no redo', fine5 && fine5.redo === false && fine5.length === 5, JSON.stringify(fine5));
    const engine = (t) => (/⟦/.test(t) ? `Zeige 10 von${M(1)}${M(2)}von${M(3)}${M(4)}Ergebnisse` : t.toUpperCase());
    const r = await run([el('p', [text('Showing '), el('b', [text('10')]), text(' of '), el('b', [text('200')]), text(' results')])], engine);
    check('moved number: through a run each number appears exactly once', r.state.phase === 'done' && r.snap.join('') === 'SHOWING 10 OF 200 RESULTS', r.snap.join('|'));
  }

  // ---- dates are never one number ----
  {
    const v = (a, b, loc) => T.checkNumber(a, b, loc);
    check('dates: 5.6.2024 -> 5/6/2024 and 12.05.24 -> 12/05/24 are the same date (not corruption)', v('5.6.2024', '5/6/2024') === 'ok' && v('12.05.24', '12/05/24') === 'ok' && v('12.05.2024', '12-05-2024') === 'ok', `${v('5.6.2024', '5/6/2024')} ${v('12.05.24', '12/05/24')}`);
    check('dates: a reordered or reworded date is kept as written, never corrupt', v('12.05.2024', '2024-05-12') === 'keep' && v('5.6.2024', 'June 5, 2024') === 'keep' && v('5.6.2024', '6/5/2024') === 'keep' && v('2024-05-01', '01.05.2024') === 'keep', `${v('12.05.2024', '2024-05-12')} ${v('5.6.2024', '6/5/2024')}`);
    check('dates: a thousands-grouped number is still a number (1.234.567 -> 1,234,567)', v('1.234.567', '1,234,567') === 'ok' && v('1.234.567', '1,234,568') === 'corrupt', `${v('1.234.567', '1,234,567')}`);
    // many dates reformatted: numbers stay in the pair's sentences
    let clock = 70000;
    const log = [];
    const reformat = (t) => {
      const marks = t.match(MARK);
      if (!marks) return t.toUpperCase();
      const parts = t.split(MARK).map((p) => (/^\d+\.\d+\.\d+$/.test(p) ? p.split('.').reverse().join('-') : p.toUpperCase()));
      return parts.reduce((o, p, i) => o + (i ? marks[i - 1] : '') + p, '');
    };
    const api = newTr(fakeLocal(reformat, log), {}, { now: () => clock });
    const dated = () => [0, 1, 2, 3, 4].map((i) => el('p', [text(`Posted on `), el('b', [text(`${i + 1}.6.2024`)]), text(' by Ann')]));
    await run(dated(), 'x', { tr: api });
    log.length = 0;
    api.clearCache();
    const r2 = await run(dated(), 'x', { tr: api });
    check('dates: five reformatted dates do not switch numbers off (they are still sent with their sentences next time)', log.flat().some((t) => /\d/.test(t)) && r2.snap.join('').includes('1.6.2024'), JSON.stringify(log.flat().slice(0, 2)));
  }

  // ---- dashes, fractions and mirrored brackets ----
  {
    const v = (a, b, loc) => T.checkNumber(a, b, loc);
    const EN = String.fromCharCode(0x2013);
    const EM = String.fromCharCode(0x2014);
    check('dashes: an en or em dash used as the minus sign is the same sign', v('-5', `${EN}5`) === 'ok' && v('- 6', `${EN} 6`) === 'ok' && v('5 -', `5 ${EN}`) === 'ok' && v('-5', `${EM}5`) === 'ok' && v(`${EN}5`, '-5') === 'ok', `${v('-5', `${EN}5`)} ${v('5 -', `5 ${EN}`)}`);
    check('dashes: but losing the sign is still corruption, and ranges keep working', v('-5', '5') === 'corrupt' && v('5-10', `5${EN}10`) === 'ok' && v('5-10', `5${EM}10`) === 'ok' && v('5-10', '51-0') === 'corrupt', '');
    check('fractions: 1½ -> 1,5 and 1 1/2 -> 1.5 are left as written, never corrupt', v('1½', '1,5') === 'keep' && v('1 1/2', '1.5') === 'keep' && v('¾', '0,75') === 'keep' && v('1.5', '1½') === 'keep', `${v('1½', '1,5')} ${v('1 1/2', '1.5')}`);
    check('mirrored brackets: (5) written )5( for an Arabic, Persian, Hebrew or Urdu target is left alone; for other targets it is a lost sign', ['ar', 'fa', 'he', 'ur'].every((t) => v('(5)', ')5(', { source: 'en', target: t }) === 'keep') && v('(5)', ')5(', { source: 'en', target: 'de' }) === 'corrupt', '');
  }

  // ---- every number is checked for a duplicate, intact or not ----
  {
    const seg5 = T.groupItems([{ id: 1, text: 'Showing', g: 1, l: false, t: true }, { id: 2, text: '10', g: 1, n: true, l: false, t: true }, { id: 3, text: 'of', g: 1, l: false, t: true }, { id: 4, text: '200', g: 1, n: true, l: false, t: true }, { id: 5, text: 'results', g: 1, l: false, t: false }])[0];
    const a = T.splitSegment(seg5, `Zeige 10 von${M(1)}10${M(2)}von${M(3)}200${M(4)}Ergebnisse`);
    check('duplicate: "Zeige 10 von | 10 | von | 200 | Ergebnisse" (the 10 intact in its own node AND in the first part) is redone node by node', a && a.redo === true, JSON.stringify(a));
    const b = T.splitSegment(seg5, `Zeige 200 von${M(1)}10${M(2)}von${M(3)}200${M(4)}Ergebnisse`);
    check('duplicate: a 200 copied into an earlier part while its own node keeps it is redone too', b && b.redo === true, JSON.stringify(b));
    const ok = T.splitSegment(seg5, `Zeige${M(1)}10${M(2)}von${M(3)}200${M(4)}Ergebnisse`);
    check('duplicate: each number once is applied with no redo', ok && ok.redo === false, JSON.stringify(ok));
    const three = T.groupItems([{ id: 1, text: 'Counts', g: 1, l: false, t: true }, { id: 2, text: '10', g: 1, n: true, l: false, t: true }, { id: 3, text: 'and', g: 1, l: false, t: true }, { id: 4, text: '10', g: 1, n: true, l: false, t: false }])[0];
    check('duplicate: a number that the source itself repeats is not a duplicate', T.splitSegment(three, `Zählt${M(1)}10${M(2)}und${M(3)}10`).redo === false, '');
    const engine = (t) => (/⟦/.test(t) ? `Zeige 10 von${M(1)}10${M(2)}von${M(3)}200${M(4)}Ergebnisse` : t.toUpperCase());
    const r = await run([el('p', [text('Showing '), el('b', [text('10')]), text(' of '), el('b', [text('200')]), text(' results')])], engine);
    check('duplicate: through a run each number appears once', r.state.phase === 'done' && r.snap.join('') === 'SHOWING 10 OF 200 RESULTS', r.snap.join('|'));
  }

  // ---- redo costs: after three in a row the pair's numbers are left out, with the usual backoff ----
  {
    let clock = 90000;
    const log = [];
    const mode = { current: 'words' };
    const engine = fakeLocal((t) => {
      const marks = t.match(MARK);
      if (!marks) return t.toUpperCase();
      const parts = t.split(MARK).map((p) => (/^\d/.test(p) ? (mode.current === 'words' ? `${p} items` : p) : p.toUpperCase()));
      return parts.reduce((o, p, i) => o + (i ? marks[i - 1] : '') + p, '');
    }, log);
    const api = newTr(engine, {}, { now: () => clock });
    const blocks = () => [0, 1, 2, 3].map((i) => el('p', [text(`Redo ${'abcd'[i]} has `), el('b', [text(String(10 + i))]), text(' things')]));
    const numbersSent = async () => { log.length = 0; api.clearCache(); await run(blocks(), 'x', { tr: api }); return log.flat().some((t) => /\d/.test(t)); };
    const MIN = 60 * 1000;
    check('redo cost: segments whose numbers keep collecting words are redone, and after three in a row numbers are left out', (await numbersSent()) === true && (await numbersSent()) === false, '');
    clock += 10 * MIN + 1;
    check('redo cost: after 10 minutes one run probes again, and a repeat pauses them for 20', (await numbersSent()) === true && (clock += 19 * MIN, await numbersSent()) === false, '');
    clock += 1 * MIN + 1;
    mode.current = 'clean';
    check('redo cost: a probe that comes back clean clears the pause', (await numbersSent()) === true && (await numbersSent()) === true, '');
  }

  // ---- numbers copied back unchanged are never judged ----
  {
    const v = (a, b, loc) => T.checkNumber(a, b, loc);
    const en2de = { source: 'en', target: 'de' };
    check('unchanged: 1,234 and 3.142 copied verbatim for a German target are not corrupt', v('1,234', '1,234', en2de) === 'ok' && v('3.142', '3.142', en2de) === 'ok' && v('1,234', '1 234'.replace(' ', String.fromCharCode(0xa0)), en2de) !== 'corrupt', `${v('1,234', '1,234', en2de)} ${v('3.142', '3.142', en2de)}`);
    check('unchanged: German 1.234,5 copied verbatim for an English target is not corrupt, a changed one still is', v('1.234,5', '1.234,5', { source: 'de', target: 'en' }) === 'ok' && v('1.234,5', '1.234,6', { source: 'de', target: 'en' }) === 'corrupt', '');
    const seg = T.groupItems([{ id: 1, text: 'Pi', g: 1, l: false, t: true }, { id: 2, text: '3.142', g: 1, n: true, l: false, t: false }])[0];
    const cut = T.splitSegment(seg, `Pi${M(1)}3.142`, en2de);
    check('unchanged: through a segment it counts as no mismatch', cut && cut.numberMismatches === 0, JSON.stringify(cut));
  }

  // ---- coordinates, codes and list markers ----
  {
    const v = (a, b, loc) => T.checkNumber(a, b, loc);
    check('coordinates: "40.7128, -74.0060" -> "40,7128, 74,0060" lost a minus (corruption); with both signs it is fine', v('40.7128, -74.0060', '40,7128, 74,0060') === 'corrupt' && v('40.7128, -74.0060', '40,7128, -74,0060') === 'ok' && v('40.7128, -74.0060', '40.7128, −74.0060') === 'ok', `${v('40.7128, -74.0060', '40,7128, 74,0060')}`);
    check('coordinates: a multi-number node whose digits changed is kept as written (it could be a reformat), never applied', v('40.7128, -74.0060', '40,7128, -74,0600') === 'keep', '');
    check('codes: 192.168.0.1 -> 192.1680.1 and 1.2.3.4 -> 12.3.4 are corruption; the same groups are fine', v('192.168.0.1', '192.1680.1') === 'corrupt' && v('1.2.3.4', '12.3.4') === 'corrupt' && v('192.168.0.1', '192.168.0.1') === 'ok' && v('1.2.3.4', '1,2,3,4') === 'ok', `${v('192.168.0.1', '192.1680.1')} ${v('1.2.3.4', '12.3.4')}`);
    check('codes: real thousands grouping is still a number (1.234.567,89 -> 1,234,567.89)', v('1.234.567,89', '1,234,567.89') === 'ok' && v('1.234.567,89', '1,234,567.88') === 'corrupt', '');
    check('list markers: (1) -> 1 and (12) -> 12 lose their brackets without being corrupt; a bracketed amount that loses them still is', v('(1)', '1') === 'keep' && v('(12)', '12') === 'keep' && v('(1)', '-1') !== 'keep' && v('($5.99)', '5.99') === 'corrupt', `${v('(1)', '1')} ${v('($5.99)', '5.99')}`);
  }

  // ---- words that landed in a number's part: the sentence is translated node by node, nothing is lost ----
  {
    const segW = T.groupItems([{ id: 1, text: 'Showing', g: 1, l: false, t: true }, { id: 2, text: '200', g: 1, n: true, l: false, t: true }, { id: 3, text: 'results', g: 1, l: false, t: false }])[0];
    const moved = T.splitSegment(segW, `Mostrando${M(1)}200 resultados${M(2)}`);
    check('words in a number: when the neighbour came back empty the segment is flagged for a node-by-node redo', moved && moved.redo === true && !moved.some((p) => p[0] === 2), JSON.stringify(moved));
    const fineW = T.splitSegment(segW, `Mostrando${M(1)}200 resultados${M(2)}resultados`);
    check('words in a number: even when every word node has its text, words put into a plain number are not applied, and the block is redone node by node (nothing dropped silently)', fineW && fineW.redo === true && !fineW.some((p) => p[0] === 2), JSON.stringify(fineW));
    const segT = T.groupItems([{ id: 1, text: 'Closes at', g: 1, l: false, t: true }, { id: 2, text: '22:30', g: 1, n: true, l: false, t: true }, { id: 3, text: 'today', g: 1, l: false, t: false }])[0];
    check('words in a number: a time or date with words (10:30 PM, May 1) is not a plain number: it stays as written without a redo', T.splitSegment(segT, `Cierra a las${M(1)}10:30 PM${M(2)}hoy`).redo === false, '');
    const engine = (t) => {
      const marks = t.match(MARK);
      if (!marks) return t.toUpperCase(); // node by node
      return t.replace(/ ⟦1⟧ (\d+) ⟦2⟧ /, ' ⟦1⟧ $1 RESULTS ⟦2⟧ ').replace(/ ⟦2⟧ results$/, ' ⟦2⟧ ').toUpperCase(); // the words move into the number's part
    };
    const r = await run([el('p', [text('Showing '), el('b', [text('200')]), text(' results')])], engine);
    check('words in a number: through a run the sentence still ends up complete and sensible, with the number intact', r.state.phase === 'done' && r.snap.join('') === 'SHOWING 200 RESULTS' && r.snap[1] === '200', r.snap.join('|'));
  }

  // ---- numbers: benign reformats do not switch numbers off; real corruption in a row does, and the pause backs off ----
  {
    let clock = 20000;
    const log = [];
    const mode = { current: 'mangle' };
    const engine = fakeLocal((t) => {
      const marks = t.match(MARK);
      if (!marks) return t.toUpperCase();
      const parts = t.split(MARK).map((p) => {
        if (!/^\d/.test(p)) return p.toUpperCase();
        if (mode.current === 'clean') return p;
        return `${p}0`;
      });
      return parts.reduce((o, p, i) => o + (i ? marks[i - 1] : '') + p, '');
    }, log);
    const api = newTr(engine, {}, { now: () => clock });
    const nums = (list) => list.map((n, i) => el('p', [text(`Item ${'abcdefgh'[i]} is `), el('b', [text(String(n))]), text(' pieces')]));
    const numbersSent = async (list) => { log.length = 0; api.clearCache(); await run(nums(list), 'x', { tr: api }); return log.flat().some((t) => /\d/.test(t)); };
    const MIN = 60 * 1000;
    // corrupt, corrupt, clean, corrupt, corrupt: the clean segment resets the count, so numbers stay in
    mode.current = 'mangle';
    const log2 = [];
    const picky = fakeLocal((t) => {
      const marks = t.match(MARK);
      if (!marks) return t.toUpperCase();
      const parts = t.split(MARK).map((p) => (/^\d/.test(p) ? (p === '102' ? p : `${p}0`) : p.toUpperCase()));
      return parts.reduce((o, p, i) => o + (i ? marks[i - 1] : '') + p, '');
    }, log2);
    const api2 = newTr(picky, {}, { now: () => clock });
    await run(nums([100, 101, 102, 103, 104]), 'x', { tr: api2 });
    log2.length = 0;
    api2.clearCache();
    await run(nums([100, 101]), 'x', { tr: api2 });
    check('numbers: a clean segment between corrupt ones resets the count (two, clean, two does not switch numbers off)', log2.flat().some((t) => /\d/.test(t)), JSON.stringify(log2.flat()));

    check('numbers: three corrupt segments in a row switch numbers off for the pair', (await numbersSent([100, 101, 102, 103])) === true && (await numbersSent([100, 101])) === false, '');
    clock += 10 * MIN + 1;
    check('numbers: after 10 minutes one run probes with numbers again; a corrupt number pauses them for 20', (await numbersSent([100, 101])) === true && (clock += 19 * MIN, await numbersSent([100, 101])) === false, '');
    clock += 1 * MIN + 1;
    mode.current = 'clean';
    check('numbers: a probe whose numbers come back intact clears the pause', (await numbersSent([100, 101])) === true && (await numbersSent([100, 101])) === true, '');
  }

  // ---- one pair, several tabs: a late trip never shortens a longer pause ----
  {
    let clock = 40000;
    const log = [];
    let hold = null;
    const base = fakeLocal('drop', log);
    const engine = { ...base, translate: async (r, t) => { const gate = hold; hold = null; if (gate) await gate; return base.translate(r, t); } };
    const api = newTr(engine, {}, { now: () => clock });
    const blocks = () => [0, 1, 2].map((i) => el('p', [text(`Tabs ${i} ${'t'.repeat(50)} `), el('b', [text(`bold ${i}`)])]));
    const grouping = async () => { log.length = 0; api.clearCache(); await run(blocks(), 'x', { tr: api }); return withSeams(log).length > 0; };
    const MIN = 60 * 1000;
    // tab Y starts grouping while the pair is healthy, and its request is held
    let release;
    hold = new Promise((resolve) => { release = resolve; });
    const slow = run(blocks(), 'x', { tr: api });
    await sleep(60);
    await grouping(); // tab X trips the pair: 10 minutes
    clock += 10 * MIN + 1;
    await grouping(); // X probes and fails: 20 minutes
    release(); // tab Y's request comes back bad: a non-probing trip
    await slow;
    clock += 11 * MIN; // 11 minutes after the 20-minute pause began
    check('shared pair: a second tab\'s late trip does not rewrite a 20 minute pause back to 10', (await grouping()) === false, '');
    clock += 10 * MIN;
    check('shared pair: and the pause still ends at 20 minutes', (await grouping()) === true, '');
  }

  // ---- a pair with no multi-node segments does not pay the small first request ----
  {
    const log = [];
    const singles = Array.from({ length: 8 }, (_v, i) => el('p', [text(`Single ${i} ${'s'.repeat(150)}`)]));
    await run(singles, 'keep', { tr: newTr(fakeLocal('keep', log)) });
    check('first request: a page with only one-node blocks uses the normal first chunk', (log[0] || []).join('').length > T.LOCAL_PROBE_FIRST + 300, JSON.stringify((log[0] || []).map((t) => t.length)));
    const log2 = [];
    const api = newTr(fakeLocal('keep', log2));
    const multi = () => Array.from({ length: 8 }, (_v, i) => el('p', [text(`Multi ${i} ${'m'.repeat(60)} `), el('b', [text(`bold ${i}`)])]));
    await run(multi(), 'x', { tr: api });
    const firstSize = (log2[0] || []).length;
    log2.length = 0;
    api.clearCache();
    await run(multi(), 'x', { tr: api });
    check('first request: once a pair\'s markers have worked, its first request is the normal size (more segments than the small probe)', (log2[0] || []).length > firstSize, `${firstSize} -> ${(log2[0] || []).length}`);
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
