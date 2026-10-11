// What a page can tell about you away from it, and what it can fingerprint you by (features/hide-activity.js has the
// settings, all on by default):
//  - hideTabActivity: the page always reads as the visible, focused tab. document.hidden / visibilityState and
//    document.hasFocus() say so, and the events that report switching tabs, apps or windows never reach it
//    (visibilitychange, the window's blur/focus and the element blur/focus that come with them, and the cursor
//    leaving the window, which "exit intent" pop-ups and proctoring scripts watch).
//  - hideWindowSize: the screen reads as exactly the size of the window, at the top left, so a window in split
//    screen or made smaller looks like a full-screen one (screen.width/height/avail*, screenX/screenY).
//  - fingerprintProtection: canvas, WebGL and audio readouts vary per site (see below); the battery reads as a desktop's.
//  - sendGpc: navigator.globalPrivacyControl is true, to match the Sec-GPC header.
// The window's real size still reaches the page (innerWidth, resize events, media queries): layouts need it.
// Two ways in, as Lumen's other page patches: this 'frame' preload in every tab session (the settings come in one
// synchronous ask when the frame starts), and the same install() as a DevTools document-start script in every frame,
// other sites' frames included, which preloads don't reach (features/hide-activity.js, main.js applyChromeIdentity).
const { contextBridge, ipcRenderer } = require('electron');

// (about:blank and srcdoc frames too: a page could otherwise make one and read the real answers through it.)
const web = typeof location !== 'undefined' && (((location.protocol === 'http:' || location.protocol === 'https:') && location.origin !== 'null') || location.protocol === 'about:');
const skip = typeof location !== 'undefined' && /(^|\.)accounts\.google\.com$/.test(location.hostname); // Google's sign-in pages check the browser closely: untouched there

