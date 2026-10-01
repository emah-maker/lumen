// Tab sleeping's pure decisions (main.js does the Electron parts; test/tab-sleep-units.js runs this).
// Kept here: may this tab be put to sleep, what must the page itself say first, and how does a woken
// tab get its page back (restore the saved back/forward list, or just load the address).
'use strict';

// Why a tab must stay loaded, or null when nothing in `f` says so. `f` is plain facts read by main.js:
// { alive, sleeping, active, settings, closing, unloadAsked, openPopups, agentUsing, aiLock, webPage,
//   loading, audible, fullscreen, devTools, capturing }. Any doubt keeps the tab.
function keepReason(f) {
  if (!f || !f.alive) return 'dead';
  if (f.sleeping) return 'sleeping';
  if (f.active) return 'active';
  if (f.settings) return 'settings';
  if (f.closing || f.unloadAsked) return 'closing';
  if (f.openPopups > 0) return 'popups'; // a sign-in popup talks back to this page
  if (f.agentUsing || f.aiLock) return 'ai';
  if (!f.webPage) return 'internal';
  if (f.loading) return 'loading';
  if (f.audible) return 'audio';
  if (f.fullscreen) return 'fullscreen';
  if (f.devTools) return 'devtools';
  if (f.capturing) return 'capturing'; // screen share / camera / recording
  return null;
}

// Run in the page (an isolated world, so the page can't see or fake it). Resolves to a reason string
// when this page must not be discarded, else ''. Covers what Chrome's memory saver avoids: typed
// input (a field, a rich-text composer), a reply still streaming in (an AI chat: the page keeps
// changing with no load in progress, or shows a Stop button / busy region), a playing video or audio
// element, a chosen upload. The "still growing" test samples the page's text twice `sampleMs` apart.
function pageBusyScript(sampleMs = 1200) {
  return `(async () => {
    const dirty = (el) => (el.matches('input,textarea') ? !/^(checkbox|radio|button|submit|reset|hidden|file|image|range|color)$/i.test(el.type || '') && el.value !== (el.defaultValue ?? '') : el.isContentEditable && el.textContent.trim() !== '');
    if ([...document.querySelectorAll('input,textarea,[contenteditable=""],[contenteditable=true],[contenteditable=plaintext-only]')].some(dirty)) return 'input';
    if ([...document.querySelectorAll('input[type=file]')].some((el) => el.files && el.files.length)) return 'upload';
    if ([...document.querySelectorAll('video,audio')].some((m) => !m.paused && !m.ended)) return 'media';
    const stop = /^\\s*(stop|stop (generating|streaming|response|responding|answering)|cancel)\\s*$/i;
    const control = [...document.querySelectorAll('button,[role=button]')].find((b) => stop.test(b.getAttribute('aria-label') || '') || stop.test(b.getAttribute('title') || '') || (b.textContent.length < 24 && stop.test(b.textContent)));
    if (control && control.offsetParent !== null) return 'streaming';
    if (document.querySelector('[aria-busy=true]')) return 'busy';
    const size = () => (document.body ? document.body.innerText.length : 0); // growing text = a reply arriving (a ticking clock or rotating ad rarely only grows)
    const before = size();
    await new Promise((r) => setTimeout(r, ${Math.max(0, Math.floor(sampleMs))}));
    return size() > before ? 'changing' : '';
  })()`;
}

// The page's answer (a throw or timeout arrives as undefined) -> keep it awake? Any doubt does.
const pageBusy = (answer) => typeof answer !== 'string' || answer !== '';

const sameAddress = (a, b) => {
  const strip = (u) => String(u || '').split('#')[0].replace(/\/$/, '');
  return strip(a) === strip(b);
};

// How a woken tab gets its page back. `sleepUrl`: the address it slept on (the failed one, when it was
// on an error page); `history`: { entries, index } as navigationHistory gave them; `isError`: is this
// one of Lumen's error/warning pages. Restoring the list brings Back/Forward, scroll and form state,
// but it is only trusted when its current entry really is the page the tab slept on: an entry that is an
// error page, a blank page or another address would bring back the wrong thing (a dead error page, a
// stale in-app route of a single-page site). Otherwise the caller loads `url` (which is also what it
// falls back to when the restore throws).
// -> { restore: null | { entries, index }, url }
function wakePlan({ sleepUrl, history, isError = () => false, fallbackUrl = '' } = {}) {
  const url = sleepUrl || fallbackUrl;
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  const index = Number.isInteger(history?.index) ? history.index : -1;
  const active = entries[index];
  if (!entries.length || !active || typeof active.url !== 'string') return { restore: null, url };
  if (isError(active.url) || /^about:blank/i.test(active.url) || !sameAddress(active.url, url)) return { restore: null, url };
  // Entries that are error pages are dropped (Back would land on a dead page) and the index follows.
  const kept = [];
  let keptIndex = 0;
  entries.forEach((e, i) => {
    if (!e || typeof e.url !== 'string' || !e.url || isError(e.url)) return;
    if (i === index) keptIndex = kept.length;
    kept.push(e);
  });
  return { restore: { entries: kept, index: keptIndex }, url };
}

// Bounds a woken tab's view is given before its page starts loading, so the page lays out at the real
// size on its first frame (a 0x0 view makes a site measure a zero-size viewport and draw tiny or blank
// until the next resize). `full`: the window's content size, for a page in full screen.
function wakeBounds(contentBounds, { fullscreen = false, full = null } = {}) {
  const b = fullscreen && full ? { x: 0, y: 0, ...full } : contentBounds;
  const width = Math.round(Number(b?.width) || 0);
  const height = Math.round(Number(b?.height) || 0);
  return { x: Math.round(Number(b?.x) || 0), y: Math.round(Number(b?.y) || 0), width: width > 1 ? width : 800, height: height > 1 ? height : 600 };
}

module.exports = { keepReason, pageBusyScript, pageBusy, wakePlan, wakeBounds, sameAddress };
