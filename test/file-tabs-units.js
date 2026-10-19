// Organize and tabs that show files (features/file-tabs.js, browser/tab-groups.js, features/organize-ai.js, features/ai-sites.js): node test/file-tabs-units.js
// Pure Node, no window. Tabs are shaped like main.js's: a live one answers from its URL and title (urlOf is realUrl, the viewer's address for a PDF).
const fileTabs = require('../src/features/file-tabs');
const tg = require('../src/browser/tab-groups');
const oai = require('../src/features/organize-ai');
const { createAiSites, siteOf } = require('../src/features/ai-sites');
const run = require('./topics-sessions-run');
const fixtures = require('./fixtures/organize-eval');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -> ${detail}`}`); };

const fileUrl = (p) => encodeURI(`file:///${p.replace(/\\/g, '/')}`);
const pdfView = (target) => `lumen-pdf://app/viewer.html?u=${encodeURIComponent(target)}`;
const deckView = (target) => `file:///C:/Program%20Files/Lumen/resources/app/src/renderer/slides.html?u=${encodeURIComponent(target)}`;
const isWebUrl = (u) => /^https?:\/\//i.test(u);

// ---- identity
{
  const local = fileTabs.identify(pdfView(fileUrl('C:\\Users\\sam\\Documents\\Northeastern\\ME 2350\\Lecture 05 - Entropy.pdf')), { title: 'Lecture 05 - Entropy.pdf' });
  check('a local PDF in the viewer is a file tab with its real name, folder and type', local && local.kind === 'pdf' && local.local && local.name === 'Lecture 05 - Entropy.pdf' && local.folder === 'ME 2350' && local.typeName === 'PDF', JSON.stringify(local));
  check('its title is the file name tidied, with the folder that names its subject', local.title === 'Lecture 05 Entropy - ME 2350' && /ME 2350/.test(local.title), local.title);
  check('the address the topic stage sees has no viewer scheme, drive, user name or extension', local.topicUrl === 'file:///ME%202350/Lecture%2005%20-%20Entropy' && !/lumen-pdf|Users|sam|\.pdf/.test(local.topicUrl), local.topicUrl);

  const own = fileTabs.identify(pdfView(fileUrl('C:\\Users\\sam\\Downloads\\Report.pdf')), { title: 'Q3 Planning Review' });
  check('a PDF that carries its own title is shown by it, the file name rides in the words', own.title === 'Q3 Planning Review' && /Report/.test(own.topicText), JSON.stringify(own));
  const junk = fileTabs.identify(pdfView(fileUrl('C:\\Users\\sam\\Downloads\\lecture3.pdf')), { title: 'Microsoft Word - lecture3.docx' });
  check('a title that is only the tool that made the file is not a title', junk.title === 'lecture3', junk.title);
  check('a downloads folder is no subject: no folder words, grouped by type', junk.genericFolder && !/Downloads/.test(junk.topicUrl) && junk.groupKey === 'file:type:pdfs' && junk.groupName === 'PDFs', JSON.stringify(junk));

  const web = fileTabs.identify(pdfView('https://arxiv.org/pdf/1706.03762'), { title: 'Attention Is All You Need' });
  check('a web PDF keeps its own address (its site is evidence) and is no local file', web && !web.local && web.topicUrl === 'https://arxiv.org/pdf/1706.03762' && web.groupKey === '' && web.title === 'Attention Is All You Need', JSON.stringify(web));
  check('a PDF address on the web is a file tab even outside the viewer; a page about code is not', fileTabs.identify('https://x.example/a/paper.pdf').kind === 'pdf' && fileTabs.identify('https://github.com/a/b/blob/main/app.py') === null && fileTabs.identify('https://example.com/') === null);

  const deck = fileTabs.identify(deckView(fileUrl('C:\\Users\\sam\\Documents\\CS 3500\\polymorphism-week7.pptx')), { title: 'polymorphism-week7.pptx' });
  check('a deck in the slide viewer is a Slides file of its own file, not the viewer page', deck && deck.kind === 'slides' && deck.name === 'polymorphism-week7.pptx' && deck.folder === 'CS 3500' && /slides\.html/.test(deck.address) === false, JSON.stringify(deck));
  check("Lumen's own pages (new tab, settings) are not files", fileTabs.identify('file:///C:/Program%20Files/Lumen/resources/app/src/renderer/newtab.html') === null && fileTabs.addressOf('file:///C:/app/src/renderer/slides.html') === '');

  const readme = fileTabs.identify(fileUrl('C:\\Users\\sam\\dev\\billing-service\\README.md'), { title: 'README.md' });
  check('a file with a bare name takes its folder as its subject', readme.kind === 'text' && /^README - billing service$/.test(readme.title), readme.title);
  const nested = fileTabs.identify(fileUrl('C:\\Users\\sam\\Documents\\Northeastern\\ME 2350\\Week 6\\Homework\\hw6.pdf'));
  check('folders that only sort a course ("Week 6", "Homework") do not name it', nested.folder === 'Homework' && nested.groupName === 'ME 2350' && /ME 2350/.test(nested.title), JSON.stringify([nested.folder, nested.groupName, nested.title]));
  const img = fileTabs.identify(fileUrl('C:\\Users\\sam\\Pictures\\IMG_2231.jpg'), { title: 'IMG_2231.jpg (3024×4032)' });
  check("an image's size is not part of its name", img.kind === 'image' && img.title === 'IMG 2231' && img.groupName === 'Images', JSON.stringify(img));
  check('icons: pdf, slides, image, code, other files; none for a web page', fileTabs.iconKind(pdfView(fileUrl('C:\\a.pdf'))) === 'pdf' && fileTabs.iconKind(fileUrl('C:\\a.py')) === 'code' && fileTabs.iconKind(fileUrl('C:\\a.zip')) === 'file' && fileTabs.iconKind(fileUrl('C:\\a.png')) === 'image' && fileTabs.iconKind('https://example.com/') === '' && fileTabs.iconKind(deckView(fileUrl('C:\\a.pptx'))) === 'slides');
  check('a hand-made group from a file tab is named for its folder or its type', fileTabs.nameFor(pdfView(fileUrl('C:\\Users\\sam\\Physics\\a.pdf'))) === 'Physics' && fileTabs.nameFor(fileUrl('C:\\Users\\sam\\Downloads\\a.csv')) === 'Files' && fileTabs.nameFor('https://example.com/') === '');
}

