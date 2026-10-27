// [save as pdf] screenshot pdf:true (ai/page-pdf.js, agent.js savePdf): the tab printed to a PDF in Downloads under its title, never over another
// file, and attached to the chat for upload_file; refused while planning and to helpers; the tool list keeps its size. Plain Node: no Electron.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePagePdf, pdfName } = require('../../src/ai/page-pdf');
const { createUploadStore } = require('../../src/features/upload-files');
const { Agent, requestFor, DEFAULT_MODEL, EXTERNAL_TOOLS } = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n%%EOF');
const fakeWc = (over = {}) => {
  const wc = { calls: 0, getURL: () => 'https://bnrordsp.neu.edu/ssb-prod/bwskotrn.P_ViewTran', getTitle: () => 'Unofficial Transcript | Banner', isDestroyed: () => false, async printToPDF(options) { wc.calls++; wc.options = options; return PDF; }, ...over };
  return wc;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagepdf-units-'));
  const downloads = path.join(dir, 'Downloads');

  check('name: the title, made safe for a file name', pdfName('Unofficial Transcript | Banner') === 'Unofficial Transcript - Banner.pdf' && pdfName('a/b:c*?"<>') === 'a b c.pdf', pdfName('a/b:c*?"<>'));
  check('name: no title is the site, then "Page"', pdfName('', 'https://www.example.com/x') === 'example.com.pdf' && pdfName('', '') === 'Page.pdf');
  check('name: a long title is cut', pdfName('x'.repeat(300)).length <= 84);

  {
    const wc = fakeWc();
    const noted = [];
    const out = await savePagePdf(wc, { dir: downloads, onSaved: (f) => noted.push(f) });
    const file = path.join(downloads, 'Unofficial Transcript - Banner.pdf');
    check('save: printed with backgrounds, written to Downloads under the title', wc.options.printBackground === true && fs.existsSync(file) && fs.readFileSync(file).equals(PDF), out);
    check('save: the answer names the file and the page count', out.includes(file) && /2 pages/.test(out), out);
    check('save: the file goes on the Recent list', noted.length === 1 && noted[0] === file);
    check('save: no chat, nothing attached', !/file ref/.test(out), out);
    const again = await savePagePdf(fakeWc(), { dir: downloads });
    check('save: a second save never overwrites the first', again.includes('Unofficial Transcript - Banner (2).pdf') && fs.readFileSync(file).equals(PDF), again);
  }

  {
    const uploads = createUploadStore({ dir: path.join(dir, 'uploads') });
    const chatId = 'a1b2c3d4e5f60718';
    const out = await savePagePdf(fakeWc(), { dir: downloads, uploads, chatId });
    const ref = (out.match(/file ref (\S+?):/) || [])[1];
    const held = ref ? uploads.resolve(chatId, [ref])[0] : null;
    check('chat: the PDF is attached to the chat, and upload_file takes its ref', held && held.type === 'application/pdf' && fs.readFileSync(held.path).equals(PDF) && /upload_file files:\["/.test(out), out);
    check('chat: another chat cannot use the ref', (() => { try { uploads.resolve('ffffffffffffffff', [ref]); return false; } catch { return true; } })());
  }

  {
    let tries = 0;
    const flaky = fakeWc({ async printToPDF() { tries++; if (tries === 1) throw new Error('Printing failed'); return PDF; } });
    const out = await savePagePdf(flaky, { dir: downloads });
    check('save: a page still settling is printed again once', tries === 2 && /Saved/.test(out), out);
    const bad = async (wc, opts) => { try { await savePagePdf(wc, opts); return ''; } catch (err) { return err.message; } };
    check('save: only web pages and files', /Only web pages/.test(await bad(fakeWc({ getURL: () => 'lumen://settings' }), { dir: downloads })));
    check('save: an empty print is refused', /empty PDF/.test(await bad(fakeWc({ printToPDF: async () => Buffer.alloc(0) }), { dir: downloads })));
  }

  {
    const agent = new Agent({ knownFolder: (n) => (n === 'downloads' ? downloads : dir), noteFile: () => {} });
    const out = await agent.savePdf(fakeWc({ getTitle: () => 'From the agent' }));
    check('agent: savePdf saves to the Downloads folder the app names', out.includes(path.join(downloads, 'From the agent.pdf')), out);
  }

  {
    const planMode = require('../../src/ai/plan-mode');
    const planToolError = planMode.planToolError || planMode.createPlanMode?.().planToolError;
    check('plan mode: a screenshot is fine, a PDF save is refused', typeof planToolError === 'function' && planToolError('screenshot', {}) === null && /Plan mode/.test(planToolError('screenshot', { pdf: true }) || ''));
  }

  {
    const m = Object.assign([{ role: 'user', content: 'hi' }], { settings: { model: DEFAULT_MODEL } });
    const tools = requestFor(m.settings, m).tools;
    const shot = tools.find((t) => t.name === 'screenshot');
    check('tool: screenshot offers pdf, in one short line', shot.input_schema.properties.pdf?.type === 'boolean' && /pdf:true/.test(shot.description) && shot.description.length < 70, shot.description);
    check('tool: the outside agents and CLI engines see pdf too', EXTERNAL_TOOLS.find((t) => t.name === 'screenshot')?.input_schema.properties.pdf?.type === 'boolean');
  }

  {
    const src = fs.readFileSync(path.join(__dirname, '../../src/ai/agent.js'), 'utf8');
    check('helpers: neither helper kind is shown pdf, and a helper call is refused', /delete properties\.pdf; \/\/ \[save as pdf\] a helper only reads/.test(src) && /delete properties\.tab_id; delete properties\.pdf;/.test(src) && /scope\?\.helper\) throw new Error\('A helper cannot save files/.test(src));
    const en = require('../../src/locales/en.json');
    check('step: the chat says "Saving the page as a PDF"', en['tool.savePdf'] === 'Saving the page as a PDF' && /tool\.savePdf/.test(fs.readFileSync(path.join(__dirname, '../../src/renderer/chat-core.js'), 'utf8')));
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
