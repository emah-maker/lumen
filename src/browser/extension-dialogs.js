// alert/confirm/prompt from an extension's content scripts, drawn as Lumen's own dialog like a page's (main.js showToUser).
// Lumen replaces the three in a page's main world (preload/page-dialogs-preload.js), but a content script runs in its
// extension's own isolated world, which no preload reaches, so 1Password's "isn't linked to a login ... Click OK to paste"
// confirm came up as a grey native box titled "Lumen". Electron has no hook for those native dialogs, so each extension
// that runs scripts on pages is loaded with one more content script (this file's SHIM, first in its list, on the sites
// its own scripts already reach): it replaces the three in that world and asks main.js with a synchronous request to
// SCHEME, which holds the answer until the user picks, so the script waits exactly as for the native one.
// The request carries a key made for this extension at load (written into its copy of the shim, which pages cannot read),
// so a page cannot ask in an extension's name; one without a known key is refused and the shim falls back to the native call.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEME = 'lumen-dialog';
const SHIM = 'lumen-dialogs.js';
const HOST_PATTERN = /^(<all_urls>|(\*|https?|file):\/\/.+)$/;

// The page patterns an extension's scripts can already run on: its content scripts', and its host permissions when it
// can inject on demand (manifest v3 `scripting`; every manifest v2 extension with host permissions can).
function reachOf(manifest) {
  const scripts = (Array.isArray(manifest?.content_scripts) ? manifest.content_scripts : []).filter((cs) => !isShim(cs));
  const perms = (Array.isArray(manifest?.permissions) ? manifest.permissions : []).filter((p) => typeof p === 'string');
  const injects = manifest?.manifest_version === 2 || perms.includes('scripting');
  const hosts = injects ? [...(Array.isArray(manifest?.host_permissions) ? manifest.host_permissions : []), ...perms] : [];
  return [...new Set([...scripts.flatMap((cs) => (Array.isArray(cs?.matches) ? cs.matches : [])), ...hosts].filter((p) => typeof p === 'string' && HOST_PATTERN.test(p)))];
}
const isShim = (cs) => Array.isArray(cs?.js) && cs.js.includes(SHIM);

// The manifest with the shim first among its content scripts (any older copy of the entry replaced), or unchanged when the
// extension runs nothing on pages.
function withShim(manifest) {
  if (!manifest || typeof manifest !== 'object') return manifest;
  const rest = (Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []).filter((cs) => !isShim(cs));
  const matches = reachOf(manifest);
  const out = { ...manifest };
  if (!matches.length) {
    if (Array.isArray(manifest.content_scripts) && rest.length !== manifest.content_scripts.length) out.content_scripts = rest;
    return out;
  }
  // Sites every one of its scripts stays off (Site access "all sites except", browser/extension-sites.js) the shim stays off too.
  const scripts = rest.filter((cs) => Array.isArray(cs?.matches));
  const excluded = scripts.length ? scripts.map((cs) => (Array.isArray(cs.exclude_matches) ? cs.exclude_matches : [])).reduce((a, b) => a.filter((p) => b.includes(p))) : [];
  out.content_scripts = [{ matches, ...(excluded.length ? { exclude_matches: excluded } : {}), js: [SHIM], run_at: 'document_start', all_frames: true, match_about_blank: true }, ...rest];
  return out;
}

// The content script itself, for one key. Runs in the extension's world before its own scripts; when the ask fails (no
// answer, an old Lumen) the native call is made instead, so a dialog is never lost.
function shimSource(key) {
  return `(() => {
  const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
  const ask = (kind, message, value) => {
    try {
      const x = new XMLHttpRequest();
      x.open('POST', '${SCHEME}://ask/', false);
      x.setRequestHeader('content-type', 'text/plain');
      x.send(JSON.stringify({ key: ${JSON.stringify(key)}, kind, message: message === undefined ? '' : String(message), value: value == null ? '' : String(value), frame: location.href }));
      return x.status === 200 ? JSON.parse(x.responseText) : null;
    } catch { return null; }
  };
  const define = (name, fn) => Object.defineProperty(window, name, { value: fn, writable: true, configurable: true, enumerable: true });
  define('alert', function alert(message) { if (!ask('alert', message)) native.alert.call(window, message); });
  define('confirm', function confirm(message) { const r = ask('confirm', message); return r ? r.accept === true : native.confirm.call(window, message); });
  define('prompt', function prompt(message, value) { const r = ask('prompt', message, value); return r ? (r.accept === true ? String(r.value ?? '') : null) : native.prompt.call(window, message, value); });
})();
`;
}

// key -> { dir, id, name }: filled when an extension is loaded (prepare, then loaded once Electron gives its id and name).
function createRegistry() {
  const byKey = new Map();
  const byDir = new Map();
  return {
    // Writes the shim (with a fresh key) and the manifest that loads it, before the extension loads from `dir`.
    async prepare(dir) {
      const file = path.join(dir, 'manifest.json');
      let manifest;
      try { manifest = JSON.parse((await fs.promises.readFile(file, 'utf8')).trimStart()); } catch { return null; }
      const next = withShim(manifest);
      const wants = (next.content_scripts || []).some(isShim);
      if (wants) {
        const old = byDir.get(dir);
        if (old) byKey.delete(old);
        const key = crypto.randomBytes(24).toString('base64url');
        await fs.promises.writeFile(path.join(dir, SHIM), shimSource(key));
        byKey.set(key, { dir, id: '', name: '' });
        byDir.set(dir, key);
      }
      if (JSON.stringify(next) !== JSON.stringify(manifest)) await fs.promises.writeFile(file, JSON.stringify(next));
      return next;
    },
    loaded(dir, ext) {
      const entry = byKey.get(byDir.get(dir));
      if (entry && ext) { entry.id = ext.id || ''; entry.name = ext.name || ext.manifest?.name || ''; }
    },
    // The extension a request's key belongs to, or null.
    lookup: (key) => (typeof key === 'string' && byKey.get(key)) || null,
  };
}

// Reads an ask: { kind, message, value, frame, extension } or null when it is malformed or its key is unknown.
function parseAsk(text, registry) {
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  const entry = registry.lookup(body?.key);
  if (!entry || !entry.id) return null;
  const kind = body.kind === 'confirm' || body.kind === 'prompt' ? body.kind : 'alert';
  return { kind, message: String(body.message ?? '').slice(0, 10000), value: String(body.value ?? '').slice(0, 10000), frame: String(body.frame || ''), extension: { id: entry.id, name: entry.name || entry.id } };
}

module.exports = { SCHEME, SHIM, reachOf, withShim, shimSource, createRegistry, parseAsk };