// ---- reading the first lines of a text file
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-file-tabs-'));
  try {
    const note = path.join(dir, 'notes.txt');
    fs.writeFileSync(note, `${'Lab 3 strategy pattern notes. '.repeat(200)}`);
    const head = await fileTabs.readTextHead(pathToUrl(note));
    check('the first words of a text file are read: a short snippet, never the file', head.startsWith('Lab 3 strategy') && head.length <= 300, String(head.length));
    const bin = path.join(dir, 'data.txt');
    fs.writeFileSync(bin, Buffer.from([0x50, 0x4b, 0, 3, 4, 0, 0, 1]));
    check('a binary file is read as nothing', (await fileTabs.readTextHead(pathToUrl(bin))) === '');
    const pdf = path.join(dir, 'a.pdf');
    fs.writeFileSync(pdf, 'not read here');
    check('only text and code files are read from disk (a PDF is read by the viewer)', (await fileTabs.readTextHead(pathToUrl(pdf))) === '' && (await fileTabs.readTextHead('https://example.com/a.txt')) === '');
    check('a missing file is nothing, not an error', (await fileTabs.readTextHead(pathToUrl(path.join(dir, 'gone.txt')))) === '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  rest();
})();
function pathToUrl(p) { return require('url').pathToFileURL(p).href; }

