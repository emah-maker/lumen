// open_app with a path: which files the AI may have an app open. The file must exist and be a regular file (links followed, so a link can't point
// somewhere else), outside the places the AI never reads (Lumen's profile, ~/.ssh and the other credentials folders, .env and key files: the same
// rules as list_files, features/device-access.js), and its extension must belong to an app (src/ai/app-intent.js) that is not a program or a script.
// If the AI also names the app, it must be the one that owns the file: open_app never starts an app with a file it does not own.
'use strict';

const deviceAccess = require('../features/device-access');
const intent = require('../ai/app-intent');

// -> { file (real path), app (id), label } or throws an Error whose text the AI reads.
function checkOpenFile(raw, { name = '', home, profile = '', check } = {}) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > 1000) throw new Error('Give the full path of one file to open.');
  const given = intent.appForFile(text.replace(/^["']|["']$/g, ''));
  if (!given) throw new Error('That kind of file is not opened by open_app (only documents of an app, like .docx, .xlsx, .pptx; never programs or scripts).');
  let file;
  try { file = (check || ((p) => deviceAccess.checkedPath(p, 'file', { home, profile })))(text); } catch (e) { throw new Error(e?.message || 'That file cannot be opened.'); }
  const app = intent.appForFile(file);
  if (!app || app !== given) throw new Error('That file is a link to a different kind of file, so it is not opened.'); // (a "report.docx" that is really something else)
  const want = String(name || '').trim();
  if (want && intent.appForName(want) !== app) throw new Error(`That file belongs to ${intent.labelOf(app)}, so open it with open_app name "${intent.labelOf(app)}".`);
  return { file, app, label: intent.labelOf(app) };
}

module.exports = { checkOpenFile };
