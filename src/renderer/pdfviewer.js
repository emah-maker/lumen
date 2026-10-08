// Lumen's PDF viewer page (features/pdf-viewer.js): pdf.js (vendor/pdfjs) drawing the document named in the address (?u=<address>)
// into a normal scrolling page: canvases for the pages, a real text layer (selection, copy, the page's own find) and real links.
// The bytes come from lumen-pdf://app/data?u=… (Lumen fetches them with the tab's session and answers byte ranges).
import * as pdfjsLib from '/vendor/pdf.min.mjs';

globalThis.pdfjsLib = pdfjsLib; // pdf_viewer.mjs reads it at load
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
const { EventBus, PDFViewer, PDFLinkService, PDFFindController, LinkTarget } = await import('/vendor/web/pdf_viewer.mjs');

const $ = (id) => document.getElementById(id);
const container = $('viewerContainer');
const params = new URL(location.href).searchParams;
const source = params.get('u') || '';
const base = source.split('#')[0];
const fragment = new URLSearchParams(source.includes('#') ? source.slice(source.indexOf('#') + 1) : '');

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.SELF, externalLinkRel: 'noopener noreferrer' });
const findController = new PDFFindController({ linkService, eventBus });
const viewer = new PDFViewer({ container, viewer: $('viewer'), eventBus, linkService, findController, textLayerMode: 1, removePageBorders: true });
linkService.setViewer(viewer);

const say = (text) => { const el = $('message'); el.textContent = text || ''; el.hidden = !text; };
const nameOf = () => { try { return decodeURIComponent(new URL(base).pathname.split('/').pop() || '') || 'PDF'; } catch { return 'PDF'; } };
document.title = nameOf();
$('name').textContent = nameOf();

// ---- zoom
const ZOOMS = ['page-width', 'page-fit', 'auto', '0.5', '0.75', '1', '1.25', '1.5', '2', '3', '4'];
function showScale() {
  const select = $('zoom');
  const value = viewer.currentScaleValue;
  if (ZOOMS.includes(String(value))) { select.value = String(value); return; }
  const custom = $('zoomCustom');
  custom.hidden = false;
  custom.textContent = `${Math.round(viewer.currentScale * 100)}%`;
  select.value = 'custom';
}
eventBus.on('scalechanging', showScale);
$('zoom').addEventListener('change', (e) => { if (e.target.value !== 'custom') viewer.currentScaleValue = e.target.value; });
const zoomIn = () => viewer.increaseScale({ steps: 1 });
const zoomOut = () => viewer.decreaseScale({ steps: 1 });
const zoomReset = () => { viewer.currentScaleValue = '1'; };
$('zoomIn').addEventListener('click', zoomIn);
$('zoomOut').addEventListener('click', zoomOut);
// Ctrl+wheel (and a trackpad pinch, which arrives the same way) zooms the document, not the page around it.
container.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (e.deltaY < 0) zoomIn(); else if (e.deltaY > 0) zoomOut();
}, { passive: false });

// ---- pages
const pageBox = $('pageNumber');
eventBus.on('pagechanging', ({ pageNumber }) => { pageBox.value = String(pageNumber); $('prev').disabled = pageNumber <= 1; $('next').disabled = pageNumber >= viewer.pagesCount; });
$('prev').addEventListener('click', () => viewer.previousPage());
$('next').addEventListener('click', () => viewer.nextPage());
pageBox.addEventListener('change', () => {
  const n = Math.round(Number(pageBox.value));
  if (Number.isFinite(n) && n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n; else pageBox.value = String(viewer.currentPageNumber);
});
pageBox.addEventListener('focus', () => pageBox.select());

// ---- find
const findBar = $('findBar');
const findInput = $('findInput');
function openFind() { findBar.hidden = false; findInput.focus(); findInput.select(); if (findInput.value) runFind(''); }
function closeFind() { findBar.hidden = true; eventBus.dispatch('findbarclose', { source: window }); container.focus(); }
function runFind(type) {
  eventBus.dispatch('find', { source: window, type, query: findInput.value, caseSensitive: $('findCase').checked, entireWord: false, highlightAll: true, findPrevious: type === 'again' ? runFind.back : false, matchDiacritics: false });
}
findInput.addEventListener('input', () => runFind(''));
$('findCase').addEventListener('change', () => runFind('casesensitivitychange'));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runFind.back = e.shiftKey; runFind('again'); } else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('findNext').addEventListener('click', () => { runFind.back = false; runFind('again'); });
$('findPrev').addEventListener('click', () => { runFind.back = true; runFind('again'); });
$('findClose').addEventListener('click', closeFind);
$('findButton').addEventListener('click', openFind);
const showCount = ({ matchesCount }) => {
  const { current, total } = matchesCount || {};
  $('findCount').textContent = !findInput.value ? '' : total ? `${current} of ${total}` : 'No matches';
};
eventBus.on('updatefindmatchescount', ({ matchesCount }) => showCount({ matchesCount }));
eventBus.on('updatefindcontrolstate', ({ matchesCount, state }) => { showCount({ matchesCount }); findInput.classList.toggle('notfound', state === 1); });