function rest() {
  // ---- Organize sees file tabs
  const win = (specs, { mode = 'topic', fileTextOk } = {}) => {
    let tabs = [];
    const g = tg.createTabGroups({
      getTabs: () => tabs, setTabs: (l) => { tabs = l; },
      urlOf: (t) => t.url, titleOf: (t) => t.title, textOf: (t) => t.text || '', isWeb: isWebUrl, mode: () => mode, aiTopics: () => false, fileTextOk,
    });
    specs.forEach(([title, url, extra = {}], i) => tabs.push({ id: i + 1, title, url, groupId: null, ...extra }));
    return { g, tabs: () => tabs };
  };
  const PDFS = ['Cabinet quote.pdf', 'Contractor estimate.pdf', 'Tile order.pdf'].map((n) => [n, pdfView(fileUrl(`C:\\Users\\sam\\Downloads\\${n}`))]);
  {
    const w = win(PDFS);
    check('file tabs are organizable (they were skipped: a viewer address is no web page)', w.g.organizableCount() === 3 && w.g.candidates().length === 3 && w.g.organizeCounts().web === 3);
    const e = w.g.candidates()[0];
    check('an entry shows the file, not the viewer: its name, no viewer address, a file record', e.file && e.file.kind === 'pdf' && e.file.name === 'Cabinet quote.pdf' && !/lumen-pdf/.test(e.url) && e.title === 'Cabinet quote', JSON.stringify(e));
  }
  {
    const w = win(PDFS, { mode: 'site' });
    check('by site: three PDFs in Downloads make one group, "PDFs", not the viewer\'s "App"', w.g.autoGroup() && w.g.state().length === 1 && w.g.state()[0].name === 'PDFs', JSON.stringify(w.g.state()));
    w.tabs().push({ id: 9, title: 'Invoice.pdf', url: pdfView(fileUrl('C:\\Users\\sam\\Downloads\\Invoice.pdf')), groupId: null });
    w.g.autoGroup();
    check('by site: a later PDF joins it', w.tabs().filter((t) => t.groupId).length === 4);
  }
  {
    const physics = ['Lecture 1.pdf', 'Lecture 2.pdf', 'Problem set.pdf'].map((n) => [n, fileUrl(`C:\\Users\\sam\\Downloads\\Physics\\${n}`)]);
    const w = win([...physics, ...PDFS, ['IMG.png', fileUrl('C:\\Users\\sam\\Downloads\\IMG.png')]], { mode: 'site' });
    w.g.autoGroup();
    const names = w.g.state().map((g) => g.name).sort();
    check('by site: files in a folder that names a subject group by it ("Physics"), the rest by type', names.join() === 'PDFs,Physics', names.join());
  }
  {
    const web = ['a', 'b', 'c'].map((n) => [`Paper ${n}`, pdfView(`https://arxiv.org/pdf/2001.0${n.charCodeAt(0)}.pdf`)]);
    const w = win(web, { mode: 'site' });
    w.g.autoGroup();
    check('by site: web PDFs group by the site they came from, named for it', w.g.state().length === 1 && w.g.state()[0].name === 'arXiv', JSON.stringify(w.g.state()));
  }
  {
    // Loose tabs on different sites that are files stay loose (no lump called PDFs) in topic mode.
    const w = win([['Boarding pass.pdf', pdfView(fileUrl('C:\\Users\\sam\\Downloads\\boarding-pass.pdf'))], ['Receipt.pdf', pdfView(fileUrl('C:\\Users\\sam\\Downloads\\receipt-4411.pdf'))], ['Menu.pdf', pdfView(fileUrl('C:\\Users\\sam\\Downloads\\menu.pdf'))], ['Gmail', 'https://mail.google.com/mail/u/0/#inbox']]);
    check('by topic: unrelated PDFs from Downloads are not lumped together', w.g.organizeByTopic() === 0 && w.tabs().every((t) => !t.groupId), JSON.stringify(w.tabs().map((t) => t.groupId)));
  }

  // ---- the eval sessions: a lecture's PDF joins the course, and no existing score drops
  // How these sessions scored on main before file tabs were organized (every file tab was skipped: measured by running these sessions against main's tab-groups.js).
  const BEFORE = { recall: [0.10, 0.06, 0.00, 0.00], f1: [0.16, 0.11, 0.00, 0.00] };
  {
    let after = 0;
    fixtures.files.forEach((s, i) => {
      const a = run.runSession(tg, s, false);
      after += a.f1;
      check(`eval ${s.name}: precision ${a.precision.toFixed(2)}, no tab that should stay loose is grouped`, a.precision >= 0.99 && a.wronglyGroupedLoose === 0, JSON.stringify(a));
      check(`eval ${s.name}: recall ${a.recall.toFixed(2)} (was ${BEFORE.recall[i].toFixed(2)})`, a.recall >= 0.5 && a.recall > BEFORE.recall[i] + 0.4, `${a.recall}`);
    });
    const n = fixtures.files.length;
    check(`eval files: average F1 ${(after / n).toFixed(2)} (was ${(BEFORE.f1.reduce((x, y) => x + y, 0) / n).toFixed(2)})`, after / n >= 0.85, String(after / n));
    const course = run.runSession(tg, fixtures.files[0], false);
    check("eval: a course's lecture PDF, slides and a download named with its code join its Canvas and Gradescope tabs, apart from the other courses", course.recall === 1 && course.precision === 1, JSON.stringify(course));
  }

  // ---- what a model is sent
  {
    const secret = 'C:\\Users\\sam\\Documents\\Taxes 2025\\W-2.pdf';
    const specs = [
      ['W-2_2025.pdf', pdfView(fileUrl(secret)), { text: 'Form W-2 Wage and Tax Statement. SSN 123-45-6789 employer identification number. '.repeat(10) }],
      ['notes.txt', fileUrl('C:\\Users\\sam\\Documents\\Taxes 2025\\notes.txt'), { text: 'filing deadline reminder' }],
      ['Gmail', 'https://mail.google.com/mail/u/0/#inbox'],
    ];
    const w = win(specs);
    const [pdfEntry] = w.g.candidates();
    const wire = oai.buildWire({ groups: [], leftovers: w.g.candidates() });
    const text = JSON.stringify(wire);
    check('the wire names a file and its folder, with a short snippet', /W-2/.test(text) && /file:Taxes 2025/.test(text) && /PDF: /.test(text), text);
    check('the wire never carries a path, a drive, the viewer address or more than a short snippet', !/Users|sam|C:|lumen-pdf|\.pdf|Documents/.test(text) && wire.u['file:Taxes 2025'].every(([, , d]) => !d || d.length <= 80), text);
    check("a file's full text is never in a request: the snippet is clipped, and the entry holds more than is sent", pdfEntry.aiText.length > 80 && !text.includes(pdfEntry.aiText.slice(0, 100)) && !/123-45-6789/.test(text), text);

    const off = win(specs, { fileTextOk: () => false });
    const noText = JSON.stringify(oai.buildWire({ groups: [], leftovers: off.g.candidates() }));
    check('with AI off for the file its text is not sent (the name still groups it locally)', !/Wage|filing deadline|123-45/.test(noText) && /PDF/.test(noText) && off.g.candidates()[0].text.includes('Wage'), noText);

    // Many folders: the per-request limit on what is described (the same as for sites asked about).
    const many = [];
    for (let i = 0; i < oai.MAX_HINT_HOSTS + 10; i++) many.push([`Doc ${i} budget plan.pdf`, fileUrl(`C:\\Users\\sam\\Projects\\Folder ${i}\\Doc ${i}.pdf`)]);
    const big = oai.buildWire({ groups: [], leftovers: win(many).g.candidates() });
    check(`at most ${oai.MAX_HINT_HOSTS} folders of files in one request`, Object.keys(big.u).length === oai.MAX_HINT_HOSTS, String(Object.keys(big.u).length));
  }

  // The whole flow with a fake model: tabs that are off never reach it.
  (async () => {
    const specs = [
      ['Lecture 5 Entropy.pdf', pdfView(fileUrl('C:\\Users\\sam\\ME 2350\\Lecture 5.pdf')), { text: 'Entropy and the second law' }],
      ['Private diagnosis.pdf', pdfView(fileUrl('C:\\Users\\sam\\Medical\\Private diagnosis.pdf')), { text: 'secret clinic results' }],
      ['Spotify', 'https://open.spotify.com/'],
      ['Notes on quantum fields', fileUrl('C:\\Users\\sam\\Physics\\qft.md'), { text: 'path integral' }],
      ['Another quantum paper', fileUrl('C:\\Users\\sam\\Physics\\qft2.md'), { text: 'path integral' }],
    ];
    const w = win(specs);
    const asked = [];
    const stats = await oai.organizeProgressive({
      tabGroups: w.g, alwaysAsk: true, skipId: (id) => id === 2,
      ask: async (wire) => { asked.push(JSON.stringify(wire)); return { n: [], p: [], g: [], m: [], h: [] }; },
    });
    const sent = asked.join(' ');
    check('Organize with AI: a file tab AI is off for is not described at all', !/Private diagnosis|secret clinic|Medical/.test(sent), sent);
    check('Organize with AI: other file tabs are described by name', stats.requests === 0 || /Lecture 5|quantum/i.test(sent), sent);
  })().then(() => {
    // ---- AI off for sites and local files
    let saved = {};
    const sites = createAiSites({ readSettings: () => ({ ...saved }), writeSettings: (v) => { saved = v; } });
    sites.set('arxiv.org', true);
    check('AI off for a site covers its PDFs in the viewer', sites.isOff(pdfView('https://arxiv.org/pdf/1706.03762')) && !sites.isOff(pdfView('https://other.example/a.pdf')) && !sites.isOff(pdfView(fileUrl('C:\\a.pdf'))));
    sites.set('local files', true);
    check('AI off for local files covers a PDF, a deck and a text file from disk, not the app\'s own pages', sites.isOff(pdfView(fileUrl('C:\\Users\\sam\\a.pdf'))) && sites.isOff(deckView(fileUrl('C:\\Users\\sam\\a.pptx'))) && sites.isOff(fileUrl('C:\\Users\\sam\\a.txt')) && !sites.isOff('file:///C:/app/src/renderer/newtab.html'), JSON.stringify(saved));
    check('and nothing else changed about web pages', siteOf('https://mail.example.co.uk/x') === 'example.co.uk');
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
  });
}
