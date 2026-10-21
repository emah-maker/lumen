// Which desktop app a conversation is about, so the AI is offered the right tool without the user having to say "use Word": a .docx attached,
// listed by list_files, open in a file tab or named in the message, or "fix the typos in my essay". Pure functions (no Electron, no disk):
// agent.js wordOffered / desktopOffered feed them the messages, and src/desktop/open-file.js uses the extension table to decide what open_app may open.
// Word is routed to the `word` tool; every other app to `desktop`. A Google Doc (docs.google.com) is the `document` tool's job, never Word's.
'use strict';

// id -> { label, exts, names (what a person calls the app), weak (extensions too ambiguous to route on their own: a .csv is mostly just read, a .m is often Objective-C) }
const APPS = {
  word: { label: 'Word', exts: ['docx', 'doc', 'docm', 'dotx', 'dot', 'rtf', 'odt'], names: /^(microsoft |ms )?word( \d+)?$/i },
  excel: { label: 'Excel', exts: ['xlsx', 'xls', 'xlsm', 'xlsb', 'csv'], weak: ['csv'], names: /^(microsoft |ms )?excel( \d+)?$/i },
  powerpoint: { label: 'PowerPoint', exts: ['pptx', 'ppt', 'pptm', 'ppsx', 'potx'], names: /^(microsoft |ms )?(power ?point|ppt)( \d+)?$/i },
  matlab: { label: 'MATLAB', exts: ['m', 'mlx', 'slx', 'mat'], weak: ['m', 'mat'], names: /^(the )?matlab( r?\d{4}[ab]?)?$/i },
  solidworks: { label: 'SolidWorks', exts: ['sldprt', 'sldasm', 'slddrw'], names: /^(solid ?works)( \d{4})?$/i },
  autocad: { label: 'AutoCAD', exts: ['dwg', 'dxf'], names: /^(autodesk )?autocad( \d{4})?$/i },
  visio: { label: 'Visio', exts: ['vsdx', 'vsd', 'vssx'], names: /^(microsoft |ms )?visio( \d+)?$/i },
  photoshop: { label: 'Photoshop', exts: ['psd', 'psb'], names: /^(adobe )?photoshop( \d{4})?$/i },
  keynote: { label: 'Keynote', exts: ['key'], weak: ['key'], names: /^keynote$/i }, // (.key is also a private key: never routed on, and the credentials rule refuses those files anyway)
  pages: { label: 'Pages', exts: ['pages'], names: /^pages$/i },
  numbers: { label: 'Numbers', exts: ['numbers'], names: /^numbers$/i },
};
const EXT_APP = {};
for (const [id, a] of Object.entries(APPS)) for (const e of a.exts) EXT_APP[e] = id;

// Programs and scripts are never a document, whatever an app's list says (open_app path checks this too).
const NEVER_EXT = new Set(['exe', 'com', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'lnk', 'msi', 'msix', 'appx', 'scr', 'dll', 'jar', 'reg', 'hta', 'cpl', 'sh', 'command', 'app', 'pkg', 'dmg', 'url', 'py', 'pl']);

const extOf = (name) => { const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '').trim().replace(/[?#].*$/, '')); return m ? m[1].toLowerCase() : ''; };
const appForExt = (ext) => { const e = String(ext || '').toLowerCase().replace(/^\./, ''); return NEVER_EXT.has(e) ? '' : EXT_APP[e] || ''; };
const appForFile = (name) => appForExt(extOf(name)); // 'word' for "My essay.docx"
const appForName = (name) => { const n = String(name || '').trim(); return Object.keys(APPS).find((id) => APPS[id].names.test(n)) || ''; };
const labelOf = (id) => APPS[id]?.label || '';
const isWeak = (id, ext) => Boolean(APPS[id]?.weak?.includes(ext));

// A file name with a known extension inside free text (the user's message, a list_files result): "report.docx", "~/Desktop/Lab 1.xlsx".
// A routing extension needs a name before the dot, so "make a .docx" alone is left to the user-text words below.
const EXT_ALT = Object.keys(EXT_APP).sort((a, b) => b.length - a.length).join('|');
const FILE_IN_TEXT = new RegExp(`[^\\s"'<>|*?\\\\/:\\x00]\\.(${EXT_ALT})(?![\\w.-]*[a-z0-9])`, 'gi');
function appsInText(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(FILE_IN_TEXT)) { const ext = m[1].toLowerCase(); const id = appForExt(ext); if (id && !isWeak(id, ext)) out.add(id); }
  return out;
}

// What a person says when the app is clear from the thing, not the program: "fix the typos in my essay". Possessives name the user's own
// document; "this/the doc(ument)" only while the tab is not an ordinary web page (there it means the page).
const OWN_DOC = /\b(?:my|our|the attached|the uploaded) (?:essay|report|paper|resume|résumé|cv|cover letter|letter|memo|thesis|dissertation|assignment|lab report|proposal|manuscript|syllabus|doc|document)s?\b/i;
const THIS_DOC = /\b(?:this|that|the) (?:doc|docx|document)\b/i;
const NOT_WORD_CTX = /\b(?:google docs?|gdocs?|on (?:this|the) (?:page|site|website)|in (?:this|the) (?:page|tab|article))\b/i;

const isGoogleDoc = (url) => { try { const u = new URL(String(url || '')); return u.hostname === 'docs.google.com'; } catch { return false; } };
const isWebPage = (url) => /^https?:/i.test(String(url || ''));

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : '')).filter(Boolean).join(' ') : '');
const URL_IN_CONTEXT = /<untrusted_page_content[^>]*\burl="([^"]*)"/g;

