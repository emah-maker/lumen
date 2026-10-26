// Google Drive through the shared Google sign-in (connectors/google-auth.js), with the Drive API v3 at www.googleapis.com.
// Reads: find files, read one file's text. Writes (each asks the user on a card first): make a folder, upload ONE new local file, replace the
// content of existing files (one, or up to 25 matched by name in a folder, on ONE card), rename, move, copy, move to the Trash (never a
// permanent delete) and share a file by link. Editing any file needs the full `drive` scope; a sign-in that only has the older drive.readonly +
// drive.file is told to connect again (ctx.hasScopes), before any card. The AI never names a file on disk: an upload or update takes a chat
// attachment's ref, or (only when the user allowed files on this computer) a path, and the agent resolves it through the same checks as
// upload_file (features/device-access.js: no credentials folders, no Lumen profile) before the card, which names each file and its size.
// ctx.file is that checked file (an update: a list of them, each with the Drive `target` the card showed); each is looked at again here.
'use strict';
const fs = require('fs');
const { flat, clip, when, ConnectorError } = require('../util');
const G = require('./_google');

const GAPPS = 'application/vnd.google-apps.';
const FOLDER = `${GAPPS}folder`;
const MULTIPART_MAX = 5 * 1024 * 1024; // up to this: one multipart request; above: a resumable upload session
const READ_MAX = 2e6; // the most text of a file that is fetched
const UPDATE_MAX = 25; // the most files one update call replaces (one card lists them all)
const TEXTY = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|rtf)$|application\/.+\+(json|xml)$)/;
const SHORT = { document: 'doc', spreadsheet: 'sheet', presentation: 'slides', folder: 'folder', form: 'form', drawing: 'drawing' };
const NEEDS_FULL = new Set(['update', 'rename', 'move', 'copy', 'trash']); // the writes that touch files Lumen did not make: they need the full drive scope

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, '\\\'');
const kindOf = (mime) => (String(mime).startsWith(GAPPS) ? SHORT[String(mime).slice(GAPPS.length)] || 'google file' : String(mime).split('/').pop().slice(0, 30));
const sizeText = (n) => { n = Number(n) || 0; return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`; };
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink';
const flags = { supportsAllDrives: 'true' };

async function verify(ctx) {
  const res = await ctx.http('/about', { query: { fields: 'user(emailAddress)' } });
  if (res.ok) { let email = ''; try { email = flat(JSON.parse(res.text)?.user?.emailAddress, 80); } catch { /* shown without a name */ } return { status: 200, account: email || ctx.email }; }
  const e = G.failure(ctx, res);
  return { status: res.status === 401 || res.status === 403 ? res.status : 500, message: e.message };
}

const getFile = async (ctx, id, fields = FILE_FIELDS) => G.json(ctx, await ctx.http(`/files/${encodeURIComponent(id)}`, { query: { fields, ...flags } }), { thing: 'that file' });

// Editing a file Lumen did not make needs the full drive scope. A sign-in made before that scope existed (drive.readonly + drive.file) says
// so plainly, and the AI tells the user to press Connect on the Drive card, which asks Google for the one new permission.
function needFull(ctx) {
  if (typeof ctx.hasScopes === 'function' && !ctx.hasScopes()) throw new ConnectorError('Lumen’s Google Drive permission is the older one (read your files, change only the ones Lumen made), which can’t change this. Tell the user to press Connect on Google Drive in Settings → Apps and connections and allow full access to their Drive. Nothing was changed.', 'auth');
}
const SHARE_HINT = 'If Lumen didn’t make this file, the user may need to connect Google Drive again in Settings → Apps and connections to allow editing all their files.';

// A local file the user allowed on the card, looked at again just before its bytes go: still there, same size, not changed since.
function readLocal(f, verb) {
  if (!f?.path) throw new ConnectorError(`Give file (the ref of a file the user attached) or path (a file on this computer). Nothing was ${verb}.`, 'args');
  let stat;
  try { stat = fs.statSync(f.path); } catch { throw new ConnectorError(`That file can’t be read any more. Nothing was ${verb}.`, 'args'); }
  if (!stat.isFile() || stat.size !== f.size || (f.mtimeMs && Math.abs(stat.mtimeMs - f.mtimeMs) > 1)) throw new ConnectorError(`The file changed after the user allowed it, so it was not ${verb}. Ask again.`, 'args');
  const bytes = fs.readFileSync(f.path);
  if (bytes.length !== f.size) throw new ConnectorError(`The file changed while it was being read, so it was not ${verb}. Ask again.`, 'args');
  return bytes;
}

// The bytes of a file to Drive, sent once and never repeated by Lumen: a new file (POST /files) or the new content of an existing one
// (PATCH /files/<id>). Up to 5 MB: one multipart request; larger: a resumable session (a start request, then the bytes in one PUT).
// -> the answer (the caller checks the status). A failure in transit or a 5xx after the bytes went says the change MAY have happened.
async function sendBytes(ctx, { id = '', meta, bytes, type, what, thing }) {
  const query = { fields: 'id,name,webViewLink,size', ...flags };
  const method = id ? 'PATCH' : 'POST';
  const UPLOAD = `${ctx.base.replace(/\/drive\/v3$/, '/upload/drive/v3')}/files${id ? `/${encodeURIComponent(id)}` : ''}`; // (the upload address is the same service's, next to the API's)
  const timeout = Math.min(15 * 60e3, 30e3 + bytes.length / 50); // about 50 KB/s at the least
  let res;
  try {
    if (bytes.length <= MULTIPART_MAX) {
      const boundary = `lumen${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--`)]);
      res = await ctx.http(UPLOAD, { method, query: { uploadType: 'multipart', ...query }, body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, timeout });
    } else {
      const start = await ctx.http(UPLOAD, { method, query: { uploadType: 'resumable', ...query }, json: meta, headers: { 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(bytes.length) } });
      if (!start.ok) throw Object.assign(G.failure(ctx, start, { thing }), { sure: true }); // (the session didn't start: nothing was changed)
      const where = start.headers?.get?.('location') || '';
      let sameService = false;
      try { sameService = new URL(where).origin === new URL(ctx.base).origin; } catch { /* not an address */ }
      if (!sameService) throw Object.assign(new ConnectorError(`Google gave no place to send the file. Nothing was ${what === 'update' ? 'updated' : 'uploaded'}.`, 'other'), { sure: true });
      res = await ctx.http(where, { method: 'PUT', body: bytes, headers: { 'Content-Type': type }, timeout });
    }
  } catch (err) {
    if (err instanceof ConnectorError && err.kind === 'other' && !err.sure && !/Stopped\./.test(err.message)) throw G.maybe(what, 'Drive');
    throw err;
  }
  if (res.status >= 500 || res.status === 408) throw G.maybe(what, 'Drive');
  return res;
}

// A metadata write that may have gone through (a request with no answer, or a 5xx): the AI is told to look before it tries again.
async function patchMeta(ctx, { id, method = 'PATCH', suffix = '', query = {}, json, thing = 'that file', what, where }) {
  let res;
  try { res = await ctx.http(`/files/${encodeURIComponent(id)}${suffix}`, { method, query: { fields: 'id,name,webViewLink,parents,trashed', ...query, ...flags }, json }); } catch (err) {
    if (err instanceof ConnectorError && err.kind === 'other' && !/Stopped\./.test(err.message)) throw G.maybe(what, where);
    throw err;
  }
  if (res.status >= 500 || res.status === 408) throw G.maybe(what, where);
  return G.json(ctx, res, { thing });
}

const actions = {
  async files(ctx, { query, folder_id: folder, max = 15 } = {}) {
    const parts = ['trashed = false'];
    if (query) parts.push(`(name contains '${q(query)}' or fullText contains '${q(query)}')`);
    if (folder) parts.push(`'${q(folder)}' in parents`);
    const body = G.json(ctx, await ctx.http('/files', { query: { q: parts.join(' and '), pageSize: max, orderBy: 'modifiedTime desc', fields: `files(${FILE_FIELDS})`, includeItemsFromAllDrives: 'true', ...flags } }), { thing: folder ? 'that folder' : 'files' });
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) return query ? 'No files match.' : folder ? 'That folder is empty.' : 'No files.';
    return files.map((f) => `${flat(f.id, 100)}  ${kindOf(f.mimeType)}  ${when(f.modifiedTime, { dateOnly: true })}  ${flat(f.name, 160)}${f.size ? ` (${sizeText(f.size)})` : ''}`).join('\n');
  },

  async read(ctx, { id }) {
    const f = await getFile(ctx, id, `${FILE_FIELDS},trashed`);
    const head = `${flat(f.name, 200)}\n${kindOf(f.mimeType)} · modified ${when(f.modifiedTime) || 'unknown'}${f.size ? ` · ${sizeText(f.size)}` : ''}${f.trashed ? ' · in the trash' : ''}${f.webViewLink ? `\nLink: ${flat(f.webViewLink, 300)}` : ''}`;
    if (f.mimeType === FOLDER) return `${head}\n\nThis is a folder. Use files with folder_id ${flat(f.id, 100)} to see what is inside.`;
    let res;
    if (String(f.mimeType).startsWith(GAPPS)) {
      const type = { document: 'text/plain', presentation: 'text/plain', spreadsheet: 'text/csv' }[String(f.mimeType).slice(GAPPS.length)];
      if (!type) return `${head}\n\nLumen can’t read this kind of Google file as text.`;
      res = await ctx.http(`/files/${encodeURIComponent(id)}/export`, { query: { mimeType: type }, accept: type, max: READ_MAX });
    } else if (TEXTY.test(String(f.mimeType)) && Number(f.size || 0) <= READ_MAX) {
      res = await ctx.http(`/files/${encodeURIComponent(id)}`, { query: { alt: 'media', ...flags }, accept: '*/*', max: READ_MAX });
    } else {
      return `${head}\n\nLumen reads only text files and Google Docs, Slides and Sheets, so this one is listed with its link only.`;
    }
    if (!res.ok) throw G.failure(ctx, res, { thing: 'that file' });
    return `${head}\n\n${clip(res.text, 8000) || '(empty)'}`;
  },

  async create_folder(ctx, { name, parent_id: parent }) {
    let res;
    try { res = await ctx.http('/files', { method: 'POST', query: { fields: 'id,name,webViewLink', ...flags }, json: { name: flat(name, 200), mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) } }); } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'other' && !/Stopped\./.test(err.message)) throw G.maybe('folder', 'Drive');
      throw err;
    }
    if (res.status >= 500 || res.status === 408) throw G.maybe('folder', 'Drive');
    const f = G.json(ctx, res, { thing: parent ? 'that parent folder' : 'Drive' });
    return { text: `Made the folder “${flat(f.name, 200)}” (id ${flat(f.id, 100)}).`, link: String(f.webViewLink || ''), done: `Made folder “${flat(f.name, 60)}”` };
  },

  // One NEW local file, as the user allowed it on the card.
  async upload(ctx, { folder_id: folder, name }) {
    const f = ctx.file;
    if (!f?.path) throw new ConnectorError('Give file (the ref of a file the user attached) or path (a file on this computer). Nothing was uploaded.', 'args');
    const bytes = readLocal(f, 'uploaded');
    const meta = { name: flat(name || f.name, 200) || f.name, ...(folder ? { parents: [folder] } : {}) };
    const res = await sendBytes(ctx, { meta, bytes, type: f.type || 'application/octet-stream', what: 'upload', thing: folder ? 'that folder' : 'Drive' });
    const made = G.json(ctx, res, { thing: folder ? 'that folder' : 'Drive' });
    return { text: `Uploaded “${flat(made.name, 200)}” (${sizeText(bytes.length)}) to Google Drive (id ${flat(made.id, 100)}).`, link: String(made.webViewLink || ''), done: `Uploaded ${flat(made.name, 60)}` };
  },

  // Replace the content of EXISTING files, each with the local file the card paired it with (ctx.file: a list, each with the Drive `target`
  // { id, name } the card showed). The file keeps its id, name, sharing and link; Drive keeps the old content as a version for a while.
  // Each is sent once and never repeated. A file that fails for its own reason does not stop the others; an ended sign-in or a rate limit
  // stops the rest (they are listed as not tried).
  async update(ctx) {
    needFull(ctx);
    const files = Array.isArray(ctx.file) ? ctx.file : [];
    if (!files.length || files.length > UPDATE_MAX || files.some((f) => !f?.target?.id)) throw new ConnectorError('Give id with ONE file or path, or folder_id with files or paths. Nothing was updated.', 'args');
    const lines = [];
    let done = 0;
    let stopped = false;
    let link = '';
    let lastName = '';
    let lastKind = 'other';
    for (const f of files) {
      const shown = flat(f.target.name || f.name, 200);
      if (stopped) { lines.push(`Not tried: “${shown}”.`); continue; }
      try {
        const bytes = readLocal(f, 'updated');
        const res = await sendBytes(ctx, { id: f.target.id, meta: {}, bytes, type: f.type || 'application/octet-stream', what: 'update', thing: 'that file' });
        const made = G.json(ctx, res, { thing: 'that file', hint: 'It may be in a shared drive, or this account may only be able to view it.' });
        done++;
        link = String(made.webViewLink || '');
        lastName = flat(made.name || shown, 60);
        lines.push(`Updated “${flat(made.name || shown, 200)}” (id ${flat(made.id || f.target.id, 100)}) with ${sizeText(bytes.length)}.`);
      } catch (err) {
        if (!(err instanceof ConnectorError)) throw err;
        lastKind = err.kind;
        lines.push(`“${shown}”: ${err.message}`);
        if (err.kind === 'auth' || err.kind === 'rate' || /Stopped\./.test(err.message)) stopped = true;
      }
    }
    if (!done) throw new ConnectorError(`Nothing was updated.\n${lines.join('\n')}`, lastKind);
    const head = files.length === 1 ? '' : `Updated ${done} of ${files.length} files in Google Drive.\n`;
    return { text: `${head}${lines.join('\n')}`, link: done === 1 ? link : '', done: done === 1 ? `Updated ${lastName}` : `Updated ${done} files` };
  },

  async rename(ctx, { id, name }) {
    needFull(ctx);
    const f = await patchMeta(ctx, { id, json: { name: flat(name, 200) }, what: 'rename', where: 'Drive' });
    return { text: `Renamed the file to “${flat(f.name, 200)}” (id ${flat(f.id, 100)}).`, link: String(f.webViewLink || ''), done: `Renamed to “${flat(f.name, 60)}”` };
  },

  // Into another folder: the file's current parents are taken off and the new one put on, in one request.
  async move(ctx, { id, folder_id: folder }) {
    needFull(ctx);
    const cur = await getFile(ctx, id, 'id,name,parents');
    const off = (Array.isArray(cur.parents) ? cur.parents : []).filter((p) => p !== folder);
    const f = await patchMeta(ctx, { id, query: { addParents: folder, ...(off.length ? { removeParents: off.join(',') } : {}) }, json: {}, what: 'move', where: 'Drive' });
    return { text: `Moved “${flat(f.name, 200)}” into the folder ${flat(folder, 100)}.`, link: String(f.webViewLink || ''), done: `Moved “${flat(f.name, 60)}”` };
  },

  async copy(ctx, { id, name, folder_id: folder }) {
    needFull(ctx);
    const f = await patchMeta(ctx, { id, method: 'POST', suffix: '/copy', json: { ...(name ? { name: flat(name, 200) } : {}), ...(folder ? { parents: [folder] } : {}) }, what: 'copy', where: 'Drive' });
    return { text: `Made a copy, “${flat(f.name, 200)}” (id ${flat(f.id, 100)}).`, link: String(f.webViewLink || ''), done: `Copied to “${flat(f.name, 60)}”` };
  },

  // Only to the Trash (trashed: true), where the user can restore it: Lumen never deletes a file for good.
  async trash(ctx, { id }) {
    needFull(ctx);
    const f = await patchMeta(ctx, { id, json: { trashed: true }, what: 'move to the Trash', where: 'Drive' });
    return { text: `Moved “${flat(f.name, 200)}” to the Trash in Google Drive. It can be restored from there; it was not deleted for good.`, link: '', done: `Moved “${flat(f.name, 60)}” to the Trash` };
  },

  // Anyone with the link may view.
  async share_link(ctx, { id }) {
    let res;
    try { res = await ctx.http(`/files/${encodeURIComponent(id)}/permissions`, { method: 'POST', query: { fields: 'id', ...flags }, json: { role: 'reader', type: 'anyone' } }); } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'other' && !/Stopped\./.test(err.message)) throw G.maybe('share', 'the file’s sharing settings in Drive');
      throw err;
    }
    if (res.status >= 500 || res.status === 408) throw G.maybe('share', 'the file’s sharing settings in Drive');
    G.json(ctx, res, { thing: 'that file', hint: SHARE_HINT });
    const f = await getFile(ctx, id, 'id,name,webViewLink');
    return { text: `Anyone with the link can now view “${flat(f.name, 200)}”.`, link: String(f.webViewLink || ''), done: `Shared “${flat(f.name, 60)}” by link` };
  },
};

// A write that can't happen says so before any card: an edit with only the older Drive permission.
async function beforeCard(ctx, action) {
  if (NEEDS_FULL.has(action)) needFull(ctx);
}

// Which Drive file each local file would replace, found with reads, for the card: [{ i (the local file's place), id, name, size, modified,
// local: { name, size } }] and the ones that can't be replaced, with why. One id takes ONE file; a folder takes each file of exactly the same
// name in it (none, or two files of one name there: skipped).
async function planUpdate(ctx, args) {
  const local = Array.isArray(ctx.file) ? ctx.file : [];
  const targets = [];
  const skipped = [];
  const FIELDS = 'id,name,mimeType,size,modifiedTime,trashed,capabilities(canEdit)';
  const why = (d) => (d.trashed ? 'it is in the trash' : d.mimeType === FOLDER ? 'it is a folder' : String(d.mimeType).startsWith(GAPPS) ? 'it is a Google Docs, Sheets or Slides file, which a file can’t replace' : d.capabilities?.canEdit === false ? 'this account can only view it' : '');
  const add = (i, d) => {
    const problem = why(d);
    if (problem) { skipped.push({ name: flat(d.name, 160), why: problem }); return; }
    targets.push({ i, id: flat(d.id, 100), name: flat(d.name, 160), size: Number(d.size) || 0, modified: String(d.modifiedTime || ''), local: { name: flat(local[i].name, 160), size: Number(local[i].size) || 0 } });
  };
  if (args.id) {
    add(0, await getFile(ctx, args.id, FIELDS));
  } else if (args.folder_id) {
    const wanted = [...new Set(local.map((f) => f.name))];
    const body = G.json(ctx, await ctx.http('/files', { query: { q: `'${q(args.folder_id)}' in parents and trashed = false and (${wanted.map((n) => `name = '${q(n)}'`).join(' or ')})`, pageSize: 1000, fields: `files(${FIELDS})`, includeItemsFromAllDrives: 'true', ...flags } }), { thing: 'that folder' });
    const found = new Map();
    for (const d of Array.isArray(body.files) ? body.files : []) found.set(d.name, [...(found.get(d.name) || []), d]);
    local.forEach((f, i) => {
      const hits = found.get(f.name) || [];
      if (!hits.length) skipped.push({ name: flat(f.name, 160), why: 'no file with exactly that name in the folder' });
      else if (hits.length > 1) skipped.push({ name: flat(f.name, 160), why: `${hits.length} files with that name in the folder, so it is unclear which` });
      else add(i, hits[0]);
    });
  }
  return { targets, skipped };
}

// The card: names looked up with a read (a failed lookup shows the id instead).
async function cardNames(ctx, action, args) {
  const names = {};
  const lookup = async (id) => { try { return flat((await getFile(ctx, id, 'name')).name, 120); } catch { return ''; } };
  if (action === 'share_link' || action === 'rename' || action === 'trash' || action === 'copy') names.file = await lookup(args.id);
  if (action === 'move') {
    let cur = null;
    try { cur = await getFile(ctx, args.id, 'name,parents'); } catch { /* the card shows the id */ }
    if (cur) { names.file = flat(cur.name, 120); const from = (Array.isArray(cur.parents) ? cur.parents : []).slice(0, 3); names.from = (await Promise.all(from.map(lookup))).filter(Boolean).join(', '); }
  }
  if (action === 'upload' && args.folder_id) names.folder = await lookup(args.folder_id);
  if ((action === 'move' || action === 'copy') && args.folder_id) names.folder = await lookup(args.folder_id);
  if (action === 'create_folder' && args.parent_id) names.folder = await lookup(args.parent_id);
  if (action === 'update') {
    if (args.folder_id) names.folder = await lookup(args.folder_id);
    try { names.plan = await planUpdate(ctx, args); } catch (err) { names.plan = { targets: [], skipped: [], error: err instanceof ConnectorError ? err.message : 'Lumen couldn’t look those files up in Drive.' }; }
  }
  return names;
}

const intoFolder = (id, names) => (id ? `the folder ${names.folder ? `“${names.folder}”` : id}` : 'My Drive');
const account = 'your Google Drive';
function describeWhere(action, args, names = {}) {
  const file = names.file ? `“${names.file}”` : `the file ${args.id}`;
  if (action === 'create_folder') return `Makes a new folder in ${intoFolder(args.parent_id, names)} of ${account}.`;
  if (action === 'upload') {
    const f = names.file || {};
    return `Uploads this ONE file from this computer to ${intoFolder(args.folder_id, names)} of ${account}. Its contents go to Google.\nFile: ${f.name || args.file || args.path} (${sizeText(f.size)})`;
  }
  if (action === 'update') {
    const n = names.plan?.targets?.length || 0;
    const into = args.folder_id ? ` in ${intoFolder(args.folder_id, names)}` : '';
    return `Replaces the contents of ${n === 1 ? 'ONE existing file' : `${n} existing files`}${into} of ${account} with ${n === 1 ? 'a file' : 'files'} from this computer. The new contents go to Google. Each file keeps its name, link and sharing; Drive keeps the earlier content as a version for a limited time.`;
  }
  if (action === 'rename') return `Renames ${file} in ${account}. Its link, sharing and contents stay the same.`;
  if (action === 'move') return `Moves ${file}${names.from ? ` out of “${names.from}”` : ''} into ${intoFolder(args.folder_id, names)} of ${account}. Its link and sharing stay the same.`;
  if (action === 'copy') return `Makes a copy of ${file} ${args.folder_id ? `in ${intoFolder(args.folder_id, names)}` : 'in the same place'} of ${account}.`;
  if (action === 'trash') return `Moves ${file} to the Trash in ${account}. It is NOT deleted for good: it can be restored from the Trash in Drive, which Google empties after 30 days.`;
  if (action === 'share_link') return `Lets anyone who has the link view ${names.file ? `“${names.file}”` : `the file ${args.id}`}. It stays shared until you change it in Drive.`;
  return '';
}
function describeWrite(action, args, names = {}) {
  const where = describeWhere(action, args, names);
  if (action === 'create_folder') return `${where}\n\nName: ${args.name}`;
  if (action === 'upload') return `${where}\nName in Drive: ${args.name || names.file?.name || ''}`;
  if (action === 'rename') return `${where}\n\nNew name: ${args.name}`;
  if (action === 'copy') return `${where}\n\nName of the copy: ${args.name || '(Google’s default, “Copy of …”)'}`;
  if (action === 'update') {
    const { targets = [], skipped = [] } = names.plan || {};
    const rows = targets.map((t) => `• ${t.name} (${sizeText(t.size)}${t.modified ? `, changed ${when(t.modified, { dateOnly: true })}` : ''}) ← ${t.local.name} (${sizeText(t.local.size)})`);
    const skip = skipped.length ? `\n\nNot updated (${skipped.length}), left as they are:\n${skipped.map((s) => `• ${s.name}: ${s.why}`).join('\n')}` : '';
    return `${where}\n\nIn Drive ← from this computer:\n${rows.join('\n')}${skip}`;
  }
  return where;
}

module.exports = { verify, actions, beforeCard, cardNames, describeWrite, describeWhere, UPDATE_MAX };
