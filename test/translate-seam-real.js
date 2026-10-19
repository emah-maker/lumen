// REAL engine, plain Node, NO window (manual; not in test-all): do the markers that join a block's text nodes
// into one sentence (features/translate.js) survive Mozilla's Bergamot? For each pair below it downloads the
// pack into a temp folder, starts the real wasm engine in a Node child process (the same translate-worker.js the
// app runs in a utility process), translates a few segments joined with each candidate seam, and prints a
// Markdown report: how often the seam came back intact and in order, sample replies, and the shipped path
// (groupItems -> engine -> splitSegment). Progress goes to stderr, the report to stdout:
//   LUMEN_REAL_ENGINE=1 node test/translate-seam-real.js > docs/translate-seam-measurement.md
//   PAIRS=fr>en,en>ar  limits it to some pairs.   (needs the network; about 35 MB per pack)
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const M = require('../src/features/translate-models');
const { createLocal, nodeFork } = require('../src/features/translate-local');
const T = require('../src/features/translate');

if (process.env.LUMEN_REAL_ENGINE !== '1') { console.log('Skipped: set LUMEN_REAL_ENGINE=1 (needs the network, about 35 MB per pack).'); process.exit(0); }
const log = (...a) => console.error(...a);

// Each segment: the text nodes of one block (what the page script collects).
const SETS = {
  fr: [
    ['Le gouvernement a annoncé ', 'hier', ' de nouvelles ', 'mesures', ' pour soutenir les petites entreprises.'],
    ['Selon le ministre, ces aides seront ', 'versées', ' dès le mois prochain.'],
    ['Les syndicats ont salué cette ', 'décision', ', tout en demandant que les salariés soient mieux protégés.'],
    ['La ville de ', 'Lyon', ' accueillera cet été un grand festival de musique.'],
    ['Les organisateurs espèrent attirer ', 'plus de deux cent mille visiteurs', ' pendant les trois semaines que durera ', 'l’événement', '.'],
    ['Dans le sud de la France, la sécheresse inquiète les ', 'agriculteurs', ', qui craignent de perdre une grande partie de leurs récoltes.'],
    ['Cliquez ', 'ici', ' pour ', 'lire la suite', ' de cet article.'],
    ['Affichage de ', '10', ' sur ', '200', ' résultats'],
  ],
  es: [
    ['El gobierno anunció ', 'ayer', ' nuevas ', 'medidas', ' para apoyar a las pequeñas empresas.'],
    ['Según el ministro, estas ayudas se pagarán ', 'a partir del mes que viene', '.'],
    ['Los sindicatos ', 'acogieron con satisfacción', ' la decisión, pero piden más protección para los trabajadores.'],
    ['La ciudad de ', 'Valencia', ' acogerá este verano un gran festival de música.'],
    ['Haga clic ', 'aquí', ' para ', 'leer más', ' sobre este artículo.'],
    ['Publicado hace ', '5', ' días por ', 'Ana', '.'],
    ['Mostrando ', '10', ' de ', '200', ' resultados'],
    ['El nuevo museo abrirá sus puertas al público el primer día de la ', 'primavera', '.'],
  ],
  de: [
    ['Die Regierung hat ', 'gestern', ' neue ', 'Maßnahmen', ' zur Unterstützung kleiner Unternehmen angekündigt.'],
    ['Laut dem Minister werden diese Hilfen ', 'ab nächstem Monat', ' ausgezahlt.'],
    ['Die Gewerkschaften begrüßten die ', 'Entscheidung', ', forderten aber einen besseren Schutz der Beschäftigten.'],
    ['Die Stadt ', 'Hamburg', ' wird diesen Sommer ein großes Musikfestival ausrichten.'],
    ['Klicken Sie ', 'hier', ', um ', 'weiterzulesen', '.'],
    ['Vor ', '5', ' Tagen von ', 'Anna', ' veröffentlicht'],
    ['Zeige ', '10', ' von ', '200', ' Ergebnissen'],
    ['Das neue Museum öffnet am ersten Tag des ', 'Frühlings', ' seine Türen.'],
  ],
  en: [
    ['The government announced ', 'yesterday', ' new ', 'measures', ' to support small businesses.'],
    ['According to the minister, this aid will be ', 'paid', ' from next month.'],
    ['The unions welcomed the ', 'decision', ', while asking for better protection for workers.'],
    ['The city of ', 'London', ' will host a big music festival this summer.'],
    ['Click ', 'here', ' to ', 'read more', ' about this article.'],
    ['Posted ', '5', ' days ago by ', 'Anna', '.'],
    ['Showing ', '10', ' of ', '200', ' results'],
    ['The new museum will open its doors to the public on the first day of ', 'spring', '.'],
  ],
  ja: [
    ['政府は', '昨日', '、中小企業を支援するための', '新しい対策', 'を発表しました。'],
    ['大臣によると、この支援は', '来月から', '支払われます。'],
    ['労働組合はこの', '決定', 'を歓迎しましたが、労働者のより良い保護を求めています。'],
    ['東京では', '今年の夏', 'に大きな音楽祭が開催されます。'],
    ['詳しくは', 'こちら', 'をクリックして', '記事を読む', 'ことができます。'],
    ['投稿者', 'アンナ', 'さん、', '5', '日前'],
    ['', '200', '件中', '10', '件を表示'],
    ['新しい博物館は', '春', 'の初日に一般公開されます。'],
  ],
};
const PAIRS = [['fr', 'en'], ['es', 'en'], ['de', 'en'], ['en', 'ar'], ['en', 'fa'], ['ja', 'en']];