// Tool results that list or name files on this computer (the only ones trusted to say what the user's files are: a web page that merely links a .docx is not the user's).
const FILE_RESULT_TOOLS = new Set(['list_files', 'upload_file', 'project_files', 'list_downloads', 'word', 'desktop']);

// The apps this conversation is about -> { apps: [ids], reason }. `active`: { url, title } of the tab in front, when known.
// Looks at the last few user messages (their words, attached file names, the page context's address) and at the file tools' results.
function appsFor(messages, { active = null, tools = FILE_RESULT_TOOLS } = {}) {
  const found = new Set();
  const add = (set) => { for (const id of set) found.add(id); };
  const list = Array.isArray(messages) ? messages : [];
  const names = new Map(); // tool_use id -> tool name
  for (const m of list) if (m?.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'tool_use' && b.id) names.set(b.id, b.name);
  let activeUrl = active?.url ? String(active.url) : '';
  for (let i = list.length - 1, seen = 0; i >= 0 && i >= list.length - 40; i--) { // the page context the newest user message carries names the tab that was in front
    const m = list[i];
    if (m?.role !== 'user') continue;
    if (seen++ > 6) break;
    const t = textOf(m.content);
    if (!activeUrl) { let u; for (const x of t.slice(0, 20000).matchAll(URL_IN_CONTEXT)) u = x[1]; if (u) activeUrl = u.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))); }
  }
  const gdoc = isGoogleDoc(activeUrl);
  if (active?.url && !gdoc) add(appsInText(`${active.title || ''} ${active.url}`)); // a file open in a Lumen tab (its name is in the title or the address)
  let userSeen = 0;
  for (let i = list.length - 1; i >= 0 && i >= list.length - 40; i--) {
    const m = list[i];
    if (!m) continue;
    if (m.role === 'user' && Array.isArray(m.content)) { // results of the file tools
      for (const b of m.content) {
        if (b?.type !== 'tool_result' || !tools.has(names.get(b.tool_use_id))) continue;
        add(appsInText(textOf(b.content).slice(0, 20000)));
      }
    }
    if (m.role !== 'user' || userSeen >= 6) continue;
    const t = textOf(m.content);
    if (!t || t.length >= 4000 + 20000) continue; // (a message with a whole page pasted in says nothing about the user's files)
    userSeen++;
    const say = t.replace(/<untrusted_page_content[\s\S]*?<\/untrusted_page_content>\s*/g, ''); // the user's own words and attached files, not the page
    if (say.length < 4000) {
      add(appsInText(say));
      if (!gdoc && !NOT_WORD_CTX.test(say) && (OWN_DOC.test(say) || (THIS_DOC.test(say) && !isWebPage(activeUrl)))) found.add('word');
    }
  }
  return { apps: [...found], activeUrl };
}

// Word goes to the `word` tool; any other app to `desktop`.
const wantsWord = (messages, opts) => appsFor(messages, opts).apps.includes('word');
const wantsDesktop = (messages, opts) => appsFor(messages, opts).apps.some((id) => id !== 'word');

module.exports = { APPS, NEVER_EXT, extOf, appForExt, appForFile, appForName, labelOf, isWeak, appsInText, appsFor, wantsWord, wantsDesktop, isGoogleDoc };