// ---- keys the page itself doesn't scroll for
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); } else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomIn(); } else if (mod && e.key === '-') { e.preventDefault(); zoomOut(); } else if (mod && e.key === '0') { e.preventDefault(); zoomReset(); } else if (e.key === 'Escape' && !findBar.hidden) closeFind();
  else if (!mod && !e.altKey && document.activeElement && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && ['Home', 'End', 'PageUp', 'PageDown', ' ', 'ArrowUp', 'ArrowDown'].includes(e.key)) container.focus({ preventScroll: true }); // keys go to the scroller
});

// ---- save, print
$('download').addEventListener('click', () => { $('download').href = `/data?${new URLSearchParams({ u: base, dl: '1' })}`; });
$('print').addEventListener('click', () => window.lumenPdfHost?.print());

// ---- open
const password = $('password');
let pendingPassword = null;
password.addEventListener('submit', (e) => { e.preventDefault(); if (!pendingPassword) return; const cb = pendingPassword; pendingPassword = null; password.hidden = true; cb($('passwordInput').value); $('passwordInput').value = ''; });

async function open() {
  if (!source) { say('There is no PDF in this address.'); return; }
  say('Opening…');
  const task = pdfjsLib.getDocument({
    url: `/data?${new URLSearchParams({ u: base })}`,
    cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/', wasmUrl: '/vendor/wasm/', iccUrl: '/vendor/iccs/',
    isEvalSupported: false, enableXfa: false,
  });
  task.onPassword = (update, reason) => {
    say('');
    $('passwordText').textContent = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? 'That password is not right. Try again.' : 'This PDF is password protected.';
    pendingPassword = update;
    password.hidden = false;
    $('passwordInput').focus();
  };
  let doc;
  try { doc = await task.promise; } catch (err) {
    say(err && err.name === 'PasswordException' ? 'This PDF needs its password.' : err && err.name === 'MissingPDFException' ? 'The PDF could not be found. It may have been moved or deleted.' : 'This PDF could not be opened. It may be damaged, or not a PDF.');
    return;
  }
  say('');
  viewer.setDocument(doc);
  linkService.setDocument(doc, null);
  $('pageCount').textContent = `/ ${doc.numPages}`;
  $('prev').disabled = true;
  $('next').disabled = doc.numPages < 2;
  doc.getMetadata().then(({ info }) => { const title = String((info && info.Title) || '').trim(); if (title) { document.title = title; $('name').textContent = title; $('name').title = title; } }).catch(() => {});
  eventBus.on('pagesinit', () => {
    const z = fragment.get('zoom');
    const zoomValue = z && /^\d+(\.\d+)?$/.test(z.split(',')[0]) ? String(Number(z.split(',')[0]) / 100) : z === 'page-fit' || z === 'page-width' ? z : 'page-width';
    viewer.currentScaleValue = zoomValue;
    const page = Number(fragment.get('page'));
    if (Number.isInteger(page) && page >= 1 && page <= doc.numPages) viewer.currentPageNumber = page;
    showScale();
    container.focus({ preventScroll: true });
  });
}

// What main.js's keyboard handling and the AI's tools call (the page has no IPC of its own).
window.lumenPdf = {
  find: openFind, zoomIn, zoomOut, zoomReset,
  state: () => ({ page: viewer.currentPageNumber, pages: viewer.pagesCount, scale: viewer.currentScale, scrollTop: Math.round(container.scrollTop), scrollMax: Math.max(0, container.scrollHeight - container.clientHeight), height: container.clientHeight }),
};
open();
