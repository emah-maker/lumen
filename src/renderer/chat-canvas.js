// The canvas's shared, pure part: which code blocks get "Open in canvas", what kind they are, and the document the sandboxed
// preview shows (with Lumen's base styles for plain HTML). It is in the sidebar bundle too (ai-files.js previews use
// frameDocument); the panel itself is chat-canvas-panel.js, loaded on lumen://chat only, after this file.
//
// The preview is code the AI (or a web page it read) wrote, so it is treated as hostile: it runs in an
// <iframe sandbox="allow-scripts"> with no allow-same-origin (an opaque origin: no access to this page,
// its preload or any IPC), showing canvas-frame.html, whose own Content-Security-Policy allows no network
// at all. The page writes the document into that frame by postMessage.
(function (root) {
  const LARGE_LINES = 25; // a block this long (or longer) is worth a panel
  const LARGE_CHARS = 1200;
  const PREVIEW_MAX = 2 * 1024 * 1024;
  const EXT = { html: 'html', svg: 'svg', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', css: 'css', json: 'json', markdown: 'md', md: 'md', bash: 'sh', sh: 'sh', shell: 'sh', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', go: 'go', rust: 'rs', rs: 'rs', ruby: 'rb', php: 'php', sql: 'sql', yaml: 'yml', yml: 'yml', xml: 'xml', jsx: 'jsx', tsx: 'tsx', swift: 'swift', kotlin: 'kt' };

  // What a block is: 'html' | 'svg' | 'code', from its fence language and what it starts with.
  function kindOf(lang, code) {
    const l = String(lang || '').trim().toLowerCase();
    const head = String(code || '').trimStart().slice(0, 300).toLowerCase();
    if (l === 'svg' || /^(<\?xml[^>]*>\s*)?<svg[\s>]/.test(head)) return 'svg';
    if (l === 'html' || l === 'htm' || /^<!doctype html|^<html[\s>]/.test(head)) return 'html';
    return 'code';
  }
  const lines = (code) => String(code || '').replace(/\n+$/, '').split('\n').length;
  // Whether a block gets the button: a whole HTML/SVG document always, other code when it is long.
  function worthOpening(lang, code) {
    const text = String(code || '');
    if (!text.trim()) return false;
    const kind = kindOf(lang, text);
    if (kind === 'svg') return /<svg[\s>]/i.test(text);
    if (kind === 'html') return /<!doctype html|<html[\s>]|<body[\s>]|<script[\s>]|<style[\s>]/i.test(text) || lines(text) >= 8;
    return lines(text) >= LARGE_LINES || text.length >= LARGE_CHARS;
  }
  const previewable = (kind) => kind === 'html' || kind === 'svg';
  // The CSP every preview document carries, put in front of the AI's markup as well as in the frame page.
  const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

  // [designed HTML] A page with no stylesheet of its own (plain HTML from the AI) gets Lumen's base styles: readable type, a measure,
  // tables, code, forms, the user's accent, light or dark with the system. They sit in a cascade layer, so any CSS the page adds wins.
  const ownStyles = (html) => /<style[\s>]|<link[^>]+stylesheet/i.test(String(html || ''));
  const cleanAccent = (c) => (/^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\))$/i.test(String(c || '').trim()) ? String(c).trim() : '#0a84ff');
  const baseCss = (accent) => `@layer lumen-base{:root{color-scheme:light dark;--a:${cleanAccent(accent)};--fg:#1f2328;--bg:#fff;--line:#d0d7de;--soft:#f6f8fa;--mute:#57606a}@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#16171a;--line:#3a3d44;--soft:#202227;--mute:#9da5b0}}`
    + 'html{background:var(--bg)}body{margin:0 auto;max-width:760px;padding:32px 24px 56px;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}'
    + 'h1,h2,h3,h4{line-height:1.25;margin:1.4em 0 .5em}h1{font-size:2em;margin-top:.3em}h2{font-size:1.45em}h3{font-size:1.2em}p,ul,ol,dl,table,pre,blockquote,figure{margin:0 0 1em}li+li{margin-top:.25em}'
    + 'a{color:var(--a)}img,video,canvas,svg{max-width:100%;height:auto}hr{border:0;border-top:1px solid var(--line);margin:2em 0}'
    + 'table{border-collapse:collapse;width:100%;font-size:.95em}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--soft)}'
    + 'code,pre,kbd{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:.9em}pre{background:var(--soft);padding:12px 14px;border-radius:8px;overflow:auto}:not(pre)>code{background:var(--soft);padding:.1em .35em;border-radius:4px}'
    + 'blockquote{margin-left:0;padding-left:1em;border-left:3px solid var(--a);color:var(--mute)}'
    + 'input,select,textarea,button{font:inherit;color:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}button{cursor:pointer;background:var(--a);color:#fff;border-color:transparent}}';

  // The document the sandboxed frame shows: the policy first (after a doctype, so the page keeps standards mode), then the base
  // styles when the page has none. An SVG is wrapped so a bare <svg> fills the panel. opts.accent: the chat page's accent colour.
  function frameDocument(kind, code, opts = {}) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;
    const text = String(code || '').slice(0, PREVIEW_MAX);
    if (kind === 'svg') return `<!doctype html>${meta}<meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fff}svg{max-width:100%;max-height:100%}</style>${text.replace(/^\s*<\?xml[^>]*>/, '')}`;
    // [page math] the page's formulas as MathML: its MathJax/KaTeX script can't load here (no network), and a raw "<" in one broke the page.
    const pageMath = root.pageMath || (typeof require === 'function' ? require('./page-math') : null);
    const body = pageMath ? pageMath.mathify(text, root.temml || globalThis.temml) : text;
    const head = `${meta}${opts.plain || ownStyles(text) ? '' : `<meta name="viewport" content="width=device-width"><style>${baseCss(opts.accent)}</style>`}`;
    const dt = /^\s*<!doctype html[^>]*>/i.exec(body);
    return dt ? `${dt[0]}${head}${body.slice(dt[0].length)}` : `${head}${body}`;
  }
  const fileName = (lang, kind) => `canvas.${kind === 'html' ? 'html' : kind === 'svg' ? 'svg' : EXT[String(lang || '').toLowerCase()] || 'txt'}`;
  // The chat page's accent colour, for the base styles (the user can pick another one: features/theme-colors.js).
  const accent = () => { try { return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); } catch { return ''; } };

  const api = { kindOf, worthOpening, previewable, frameDocument, fileName, ownStyles, baseCss, cleanAccent, lines, accent, FRAME_CSP, LARGE_LINES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  // chat-canvas-panel.js (lumen://chat only) replaces decorate and adds open / openImage / close. The sidebar has no canvas.
  root.chatCanvas = { ...api, decorate() {} };
})(typeof window !== 'undefined' ? window : globalThis);
