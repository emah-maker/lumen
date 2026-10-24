// Google Drive through the shared Google sign-in (connectors/google-auth.js), with the Drive API v3 at www.googleapis.com.
// Reads: find files, read one file's text. Writes (each asks the user on a card first): make a folder, upload ONE local file, share a
// file by link. The AI never names a file on disk: an upload takes a chat attachment's ref, or (only when the user allowed files on this
// computer) a path, and the agent resolves it through the same checks as upload_file (features/device-access.js: no credentials folders,
// no Lumen profile) before the card, which names the file and its size. ctx.file is that checked file; it is looked at again here.
'use strict';
const fs = require('fs');
const { flat, clip, when, ConnectorError } = require('../util');
const G = require('./_google');

const GAPPS = 'application/vnd.google-apps.';
const FOLDER = `${GAPPS}folder`;
const MULTIPART_MAX = 5 * 1024 * 1024; // up to this: one multipart request; above: a resumable upload session
const READ_MAX = 2e6; // the most text of a file that is fetched
const TEXTY = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|rtf)$|application\/.+\+(json|xml)$)/;
const SHORT = { document: 'doc', spreadsheet: 'sheet', presentation: 'slides', folder: 'folder', form: 'form', drawing: 'drawing' };

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

  // One local file, as the user allowed it on the card. A small one goes in a single multipart request; a larger one through a resumable
  // upload session (a start request, then the bytes in one PUT). Either is sent once and never repeated by Lumen.
  async upload(ctx, { folder_id: folder, name }) {
    const f = ctx.file;
    if (!f?.path) throw new ConnectorError('Give file (the ref of a file the user attached) or path (a file on this computer). Nothing was uploaded.', 'args');
    let stat;
    try { stat = fs.statSync(f.path); } catch { throw new ConnectorError('That file can’t be read any more. Nothing was uploaded.', 'args'); }
    if (!stat.isFile() || stat.size !== f.size || (f.mtimeMs && Math.abs(stat.mtimeMs - f.mtimeMs) > 1)) throw new ConnectorError('The file changed after the user allowed it, so it was not uploaded. Ask again.', 'args');
    const bytes = fs.readFileSync(f.path);
    if (bytes.length !== f.size) throw new ConnectorError('The file changed while it was being read, so it was not uploaded. Ask again.', 'args');
    const meta = { name: flat(name || f.name, 200) || f.name, ...(folder ? { parents: [folder] } : {}) };
    const type = f.type || 'application/octet-stream';
    const query = { fields: 'id,name,webViewLink,size', ...flags };
    const UPLOAD = `${ctx.base.replace(/\/drive\/v3$/, '/upload/drive/v3')}/files`; // (the upload address is the same service's, next to the API's)
    const timeout = Math.min(15 * 60e3, 30e3 + bytes.length / 50); // about 50 KB/s at the least
    let res;
    try {
      if (bytes.length <= MULTIPART_MAX) {
        const boundary = `lumen${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
        const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--`)]);
        res = await ctx.http(UPLOAD, { method: 'POST', query: { uploadType: 'multipart', ...query }, body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, timeout });
      } else {
        const start = await ctx.http(UPLOAD, { method: 'POST', query: { uploadType: 'resumable', ...query }, json: meta, headers: { 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(bytes.length) } });
        if (!start.ok) throw Object.assign(G.failure(ctx, start, { thing: folder ? 'that folder' : 'Drive' }), { sure: true }); // (the session didn't start: nothing was made)
        const where = start.headers?.get?.('location') || '';
        let sameService = false;
        try { sameService = new URL(where).origin === new URL(ctx.base).origin; } catch { /* not an address */ }
        if (!sameService) throw Object.assign(new ConnectorError('Google gave no place to send the file. Nothing was uploaded.', 'other'), { sure: true });
        res = await ctx.http(where, { method: 'PUT', body: bytes, headers: { 'Content-Type': type }, timeout });
      }
    } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'other' && !err.sure && !/Stopped\./.test(err.message)) throw G.maybe('upload', 'Drive');
      throw err;
    }
    if (res.status >= 500 || res.status === 408) throw G.maybe('upload', 'Drive');
    const made = G.json(ctx, res, { thing: folder ? 'that folder' : 'Drive' });
    return { text: `Uploaded “${flat(made.name, 200)}” (${sizeText(bytes.length)}) to Google Drive (id ${flat(made.id, 100)}).`, link: String(made.webViewLink || ''), done: `Uploaded ${flat(made.name, 60)}` };
  },

  // Anyone with the link may view. drive.file reaches only files Lumen made or uploaded, so for any other file Google says no.
  async share_link(ctx, { id }) {
    const hint = 'Lumen can only share files it made or uploaded itself.';
    let res;
    try { res = await ctx.http(`/files/${encodeURIComponent(id)}/permissions`, { method: 'POST', query: { fields: 'id', ...flags }, json: { role: 'reader', type: 'anyone' } }); } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'other' && !/Stopped\./.test(err.message)) throw G.maybe('share', 'the file’s sharing settings in Drive');
      throw err;
    }
    if (res.status >= 500 || res.status === 408) throw G.maybe('share', 'the file’s sharing settings in Drive');
    G.json(ctx, res, { thing: 'that file', hint });
    const f = await getFile(ctx, id, 'id,name,webViewLink');
    return { text: `Anyone with the link can now view “${flat(f.name, 200)}”.`, link: String(f.webViewLink || ''), done: `Shared “${flat(f.name, 60)}” by link` };
  },
};

// The card: names looked up with a read (a failed lookup shows the id instead).
async function cardNames(ctx, action, args) {
  const names = {};
  const lookup = async (id) => flat((await getFile(ctx, id, 'name')).name, 120);
  if (action === 'share_link') names.file = await lookup(args.id);
  if (action === 'upload' && args.folder_id) names.folder = await lookup(args.folder_id);
  if (action === 'create_folder' && args.parent_id) names.folder = await lookup(args.parent_id);
  return names;
}

const intoFolder = (id, names) => (id ? `the folder ${names.folder ? `“${names.folder}”` : id}` : 'My Drive');
function describeWhere(action, args, names = {}) {
  const account = 'your Google Drive';
  if (action === 'create_folder') return `Makes a new folder in ${intoFolder(args.parent_id, names)} of ${account}.`;
  if (action === 'upload') {
    const f = names.file || {};
    return `Uploads this ONE file from this computer to ${intoFolder(args.folder_id, names)} of ${account}. Its contents go to Google.\nFile: ${f.name || args.file || args.path} (${sizeText(f.size)})`;
  }
  if (action === 'share_link') return `Lets anyone who has the link view ${names.file ? `“${names.file}”` : `the file ${args.id}`}. It stays shared until you change it in Drive.`;
  return '';
}
function describeWrite(action, args, names = {}) {
  const where = describeWhere(action, args, names);
  if (action === 'create_folder') return `${where}\n\nName: ${args.name}`;
  if (action === 'upload') return `${where}\nName in Drive: ${args.name || names.file?.name || ''}`;
  return where;
}

module.exports = { verify, actions, cardNames, describeWrite, describeWhere };
