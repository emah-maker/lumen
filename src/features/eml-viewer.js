// ---------- the email viewer: saved emails (.eml) shown in a tab ----------
// Built like the slide viewer (slides-viewer.js): one of Lumen's own pages (renderer/eml.html) loaded in an ordinary tab. Once it has
// loaded, the main process reads the file named in its address (?u=<file: URL of an .eml>), parses it (features/eml.js) and hands the
// page plain JSON with executeJavaScript. The page sanitizes the HTML body and shows it in a sandboxed iframe (no scripts, strict CSP,
// remote images blocked until the user asks); see renderer/eml.js. Web pages can't navigate to file:// pages, so they can't open it.
//
// How an .eml gets here: a local .eml opened in a tab (typed path, File > Open, drag and drop, a file: link, "Open with" or the command
// line) is swapped for the viewer as the navigation starts (Chromium would show the raw text or download it); a download of one is cancelled
// and the tab shows the viewer instead (openInPlace). An .eml downloaded from
// the web (an attachment in web mail) is saved as usual, then opens in a new tab; so does a click on it in the downloads panel.
// The page's only host calls (permissions-preload.js) are bytes(i) (to Save an attachment through the normal download path) and
// open(i) (a safe type opens in a new tab from a temporary copy; nothing is ever run).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const eml = () => require('./eml'); // loaded when an email is first read (it pulls in postal-mime): not at startup
const isEmlName = (name) => /\.eml$/i.test(String(name || '').split(/[?#]/)[0]);

const VIEWER_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'eml.html')).href;

const bareOf = (url) => String(url || '').split(/[?#]/)[0];
const isViewerUrl = (url) => typeof url === 'string' && bareOf(url).toLowerCase() === VIEWER_URL.toLowerCase();
const isLocalEml = (url) => { try { const u = new URL(url); return u.protocol === 'file:' && isEmlName(u.pathname); } catch { return false; } };
function emlUrlOf(url) {
  if (!isViewerUrl(url)) return null;
  try { const u = new URL(url).searchParams.get('u') || ''; return isLocalEml(u) ? u : null; } catch { return null; }
}
const viewerUrl = (emlUrl) => `${VIEWER_URL}?${new URLSearchParams({ u: emlUrl })}`;
const displayUrl = (url) => emlUrlOf(url) || '';

// A download Chromium starts for a local .eml opened in a tab: show it instead.
const shouldOpenInPlace = ({ url, filename } = {}) => isLocalEml(url) && isEmlName(filename || url);
// A finished download from the web: open it, unless the user chose Save As for it.
const shouldOpenFinished = ({ path: file, saveAs } = {}) => Boolean(file) && !saveAs && isEmlName(file);

const nameOf = (url) => { try { return path.basename(fileURLToPath(url)).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120); } catch { return 'Email'; } };

// The last emails read (Reload, Back, the attachment buttons): keyed by path, size and time.
const CACHE = new Map();
const CACHE_MAX = 3;
async function load(emlUrl) {
  let file;
  try { file = fileURLToPath(emlUrl); } catch { return { error: 'This address is not a file.' }; }
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return { error: 'The file could not be found. It may have been moved or deleted.' }; }
  if (!stat.isFile()) return { error: 'This is not a file.' };
  if (stat.size > eml().MAX_FILE_BYTES) return { error: 'This email is too large to open here.' };
  const key = `${file.toLowerCase()}|${stat.size}|${stat.mtimeMs}`;
  if (CACHE.has(key)) return CACHE.get(key);
  let parsed;
  try { parsed = await eml().parse(await fs.promises.readFile(file)); } catch (err) { return { error: err instanceof eml().EmlError ? err.message : 'The email could not be read.' }; }
  CACHE.set(key, parsed);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return parsed;
}

// The email as text for the AI (read_page on the viewer, list_files read): undefined error text on failure.
async function loadText(emlUrl, opts) {
  const parsed = await load(emlUrl);
  if (parsed.error) throw new (eml().EmlError)(parsed.error);
  return eml().toText(parsed, opts);
}

const TEMP_FILES = [];
// Write attachment `index` of the email to a private temp folder and return its path ('' if there is none or it is not a safe type).
async function tempCopy(emlUrl, index, tmpRoot = os.tmpdir()) {
  const parsed = await load(emlUrl);
  const a = parsed.model && parsed.model.attachments[index];
  if (!a || !a.openable) return '';
  const dir = await fs.promises.mkdtemp(path.join(tmpRoot, 'lumen-eml-'));
  const file = path.join(dir, eml().safeName(a.name));
  await fs.promises.writeFile(file, parsed.parts[index], { mode: 0o600 });
  TEMP_FILES.push(dir);
  return file;
}
function cleanTemp() { for (const dir of TEMP_FILES.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); }

function create() {
  async function render(wc, url) {
    const emlUrl = emlUrlOf(url);
    const data = emlUrl ? await load(emlUrl) : { error: 'Only email files (.eml) on this computer can be shown here.' };
    if (wc.isDestroyed() || wc.getURL() !== url) return;
    const payload = data.error ? { name: emlUrl ? nameOf(emlUrl) : 'Email', error: data.error } : { name: nameOf(emlUrl), ...data.model };
    wc.executeJavaScript(`window.lumenEml && window.lumenEml(${JSON.stringify(payload)})`).catch(() => {});
  }
  function attach(tab) {
    const wc = tab.view.webContents;
    wc.on('did-finish-load', () => { const url = wc.getURL(); if (isViewerUrl(url)) render(wc, url); });
    // A file: address of an .eml (typed, dropped on the page, a link): Chromium would show message/rfc822 as raw text, or download it. The viewer takes
    // its place before the raw file loads (a tick later, as the PDF viewer does: a load started inside the navigation event is cancelled with it).
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || !isLocalEml(details.url)) return;
      setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL(viewerUrl(details.url)).catch(() => {}); });
    });
  }
  function openInPlace(wc, url) {
    if (!wc || wc.isDestroyed() || !isLocalEml(url)) return false;
    // (a tick later: the download that brought us here is still being cancelled, and a load started inside it can be aborted with it)
    setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL(viewerUrl(url)).catch(() => {}); });
    return true;
  }
  return { attach, openInPlace };
}

module.exports = { create, VIEWER_URL, isViewerUrl, emlUrlOf, viewerUrl, displayUrl, isLocalEml, shouldOpenInPlace, shouldOpenFinished, load, loadText, tempCopy, cleanTemp, nameOf };
