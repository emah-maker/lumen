// [project drive] Save chosen projects to Google Drive, as readable files in Lumen/Projects/<name> (Markdown and JSON), and bring one back on
// another computer. Electron-free: test/units/project-drive-units.js runs it with a fake Drive. main.js gives it the signed-in Google Drive
// connector's request function (connectors/service.js driveRequest: the same sign-in and the drive.file permission Lumen already asks for, which
// lets it see and change only the files it made) and a small state file in the profile, project-drive.json.
//
// What a save writes: README.md, INSTRUCTIONS.md, project.json (the name, goal line and defaults), sources.md, Memory.md and memory.json (the
// project's notes), Key documents.md and key-documents.json (where its documents are), and Chats/<title>.md (its chats as Markdown). Never the
// files added to the project (Sources/), never another project. Only files whose text changed since the last save are sent.
'use strict';
const crypto = require('crypto');

const FOLDER = 'application/vnd.google-apps.folder';
const ROOT = 'Lumen';
const PROJECTS = 'Projects';
const CHATS = 'Chats';
const DEBOUNCE_MS = 30 * 1000; // after the last change
const hash = (text) => crypto.createHash('sha1').update(String(text)).digest('hex');
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Project';

// The Drive v3 calls a save and an import need, over the connector's http(target, opts) -> { ok, status, text }.
function driveClient(http, { uploadBase = 'https://www.googleapis.com/upload/drive/v3' } = {}) {
  const json = (res, what) => {
    if (!res?.ok) { const e = new Error(`Google Drive said ${res?.status || 'no'} to ${what}.`); e.status = res?.status || 0; throw e; }
    try { return JSON.parse(res.text || '{}'); } catch { return {}; }
  };
  const list = async (query, fields = 'files(id,name,modifiedTime,mimeType)') => {
    const out = [];
    let pageToken = '';
    for (let i = 0; i < 20; i++) {
      const body = json(await http('/files', { query: { q: query, fields: `nextPageToken,${fields}`, pageSize: 200, spaces: 'drive', ...(pageToken ? { pageToken } : {}) } }), 'a list of files');
      out.push(...(body.files || []));
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return out;
  };
  const parentQ = (parent) => `'${q(parent || 'root')}' in parents`;
  return {
    async findFolder(name, parent) { return (await list(`name = '${q(name)}' and mimeType = '${FOLDER}' and ${parentQ(parent)} and trashed = false`))[0]?.id || null; },
    async makeFolder(name, parent) { return json(await http('/files', { method: 'POST', query: { fields: 'id' }, json: { name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) } }), 'a new folder').id; },
    async listFolders(parent) { return (await list(`mimeType = '${FOLDER}' and ${parentQ(parent)} and trashed = false`)).map((f) => ({ id: f.id, name: f.name, modified: Date.parse(f.modifiedTime) || 0 })); },
    async listFiles(parent) { return (await list(`mimeType != '${FOLDER}' and ${parentQ(parent)} and trashed = false`)).map((f) => ({ id: f.id, name: f.name })); },
    async rename(id, name) { json(await http(`/files/${encodeURIComponent(id)}`, { method: 'PATCH', query: { fields: 'id' }, json: { name } }), 'a rename'); },
    // A new file (no id) or new content for one Lumen made: one multipart request (these files are text, well under 5 MB).
    async writeFile({ id = null, parent, name, text, type = 'text/markdown' }) {
      const boundary = `lumen${crypto.randomBytes(8).toString('hex')}`;
      const meta = id ? { name } : { name, parents: [parent] };
      const body = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`, 'utf8');
      const target = `${uploadBase}/files${id ? `/${encodeURIComponent(id)}` : ''}`;
      return json(await http(target, { method: id ? 'PATCH' : 'POST', query: { uploadType: 'multipart', fields: 'id' }, body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } }), `saving ${name}`).id;
    },
    async readFile(id) { const res = await http(`/files/${encodeURIComponent(id)}`, { query: { alt: 'media' }, accept: '*/*', max: 4e6 }); if (!res?.ok) throw new Error(`Google Drive said ${res?.status || 'no'} to reading a file.`); return String(res.text || ''); },
  };
}

// state: { get(projectId) -> { on, folder, files: { name: { id, hash } }, saved, error } | null, set(projectId, value|null) }
function createProjectDrive({ client, state, now = () => Date.now() }) {
  let base = null; // the Lumen/Projects folder's id, once found or made
  async function projectsFolder() {
    if (base) return base;
    const c = client();
    const root = (await c.findFolder(ROOT, null)) || (await c.makeFolder(ROOT, null));
    base = (await c.findFolder(PROJECTS, root)) || (await c.makeFolder(PROJECTS, root));
    return base;
  }
  // Writes what changed: files is [{ name: 'Memory.md' | 'Chats/x.md', text, type? }]. Answers { written, kept, folder }.
  async function save(projectId, name, files) {
    const c = client();
    const st = { files: {}, ...(state.get(projectId) || {}) };
    const parent = await projectsFolder();
    let folder = st.folder;
    if (folder) {
      const there = (await c.listFolders(parent)).find((f) => f.id === folder);
      if (!there) folder = null; // (deleted or moved in Drive: a new one is made)
      else if (there.name !== cleanName(name)) await c.rename(folder, cleanName(name)); // the project was renamed
    }
    if (!folder) { folder = await c.makeFolder(cleanName(name), parent); st.files = {}; }
    let chatsFolder = st.chats || null;
    const wantChats = files.some((f) => f.name.startsWith(`${CHATS}/`));
    if (wantChats && chatsFolder && !(await c.listFolders(folder)).some((f) => f.id === chatsFolder)) chatsFolder = null;
    if (wantChats && !chatsFolder) chatsFolder = (await c.findFolder(CHATS, folder)) || (await c.makeFolder(CHATS, folder));
    let written = 0;
    let kept = 0;
    const next = {};
    for (const f of files) {
      const inChats = f.name.startsWith(`${CHATS}/`);
      const leaf = inChats ? f.name.slice(CHATS.length + 1) : f.name;
      const h = hash(f.text);
      const old = st.files[f.name];
      if (old && old.hash === h) { next[f.name] = old; kept++; continue; }
      let id;
      try { id = await c.writeFile({ id: old?.id || null, parent: inChats ? chatsFolder : folder, name: leaf, text: f.text, type: f.type || (leaf.endsWith('.json') ? 'application/json' : 'text/markdown') }); } catch (err) {
        if (!old?.id || err.status !== 404) throw err;
        id = await c.writeFile({ parent: inChats ? chatsFolder : folder, name: leaf, text: f.text, type: f.type }); // (its file was deleted in Drive: made again)
      }
      next[f.name] = { id, hash: h };
      written++;
    }
    state.set(projectId, { ...st, on: true, folder, chats: chatsFolder, files: next, saved: now(), error: '' });
    return { written, kept, folder };
  }
  // The projects saved in Drive (Lumen/Projects/*), newest first, for "Import from Drive".
  async function listSaved() {
    const parent = await projectsFolder();
    return (await client().listFolders(parent)).sort((a, b) => b.modified - a.modified);
  }
  // One saved project's files, by name (the top level; Chats/ is left in Drive).
  async function read(folderId) {
    const c = client();
    const out = {};
    for (const f of await c.listFiles(folderId)) if (/\.(md|json)$/i.test(f.name)) out[f.name] = await c.readFile(f.id);
    return out;
  }
  return { save, listSaved, read, reset: () => { base = null; } };
}

// The readable files for one project. what: { project, notes: [{ text, pinned }], places: [{ label, kind, loc, pinned }], chats: [{ name, text }],
// readme, instructions, sources, settings } (the export's own texts, main.js buildProjectExport).
function filesFor({ project, notes = [], places = [], chats = [], readme = '', instructions = '', sources = '', settings = '' }) {
  const files = [
    { name: 'README.md', text: readme || `# ${project.name}\n\nA Lumen project saved to Google Drive.\n` },
    { name: 'INSTRUCTIONS.md', text: instructions },
    { name: 'project.json', text: settings || `${JSON.stringify({ format: 1, name: project.name, description: project.description || '', defaults: project.defaults || {} }, null, 2)}\n`, type: 'application/json' },
    { name: 'sources.md', text: sources },
    { name: 'Memory.md', text: `# Memory\n\nWhat the AI saved in this project's chats.\n\n${notes.map((n) => `- ${n.pinned ? '(pinned) ' : ''}${String(n.text).replace(/\s+/g, ' ').trim()}`).join('\n')}\n` },
    { name: 'memory.json', text: `${JSON.stringify({ format: 1, notes: notes.map((n) => ({ text: n.text, ...(n.pinned ? { pinned: true } : {}) })) }, null, 2)}\n`, type: 'application/json' },
    { name: 'Key documents.md', text: `# Key documents\n\nWhere this project's documents are, most used first.\n\n${places.map((p) => `- ${p.pinned ? '(pinned) ' : ''}[${String(p.label).replace(/[[\]]/g, '')}](${p.loc}) (${p.kind})`).join('\n')}\n` },
    { name: 'key-documents.json', text: `${JSON.stringify({ format: 1, places: places.map((p) => ({ label: p.label, kind: p.kind, loc: p.loc, ...(p.pinned ? { pinned: true } : {}) })) }, null, 2)}\n`, type: 'application/json' },
    ...chats.map((c) => ({ name: `${CHATS}/${c.name}`, text: c.text })),
  ];
  return files;
}

// A saved project read back: { name, description, defaults, instructions, sourcesText, notes: [{ text, pinned }], places: [{ label, loc, pinned }] }.
function parseSaved(files) {
  let settings = {};
  try { settings = JSON.parse(files['project.json'] || '{}'); } catch { /* defaults */ }
  let notes = [];
  try { notes = (JSON.parse(files['memory.json'] || '{}').notes || []).filter((n) => typeof n?.text === 'string'); } catch { notes = []; }
  if (!notes.length && files['Memory.md']) notes = files['Memory.md'].split(/\r?\n/).filter((l) => /^- /.test(l)).map((l) => ({ text: l.slice(2).replace(/^\(pinned\) /, ''), pinned: /^- \(pinned\) /.test(l) }));
  let places = [];
  try { places = (JSON.parse(files['key-documents.json'] || '{}').places || []).filter((p) => typeof p?.loc === 'string'); } catch { places = []; }
  return {
    name: cleanName(settings.name),
    description: typeof settings.description === 'string' ? settings.description : '',
    defaults: settings.defaults && typeof settings.defaults === 'object' ? settings.defaults : {},
    instructions: String(files['INSTRUCTIONS.md'] || '').trim(),
    sourcesText: String(files['sources.md'] || ''),
    notes: notes.slice(0, 60).map((n) => ({ text: String(n.text).slice(0, 300), pinned: n.pinned === true })),
    places: places.slice(0, 60).map((p) => ({ label: String(p.label || '').slice(0, 80), loc: String(p.loc).slice(0, 2000), pinned: p.pinned === true })),
  };
}

module.exports = { ROOT, PROJECTS, CHATS, DEBOUNCE_MS, driveClient, createProjectDrive, filesFor, parseSaved, cleanName };
