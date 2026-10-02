// On-device translation sends whole sentences, not one request per text node: the nodes of a block are
// joined with private-use seams, and the reply is cut at the seams again (features/translate.js).
// Plain Node: the page script (PAGE_SRC) runs against a small fake DOM through a fake tab.
const vm = require('vm');
const T = require('../src/features/translate');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const S = T.SEAM;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a tiny DOM ----
const INLINE = new Set(['B', 'A', 'I', 'EM', 'STRONG', 'SPAN', 'CODE', 'U', 'SMALL']);
function el(tag, children = [], attrs = {}) {
  const node = { tagName: tag.toUpperCase(), children, parentElement: null, attrs, isContentEditable: false, classList: { contains: (c) => String(attrs.class || '').split(/\s+/).includes(c) },
    getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs, getBoundingClientRect: () => (attrs.offscreen || (node.parentElement && node.parentElement.attrs.offscreen) ? { width: 10, height: 10, top: 5000, bottom: 5010, left: 0, right: 10 } : { width: 10, height: 10, top: 10, bottom: 20, left: 0, right: 10 }) };
  for (const c of children) c.parentElement = node;
  return node;
}
const text = (data) => ({ nodeType: 3, data, parentElement: null, isConnected: true });
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

// A fake on-device engine. mode: 'keep' (upper-case each part, seams intact), 'drop' (seams lost), 'extra' (an invented seam),
// 'swap' (parts reversed but seams intact: a legitimate reorder), 'lose-one' (one seam lost)
function fakeLocal(mode, log) {
  return {
    supports: () => true,
    plan: async () => ({ route: [['fr', 'en']], missing: 0, total: 0 }),
    warm: async () => {},
    ensure: async () => {},
    translate: async (_route, texts) => {
      log.push([...texts]);
      return texts.map((t) => {
        if (!t.includes(S)) return t.toUpperCase();
        const parts = t.split(S);
        if (mode === 'drop') return parts.map((p) => p.toUpperCase()).join('');
        if (mode === 'extra') return parts.map((p) => p.toUpperCase()).join(S) + S;
        if (mode === 'lose-one') return parts.map((p) => p.toUpperCase()).join(S).replace(S, '');
        if (mode === 'swap') return parts.map((p) => p.trim().toUpperCase()).reverse().join(` ${S}`);
        return parts.map((p) => p.toUpperCase()).join(S);
      });
    },
  };
}

async function run(blocks, mode, { local = null, settings = {} } = {}) {
  const dom = makeDom(blocks);
  const tab = fakeTab(dom);
  const log = [];
  const tr = T.createTranslate({ readSettings: () => settings, writeSettings() {}, t: (k) => k, uiLocale: () => 'en', engine: () => null, aiAllowed: () => true, sendTabs() {}, popupMenu() {}, openUrl() {}, local: local ? local(fakeLocal(mode, log)) : fakeLocal(mode, log) });
  tr.start(tab, { want: 'local' });
  for (let i = 0; i < 100 && !tr.isTranslated(tab) && tr.stateOf(tab)?.phase !== 'error'; i++) await sleep(20);
  const state = tr.stateOf(tab);
  const snap = dom.nodes.map((n) => n.data); // what the page showed when the run finished
  tr.act(tab, 'original');
  return { dom, log, state, snap, flat: log.flat() };
}

