// REAL engine, plain Node, NO window (manual; not in test-all): do the seam markers that join a block's text
// nodes into one sentence (features/translate.js) survive Mozilla's Bergamot? Downloads the French -> English
// pack (about 40 MB) into a temp folder, starts the real wasm engine in a Node child process (the same
// translate-worker.js the app runs in a utility process), translates a few segments joined with each
// candidate seam, and reports how often the seam came back intact, in order, and how it was rendered.
//   LUMEN_REAL_ENGINE=1 node test/translate-seam-real.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const M = require('../src/features/translate-models');
const { createLocal, nodeFork } = require('../src/features/translate-local');
const T = require('../src/features/translate');

if (process.env.LUMEN_REAL_ENGINE !== '1') { console.log('Skipped: set LUMEN_REAL_ENGINE=1 (needs the network, about 40 MB).'); process.exit(0); }

// Each segment: the text nodes of one block (what the page script collects), as French.
const SEGMENTS = [
  ['Le gouvernement a annoncé ', 'hier', ' de nouvelles ', 'mesures', ' pour soutenir les petites entreprises.'],
  ['Selon le ministre, ces aides seront ', 'versées', ' dès le mois prochain.'],
  ['Les syndicats ont salué cette ', 'décision', ', tout en demandant que les salariés soient mieux protégés.'],
  ['La ville de ', 'Lyon', ' accueillera cet été un grand festival de musique.'],
  ['Les organisateurs espèrent attirer ', 'plus de deux cent mille visiteurs', ' pendant les trois semaines que durera ', 'l’événement', '.'],
  ['Dans le sud de la France, la sécheresse inquiète les ', 'agriculteurs', ', qui craignent de perdre une grande partie de leurs récoltes.'],
  ['Cliquez ', 'ici', ' pour ', 'lire la suite', ' de cet article.'],
  ['Le nouveau musée ouvrira ses portes au public le premier jour du ', 'printemps', '.'],
];

// candidate seams: (n) -> the text between node n and n + 1
const CANDIDATES = {
  'U+E000 U+E001 (current)': () => '',
  'U+E000 alone': () => '',
  'double vertical bar ‖': () => ' ‖ ',
  'numbered ⟦n⟧': (n) => ` ⟦${n + 1}⟧ `,
  'numbered [[n]]': (n) => ` [[${n + 1}]] `,
  'numbered {n}': (n) => ` {${n + 1}} `,
  'numbered <n>': (n) => ` <${n + 1}> `,
  'pipe-slash |/|': () => ' |/| ',
  'section sign §': () => ' § ',
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-seam-real-'));
  const store = M.createModelStore({ dir, fetch: (url, o) => fetch(url, { ...o, headers: { ...o?.headers, 'user-agent': 'Lumen' } }) });
  const local = createLocal({ store, fork: nodeFork(childProcess) });
  const route = [['fr', 'en']];
  console.log('Downloading fr -> en ...');
  await local.ensure(route, {});
  console.log('Pack ready. Starting the engine ...');
  const report = {};
  for (const [name, seam] of Object.entries(CANDIDATES)) {
    let intact = 0;
    const samples = [];
    const texts = SEGMENTS.map((nodes) => nodes.map((n, i) => n + (i < nodes.length - 1 ? seam(i) : '')).join(''));
    const out = await local.translate(route, texts);
    out.forEach((reply, k) => {
      const count = SEGMENTS[k].length - 1;
      const marks = [...Array(count)].map((_v, i) => seam(i).trim());
      let at = 0;
      let ok = true;
      for (const m of marks) { const j = reply.indexOf(m, at); if (j < 0) { ok = false; break; } at = j + m.length; }
      // also require no extra copies of the first mark
      if (ok && marks.length && reply.split(marks[0]).length - 1 !== (marks.every((m) => m === marks[0]) ? count : 1)) ok = false;
      if (ok) intact++;
      if (samples.length < 3) samples.push(JSON.stringify(reply));
    });
    report[name] = { intact, total: SEGMENTS.length };
    console.log(`\n${name}: ${intact}/${SEGMENTS.length} segments kept every marker in order`);
    samples.forEach((s) => console.log(`   ${s}`));
  }
  // The shipped path end to end: group -> engine -> split
  const items = SEGMENTS.flatMap((nodes, b) => nodes.map((n, i) => ({ id: b * 10 + i + 1, text: n.trim(), g: b + 1, l: /^\s/.test(n), t: /\s$/.test(n) })));
  const grouped = T.groupItems(items);
  const replies = await local.translate(route, grouped.map((g) => g.text));
  let split = 0;
  grouped.forEach((g, i) => {
    if (!g.nodes || T.splitSegment(g, replies[i])) split++;
    else console.log(`   refused: ${JSON.stringify(g.text)}\n        ->  ${JSON.stringify(replies[i])}`);
  });
  console.log(`\nShipped seam via groupItems/splitSegment: ${split}/${grouped.length} segments cut back into nodes`);
  local.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nSUMMARY', JSON.stringify(report));
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