function ask() {
  try { const s = ipcRenderer.sendSync('hide-activity:config'); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}

// Runs in the main world.
function install(opts) {
  // The toString wrapper shared with the other preloads (same helper as preload/permissions-preload.js): patched
  // functions read as native code.
  const nativeTexts = () => {
    const key = Symbol.for('lumen.nativeTexts');
    const current = Function.prototype.toString;
    try { const found = current.call(key); if (found instanceof WeakMap) return found; } catch { /* the native one: not wrapped yet */ }
    const shown = new WeakMap();
    const wrapper = {
      toString() {
        'use strict'; // (a sloppy method would box the symbol it is asked with)
        if (this === key) return shown;
        if (shown.has(this)) return shown.get(this);
        try {
          return Reflect.apply(current, this, arguments);
        } catch (err) {
          try { if (err && typeof err.stack === 'string') err.stack = err.stack.split('\n').filter((line) => !/^\s+at (?:\S+\.)?(?:toString|apply) \([^)]*<anonymous>:\d+:\d+\)$/.test(line)).join('\n'); } catch { /* frozen error: left */ }
          throw err;
        }
      },
    }.toString;
    shown.set(wrapper, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', { value: wrapper, writable: true, configurable: true, enumerable: false });
    return shown;
  };
  const shown = nativeTexts();
  const looksNative = (name, fn) => { shown.set(fn, `function ${name}() { [native code] }`); return fn; };
  // Replaces the getter of `key` on `proto` (where the native one lives, so no own property shows on the object).
  const redefineGetter = (proto, key, fn) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, key);
    if (!d || !d.get) return null;
    const get = looksNative(`get ${key}`, Object.getOwnPropertyDescriptor({ get [key]() { return fn.call(this, d.get); } }, key).get);
    Object.defineProperty(proto, key, { get, set: d.set, enumerable: d.enumerable, configurable: true });
    return d.get;
  };

  // (Installed twice in one page when both ways in ran, this preload and the DevTools script: the second does nothing.)
  if (opts.tab && !shown.has(Document.prototype.hasFocus)) {
    try {
      const D = Document.prototype;
      redefineGetter(D, 'hidden', () => false);
      redefineGetter(D, 'webkitHidden', () => false);
      redefineGetter(D, 'visibilityState', () => 'visible');
      redefineGetter(D, 'webkitVisibilityState', () => 'visible');
      const realHasFocus = D.hasFocus;
      const hasFocus = { hasFocus() { realHasFocus.call(this); return true; } }.hasFocus; // (the real one still throws on a non-document)
      Object.defineProperty(D, 'hasFocus', { value: looksNative('hasFocus', hasFocus), writable: true, enumerable: true, configurable: true });

      // Lumen's listeners are the first on the window (a preload runs before the page's scripts), in the capture
      // phase, so stopping an event there keeps it from every listener the page adds, wherever it adds them.
      const swallow = (ev) => { ev.stopImmediatePropagation(); };
      const top = (t) => t === window || t === document;
      const edge = (t) => t === document || t === document.documentElement || t === document.body;
      let away = !realHasFocus.call(document); // the window lost focus (so element blur/focus now are about that)
      let returning = false;
      for (const type of ['visibilitychange', 'webkitvisibilitychange']) window.addEventListener(type, swallow, true);
      window.addEventListener('blur', (ev) => { if (top(ev.target)) { away = true; swallow(ev); } else if (!realHasFocus.call(document)) swallow(ev); }, true);
      window.addEventListener('focusout', (ev) => { if (!realHasFocus.call(document)) swallow(ev); }, true);
      window.addEventListener('focus', (ev) => {
        if (top(ev.target)) {
          swallow(ev);
          if (away) { away = false; returning = true; setTimeout(() => { returning = false; }, 0); }
        } else if (returning) swallow(ev);
      }, true);
      window.addEventListener('focusin', (ev) => { if (returning) swallow(ev); }, true);
      // The cursor leaving the window: mouseleave/mouseout with nowhere it went, on the page's outer elements.
      for (const type of ['mouseleave', 'mouseout']) window.addEventListener(type, (ev) => { if (ev.relatedTarget === null && edge(ev.target)) swallow(ev); }, true);
    } catch { /* leave the page's view of focus as it is */ }
  }

  const widthGetter = window.Screen && Object.getOwnPropertyDescriptor(Screen.prototype, 'width');
  if (opts.size && !(widthGetter && shown.has(widthGetter.get))) {
    try {
      const S = Screen.prototype;
      // (outerWidth is 0 in a frame being torn down: then the real screen answers.)
      for (const key of ['width', 'availWidth']) redefineGetter(S, key, function (real) { return window.outerWidth || real.call(this); });
      for (const key of ['height', 'availHeight']) redefineGetter(S, key, function (real) { return window.outerHeight || real.call(this); });
      redefineGetter(S, 'availLeft', () => 0);
      redefineGetter(S, 'availTop', () => 0);
      redefineGetter(S, 'isExtended', () => false);
      for (const key of ['screenX', 'screenY', 'screenLeft', 'screenTop']) {
        const d = Object.getOwnPropertyDescriptor(window, key);
        if (d && d.get) Object.defineProperty(window, key, { get: looksNative(`get ${key}`, Object.getOwnPropertyDescriptor({ get [key]() { return 0; } }, key).get), set: d.set, enumerable: d.enumerable, configurable: true });
      }
    } catch { /* leave the screen as it is */ }
  }

  // Fingerprinting: what canvas, WebGL and audio give back is changed a little, differently on each site and each
  // time Lumen starts, the same on one site (opts.seed comes from the main process; the site is the top page's
  // domain, so a tracker's frame on two sites reads two different prints). A few pixels' lowest bit, a few audio
  // samples by a millionth: nothing anyone sees or hears, but the hash a tracker takes of it no longer follows you.
  // Blank canvases and fully transparent pixels are left alone (apps test for "is it empty"). The battery reads as a
  // desktop's (charging, full), since its level and timing can link visits across sites.
  // (Bot checks are left their real readings: a changed print there gets you a harder puzzle or a block, and they
  // don't follow you between sites with it.)
  const botCheck = /(^|\.)(challenges\.cloudflare\.com|hcaptcha\.com|recaptcha\.net|arkoselabs\.com)$/.test(location.hostname) || (/^www\.google\.com$/.test(location.hostname) && location.pathname.startsWith('/recaptcha'));
  if (opts.fp && !botCheck && !(window.CanvasRenderingContext2D && shown.has(CanvasRenderingContext2D.prototype.getImageData))) {
    try {
      const topOrigin = (() => { try { const a = location.ancestorOrigins; return a && a.length ? a[a.length - 1] : location.origin; } catch { return location.origin; } })();
      let host = '';
      try { host = new URL(topOrigin).hostname; } catch { host = location.hostname; }
      const parts = host.split('.');
      // The registrable domain, near enough (example.co.uk keeps three labels); only the grouping of sites depends on it.
      const site = parts.length > 2 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length <= 3 ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
      let h = 2166136261;
      for (const ch of `${opts.seed}|${site}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
      const seed = h >>> 0;
      const rng = (n) => { let a = (seed ^ Math.imul(n, 2654435761)) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
      // RGBA bytes, `w` x `h`: up to 12 pixels (chosen by size) get one color channel's lowest bit flipped.
      const noisePixels = (data, w, hgt) => {
        const n = Math.floor(data.length / 4);
        if (!n) return;
        const r = rng(w * 65599 + hgt);
        for (let k = 0; k < Math.min(12, n); k++) {
          const i = Math.floor(r() * n) * 4;
          const c = Math.floor(r() * 3);
          if (data[i + 3] !== 0) data[i + c] ^= 1;
        }
      };
      const replace = (proto, name, make) => {
        const orig = proto && proto[name];
        if (typeof orig !== 'function') return null;
        const fn = make(orig);
        Object.defineProperty(proto, name, { value: looksNative(name, fn), writable: true, enumerable: true, configurable: true });
        return orig;
      };
      const C2D = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
      const getImageData = C2D && C2D.getImageData;
      const putImageData = C2D && C2D.putImageData;
      const drawImage = C2D && C2D.drawImage;
      const createElement = Document.prototype.createElement;
      const getContext = HTMLCanvasElement.prototype.getContext;
      replace(C2D, 'getImageData', (orig) => ({ getImageData() { const img = Reflect.apply(orig, this, arguments); try { noisePixels(img.data, img.width, img.height); } catch { /* as it was */ } return img; } }).getImageData);
      // toDataURL / toBlob: the picture is copied to a canvas of Lumen's own and changed there; the page's canvas is not
      // touched. A canvas that can't be read (another site's image on it) throws as before, from the original.
      const noisyCopy = (canvas) => {
        const w = canvas.width; const hgt = canvas.height;
        if (!w || !hgt || w * hgt > 16777216) return null;
        const copy = createElement.call(document, 'canvas');
        copy.width = w; copy.height = hgt;
        const ctx = getContext.call(copy, '2d');
        drawImage.call(ctx, canvas, 0, 0);
        const img = getImageData.call(ctx, 0, 0, w, hgt);
        noisePixels(img.data, w, hgt);
        putImageData.call(ctx, img, 0, 0);
        return copy;
      };
      const CE = HTMLCanvasElement.prototype;
      replace(CE, 'toDataURL', (orig) => ({ toDataURL() { let copy; try { copy = noisyCopy(this); } catch { copy = null; } return Reflect.apply(orig, copy || this, arguments); } }).toDataURL);
      replace(CE, 'toBlob', (orig) => ({ toBlob() { let copy; try { copy = noisyCopy(this); } catch { copy = null; } return Reflect.apply(orig, copy || this, arguments); } }).toBlob);
      if (window.OffscreenCanvas && window.OffscreenCanvasRenderingContext2D) {
        const O2D = OffscreenCanvasRenderingContext2D.prototype;
        replace(O2D, 'getImageData', (orig) => ({ getImageData() { const img = Reflect.apply(orig, this, arguments); try { noisePixels(img.data, img.width, img.height); } catch { /* as it was */ } return img; } }).getImageData);
      }
      // WebGL: readPixels into a byte array gets the same treatment.
      for (const G of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        if (!G) continue;
        replace(G.prototype, 'readPixels', (orig) => ({ readPixels(x, y, w, hgt) { const out = Reflect.apply(orig, this, arguments); try { const px = arguments[6]; if (px instanceof Uint8Array && w > 0 && hgt > 0) noisePixels(px, w, hgt); } catch { /* as it was */ } return out; } }).readPixels);
      }
      // Audio: the samples a rendered buffer gives out, and an analyser's spectrum.
      if (window.AudioBuffer) {
        const done = new WeakMap(); // AudioBuffer -> Set of channels already changed (getChannelData returns the same live array)
        const noiseSamples = (arr, salt) => {
          const r = rng(arr.length * 31 + salt);
          for (let k = 0; k < Math.min(24, arr.length); k++) { const i = Math.floor(r() * arr.length); if (arr[i] !== 0) arr[i] += (r() - 0.5) * 2e-7; }
        };
        replace(AudioBuffer.prototype, 'getChannelData', (orig) => ({ getChannelData(channel) {
          const arr = Reflect.apply(orig, this, arguments);
          try { let set = done.get(this); if (!set) { set = new Set(); done.set(this, set); } if (!set.has(channel)) { set.add(channel); noiseSamples(arr, channel); } } catch { /* as it was */ }
          return arr;
        } }).getChannelData);
        // (copyFromChannel copies the same changed samples getChannelData gives, so the two never disagree.)
        const getChannelData = AudioBuffer.prototype.getChannelData;
        replace(AudioBuffer.prototype, 'copyFromChannel', (orig) => ({ copyFromChannel(dest, channel) { try { getChannelData.call(this, channel); } catch { /* the original throws below */ } return Reflect.apply(orig, this, arguments); } }).copyFromChannel);
      }
      if (window.AnalyserNode) {
        replace(AnalyserNode.prototype, 'getFloatFrequencyData', (orig) => ({ getFloatFrequencyData(arr) { const out = Reflect.apply(orig, this, arguments); try { const r = rng(arr.length); for (let k = 0; k < Math.min(8, arr.length); k++) { const i = Math.floor(r() * arr.length); if (Number.isFinite(arr[i])) arr[i] += (r() - 0.5) * 1e-4; } } catch { /* as it was */ } return out; } }).getFloatFrequencyData);
      }
      if (window.BatteryManager) {
        const B = BatteryManager.prototype;
        redefineGetter(B, 'charging', () => true);
        redefineGetter(B, 'level', () => 1);
        redefineGetter(B, 'chargingTime', () => 0);
        redefineGetter(B, 'dischargingTime', () => Infinity);
      }
    } catch { /* leave the page as it is */ }
  }

  // Global Privacy Control is sent with every request (Settings); a page asking in script reads it too, as in Firefox and Brave.
  if (opts.gpc && !('globalPrivacyControl' in Navigator.prototype)) {
    try {
      const get = looksNative('get globalPrivacyControl', Object.getOwnPropertyDescriptor({ get globalPrivacyControl() { return true; } }, 'globalPrivacyControl').get);
      Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get, set: undefined, enumerable: true, configurable: true });
    } catch { /* not shown */ }
  }
}

if (typeof location !== 'undefined' && web && !skip) {
  const opts = ask();
  if (opts.tab || opts.size || opts.fp || opts.gpc) {
    try {
      contextBridge.executeInMainWorld({ func: install, args: [{ tab: Boolean(opts.tab), size: Boolean(opts.size), fp: Boolean(opts.fp), gpc: Boolean(opts.gpc), seed: String(opts.seed || '') }] });
    } catch (err) {
      console.error('hide-activity: could not install:', err.message);
    }
  }
}

// (The main process reads install() from here for the DevTools script.)
if (typeof module !== 'undefined' && typeof location === 'undefined') module.exports = { install };