(async () => {
  // ---- pure helpers ----
  const items = [
    { id: 1, text: 'A', v: false, g: 1, l: false, t: true }, { id: 2, text: 'quick', v: true, g: 1, l: false, t: true }, { id: 3, text: 'brown', v: false, g: 1, l: false, t: false },
    { id: 4, text: 'Other', v: false, g: 2, l: false, t: false }, { id: 0, text: 'Title', v: true },
  ];
  const grouped = T.groupItems(items);
  check('group: nodes of one block become one segment, other blocks and the title stay alone', grouped.length === 3 && grouped[0].nodes.length === 3 && grouped[0].id === 1 && grouped[1].id === 4 && grouped[2].id === 0, JSON.stringify(grouped));
  check('group: the seam sits after the space the page had, and the segment is visible if any node is', grouped[0].text === `A ${S}quick ${S}brown` && grouped[0].v === true, JSON.stringify(grouped[0].text));
  check('group: a lone node is passed through untouched', grouped[1] === items[3], '');
  check('group: a very long block is cut into several segments', T.groupItems(Array.from({ length: 10 }, (_v, i) => ({ id: i + 1, text: 'x'.repeat(300), g: 1 }))).length > 1, '');
  const seg = grouped[0];
  check('split: a reply with the same seams is cut back into nodes', JSON.stringify(T.splitSegment(seg, `UN ${S}RAPIDE ${S}BRUN`)) === '[[1,"UN"],[2,"RAPIDE"],[3,"BRUN"]]', JSON.stringify(T.splitSegment(seg, `UN ${S}RAPIDE ${S}BRUN`)));
  check('split: dropped, extra or half-lost seams are refused', T.splitSegment(seg, 'UN RAPIDE BRUN') === null && T.splitSegment(seg, `UN ${S}RAPIDE ${S}BRUN ${S}`) === null && T.splitSegment(seg, `UN RAPIDE ${S}BRUN`) === null && T.splitSegment(seg, `UN ${S}${S}BRUN`) === null && T.splitSegment(seg, `UN  RAPIDE ${S}BRUN`) === null, '');
  check('split: an empty part for a node with text is refused', T.splitSegment(seg, `UN ${S} ${S}BRUN`) === null, '');

  // ---- through the page script and the run ----
  {
    const { snap, log, state, flat } = await run([
      el('p', [text('A '), el('b', [text('quick')]), text(' brown '), el('a', [text('fox')]), text(' jumps.')]),
    ], 'keep');
    check('inline markup: A <b>quick</b> brown <a>fox</a> jumps. goes as one sentence in one request', state.phase === 'done' && log.length === 1 && flat.length === 1 && flat.some((t) => t === `A ${S}quick ${S}brown ${S}fox ${S}jumps.`), JSON.stringify(log));
    check('inline markup: each node gets its own part back, its spaces kept', snap.join('') === 'A QUICK BROWN FOX JUMPS.', snap.join('|'));
  }
  {
    const { snap, flat } = await run([
      el('p', [text('Hello '), el('b', [text('world')])]),
      el('ul', [el('li', [text('First '), el('i', [text('item')])]), el('li', [text('Second')])]),
    ], 'keep');
    check('blocks: each p / li is its own sentence', flat.filter((t) => t.includes(S)).length === 2 && flat.includes('Second'), JSON.stringify(flat));
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
    check('excluded: they also break the sentence (no seam stands in for them)', flat.includes('Use') && flat.includes('now') && flat.includes('Name') && !flat.some((t) => /Use .*now/.test(t)), JSON.stringify(flat));
  }
  for (const mode of ['drop', 'extra', 'lose-one']) {
    const { snap, log, state } = await run([el('p', [text('A '), el('b', [text('quick')]), text(' brown')])], mode);
    const segmentSent = log[0]?.some((t) => t.includes(S));
    const perNode = log.slice(1).flat();
    check(`fallback (${mode}): a reply with the wrong number of seams is not used; the nodes are translated one by one instead`, state.phase === 'done' && segmentSent && ['A', 'quick', 'brown'].every((w) => perNode.includes(w)) && snap.map((d) => d.trim()).join('|') === 'A|QUICK|BROWN', `${JSON.stringify(log)} ${snap}`);
  }
  {
    const { snap, state } = await run([el('p', [text('one '), el('b', [text('two')])])], 'swap');
    check('reorder: a reply that moves the words but keeps every seam is applied', state.phase === 'done' && snap.map((d) => d.trim()).join('|') === 'TWO|ONE', snap);
  }
  {
    const { log } = await run([
      el('p', [text('far below '), el('b', [text('the fold')])], { offscreen: true }),
      el('p', [text('on '), el('b', [text('screen')])]),
    ], 'keep');
    check('order: what is on screen is sent first, whole sentences', log[0] && log[0][0].startsWith(`on ${S}screen`.slice(0, 3)) && log[0][0].includes('screen'), JSON.stringify(log));
  }
  {
    const { log } = await run([el('p', [text('Alpha '), el('b', [text('beta')])]), el('p', [text('Gamma')])], 'keep');
    const first = log[0] || [];
    check('first chunk: the small first request still holds whole segments', first.length >= 1 && first.every((t) => !t.endsWith(S) && !t.startsWith(S)), JSON.stringify(log));
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
