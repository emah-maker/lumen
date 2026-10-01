// Lumen's docs page: renders the repository's own Markdown (README.md, CHANGELOG.md and docs/*.md,
// copied into md/ by .github/workflows/pages.yml), so the website never drifts from the repo.
// marked turns it into HTML, DOMPurify cleans that, then links are pointed at the right place:
// another doc -> docs.html?p=<page>, a heading -> its #id, any other repo file -> GitHub.
'use strict';

const REPO = 'https://github.com/emah-maker/lumen';
// page id -> { title, file in the repo }. The order is the sidebar's.
const PAGES = {
  readme: { title: 'User guide', file: 'README.md' },
  architecture: { title: 'Architecture', file: 'docs/architecture.md' },
  'mcp-tools': { title: 'MCP tool reference', file: 'docs/mcp-tools.md' },
  settings: { title: 'Settings reference', file: 'docs/settings.md' },
  'custom-widgets': { title: 'Custom widgets', file: 'docs/custom-widgets.md' },
  'mac-signing': { title: 'macOS signing', file: 'docs/mac-signing.md' },
  changelog: { title: 'Changelog', file: 'CHANGELOG.md' },
};
const BY_FILE = Object.fromEntries(Object.entries(PAGES).map(([id, p]) => [p.file.toLowerCase(), id]));

// GitHub's heading ids: lower case, punctuation dropped, spaces to hyphens, repeats numbered.
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

// A path relative to the Markdown file's folder -> a path from the repo root ('' if it leaves the repo).
function resolve(from, rel) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (seg === '..') { if (!parts.length) return ''; parts.pop(); } else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function fixLinks(root, file) {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) { a.rel = 'noopener'; continue; }
    if (href.startsWith('#')) continue;
    const [path, frag] = href.split('#');
    const repoPath = resolve(file, decodeURIComponent(path));
    const page = BY_FILE[repoPath.toLowerCase()];
    if (page) a.href = `docs.html?p=${page}${frag ? `#${frag}` : ''}`;
    else if (repoPath) a.href = `${REPO}/blob/main/${repoPath}${frag ? `#${frag}` : ''}`;
  }
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (/^https?:/i.test(src)) continue;
    const repoPath = resolve(file, src);
    // docs/media is published with the site; anything else comes from the repo itself.
    img.src = repoPath.startsWith('docs/media/') ? repoPath : `https://raw.githubusercontent.com/emah-maker/lumen/main/${repoPath}`;
    img.loading = 'lazy';
  }
}

function drawNav(current) {
  const list = document.getElementById('pages');
  list.replaceChildren(...Object.entries(PAGES).map(([id, p]) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `docs.html?p=${id}`;
    a.textContent = p.title;
    if (id === current) a.setAttribute('aria-current', 'page');
    li.append(a);
    return li;
  }));
}

function drawToc(root) {
  const toc = document.getElementById('toc');
  const items = [...root.querySelectorAll('h2, h3')].map((h) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.textContent = h.dataset.text;
    if (h.tagName === 'H3') a.className = 'l3';
    li.append(a);
    return li;
  });
  toc.replaceChildren(...items);
  toc.parentElement.hidden = !items.length;
}

async function show() {
  const params = new URLSearchParams(location.search);
  const id = Object.hasOwn(PAGES, params.get('p') || '') ? params.get('p') : 'readme';
  const page = PAGES[id];
  const doc = document.getElementById('doc');
  drawNav(id);
  document.title = `${page.title} · Lumen docs`;
  let text;
  try {
    const res = await fetch(`md/${page.file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    console.error('docs: could not load', page.file, err);
    doc.replaceChildren();
    const p = document.createElement('p');
    p.append('This page could not be loaded. ');
    const a = document.createElement('a');
    a.href = `${REPO}/blob/main/${page.file}`;
    a.textContent = 'Read it on GitHub';
    p.append(a, '.');
    doc.append(p);
    return;
  }
  doc.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true }), { ADD_ATTR: ['target'] });
  const slug = slugger();
  for (const h of doc.querySelectorAll('h1, h2, h3, h4')) {
    h.dataset.text = h.textContent;
    h.id = slug(h.textContent);
    if (h.tagName !== 'H1') {
      const a = document.createElement('a');
      a.className = 'anchor';
      a.href = `#${h.id}`;
      a.setAttribute('aria-label', `Link to ${h.textContent}`);
      a.textContent = '#';
      h.append(a);
    }
  }
  fixLinks(doc, page.file);
  drawToc(doc);
  const edit = document.createElement('a');
  edit.className = 'edit';
  edit.href = `${REPO}/blob/main/${page.file}`;
  edit.textContent = 'View this page on GitHub';
  doc.append(edit);
  if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}

show();