// Candidate seams: (n) -> the text between node n and n + 1 (n counts from 1). Escapes, never the raw characters.
const CANDIDATES = {
  'private-use U+E000 U+E001 (first version)': () => '\uE000\uE001',
  'private-use U+E000 alone': () => '\uE000',
  'double bar ‖': () => ' ‖ ',
  'numbered ⟦n⟧ (shipped)': (n) => T.seamOf(n),
  'numbered [[n]]': (n) => ` [[${n}]] `,
  'numbered <n>': (n) => ` <${n}> `,
  'numbered {n}': (n) => ` {${n}} `,
  'slash-bar |/|': () => ' |/| ',
  'section sign §': () => ' § ',
};
const show = (s) => JSON.stringify(s).replace(/./gu, (c) => (c.codePointAt(0) >= 0xe000 && c.codePointAt(0) <= 0xf8ff ? '\\u' + c.codePointAt(0).toString(16).toUpperCase() : c)); // private-use characters as escapes, so the report shows them

(async () => {
  const want = (process.env.PAIRS || '').split(',').filter(Boolean);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-seam-real-'));
  const store = M.createModelStore({ dir, fetch: (url, o) => fetch(url, { ...o, headers: { ...o?.headers, 'user-agent': 'Lumen' } }) });
  const local = createLocal({ store, fork: nodeFork(childProcess) });
  const index = await store.loadIndex();
  const out = [];
  out.push('# Segment marker measurement (real Bergamot engine)', '');
  out.push(`Measured ${new Date().toISOString().slice(0, 10)} with \`LUMEN_REAL_ENGINE=1 node test/translate-seam-real.js\` (plain Node, no window): the app's own \`translate-worker.js\` and Mozilla's models, Node ${process.version}.`);
  out.push('Each sentence is a block\'s text nodes joined with a candidate seam. "Intact" means every marker came back, once, in order. The shipped row also runs the real `groupItems` and `splitSegment` (it must cut the reply back into the right number of nodes).', '');
  const summary = [];
  for (const [from, to] of PAIRS) {
    if (want.length && !want.includes(`${from}>${to}`)) continue;
    const key = `${M.modelCode(from)}>${M.modelCode(to)}`;
    if (!index[key]) { out.push(`## ${from} to ${to}`, '', 'No pack in the registry; skipped.', ''); continue; }
    const route = [[M.modelCode(from), M.modelCode(to)]];
    try {
    log(`Downloading ${key} (${(index[key].bytes / 1e6).toFixed(1)} MB) ...`);
    await local.ensure(route, {});
    const sets = SETS[from];
    out.push(`## ${from} to ${to}`, '', `Pack ${key} v${index[key].version}, ${(index[key].bytes / 1e6).toFixed(1)} MB. ${sets.length} sentences of 3 to 5 nodes (two of them with counts or names as their own nodes).`, '');
    out.push('| Candidate | Intact |', '|---|---|');
    const samples = {};
    for (const [name, seam] of Object.entries(CANDIDATES)) {
      const texts = sets.map((nodes) => nodes.map((n, i) => n + (i < nodes.length - 1 ? seam(i + 1) : '')).join(''));
      const replies = await local.translate(route, texts);
      let intact = 0;
      replies.forEach((reply, k) => {
        const marks = [...Array(sets[k].length - 1)].map((_v, i) => seam(i + 1).trim());
        let at = 0;
        let ok = true;
        for (const m of marks) { const j = reply.indexOf(m, at); if (j < 0) { ok = false; break; } at = j + m.length; }
        if (ok && marks.every((m) => m === marks[0]) && reply.split(marks[0]).length - 1 !== marks.length) ok = false;
        if (ok) intact++;
        if (name.includes('shipped') || name.includes('first version')) (samples[name] ||= []).push(show(reply));
      });
      out.push(`| ${name} | ${intact}/${sets.length} |`);
      summary.push({ pair: `${from}>${to}`, name, intact, total: sets.length });
    }
    // the shipped path end to end, with the numbers as letterless members like the page script sends them
    const items = sets.flatMap((nodes, b) => nodes.filter((n) => n !== '').map((n, i) => ({ id: b * 10 + i + 1, text: n.trim(), g: b + 1, l: /^\s/.test(n), t: /\s$/.test(n), ...(/\p{L}/u.test(n) ? {} : { n: true }) })));
    const grouped = T.groupItems(items);
    const replies = await local.translate(route, grouped.map((g) => g.text));
    let cut = 0;
    const refused = [];
    grouped.forEach((g, i) => { if (!g.nodes || T.splitSegment(g, replies[i])) cut++; else refused.push([g.text, replies[i]]); });
    out.push('', `Shipped path (groupItems, engine, splitSegment): ${cut}/${grouped.length} segments cut back into nodes.`, '');
    summary.push({ pair: `${from}>${to}`, name: 'shipped path', intact: cut, total: grouped.length });
    for (const [name, list] of Object.entries(samples)) { out.push(`Sample replies, ${name}:`, '```', ...list.slice(0, 3), '```', ''); }
    if (refused.length) { out.push('Refused by splitSegment:', '```', ...refused.map(([a, b]) => `${show(a)}\n  -> ${show(b)}`), '```', ''); }
    } catch (err) {
      out.push(`The engine failed on this pair: ${String(err?.message || err)}. Reported, not hidden.`, '');
      log(`${key}: ${err?.message}`);
    }
    local.stop(); // a fresh engine for the next pair
  }
  local.stop();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  out.push('## Summary', '', '| Pair | ' + Object.keys(CANDIDATES).join(' | ') + ' | shipped path |', '|---|' + '---|'.repeat(Object.keys(CANDIDATES).length + 1));
  for (const pair of [...new Set(summary.map((s) => s.pair))]) {
    const row = summary.filter((s) => s.pair === pair);
    const cell = (n) => { const r = row.find((x) => x.name === n); return r ? `${r.intact}/${r.total}` : '-'; };
    out.push(`| ${pair} | ${Object.keys(CANDIDATES).map(cell).join(' | ')} | ${cell('shipped path')} |`);
  }
  console.log(out.join('\n'));
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
