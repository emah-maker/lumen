// [profiles] Separate Lumens on one computer: each profile is its own userData folder (cookies, history, passwords, chats,
// settings, extensions), run by its own Lumen process. docs/profiles.md has the design.
//
//   - The Default profile is the folder Lumen always used (userData as profile-guard left it). Nothing here moves, copies or
//     writes into it.
//   - Other profiles are folders in a sibling folder, `<userData> Profiles\<id>` (%APPDATA%\Lumen Profiles\p-1a2b3c4d), with
//     the list (name, colour, avatar) in `<userData> Profiles\profiles.json`. The Default profile's own name, colour and
//     avatar are kept in that list too.
//   - A profile runs as `Lumen --lumen-profile=<id>`: apply() reads the switch first thing in main.js, right after
//     profile-guard, and points userData at the profile's folder before anything reads it.
const fs = require('fs');
const path = require('path');

const DEFAULT_ID = 'default';
const ARG = '--lumen-profile=';
const ID_RE = /^p-[a-z0-9]{8}$/;
const LIST_FILE = 'profiles.json';
const MAX_NAME = 40;
const MAX_PROFILES = 50;

// The colours a profile can have (the toolbar button's circle, the menu's dot). Ids are stored; the hex is how they look.
const COLORS = [
  { id: 'blue', hex: '#3b82f6' }, { id: 'teal', hex: '#14b8a6' }, { id: 'green', hex: '#22c55e' }, { id: 'yellow', hex: '#eab308' },
  { id: 'orange', hex: '#f97316' }, { id: 'red', hex: '#ef4444' }, { id: 'pink', hex: '#ec4899' }, { id: 'purple', hex: '#8b5cf6' },
  { id: 'gray', hex: '#6b7280' },
];
// The avatars: '' is the name's first letter; the rest are emoji.
const AVATARS = ['', '🙂', '😎', '🐱', '🐶', '🦊', '🐼', '🦉', '🌿', '🌸', '🔥', '⭐', '🚀', '🎨', '🎮', '🎵', '📚', '💼', '🏠', '🏖️'];

const colorHex = (id) => (COLORS.find((c) => c.id === id) || COLORS[0]).hex;
const cleanName = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
const cleanColor = (c, fallback = 'blue') => (COLORS.some((x) => x.id === c) ? c : fallback);
const cleanAvatar = (a) => (AVATARS.includes(a) ? a : '');
// The letter a profile without an avatar shows.
const initial = (name) => (Array.from(cleanName(name))[0] || '?').toUpperCase();

// `<base> Profiles`, next to the Default folder (never inside it).
function rootFor(base) { return String(base).replace(/[\\/]+$/, '') + ' Profiles'; }

// The profile id named on the command line, or null.
function argId(argv = process.argv) {
  for (const a of argv || []) if (typeof a === 'string' && a.startsWith(ARG)) return a.slice(ARG.length);
  return null;
}

// The list as stored, made safe: [{ id, name, color, avatar, created }], Default first. `raw` is whatever profiles.json held.
function normalize(raw) {
  const list = Array.isArray(raw?.profiles) ? raw.profiles : [];
  const seen = new Set();
  const out = [];
  const stored = list.find((p) => p && p.id === DEFAULT_ID) || {};
  out.push({ id: DEFAULT_ID, name: cleanName(stored.name) || 'Default', color: cleanColor(stored.color), avatar: cleanAvatar(stored.avatar), created: 0 });
  seen.add(DEFAULT_ID);
  for (const p of list) {
    if (!p || typeof p !== 'object' || !ID_RE.test(String(p.id)) || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ id: p.id, name: cleanName(p.name) || 'Profile', color: cleanColor(p.color), avatar: cleanAvatar(p.avatar), created: Number(p.created) || 0 });
  }
  return out.slice(0, MAX_PROFILES + 1);
}

// The list file and the profile folders under `root`, for the profile whose base (Default) folder is `base`.
//   deps: fs, now(), randomId() (8 of [a-z0-9]), writeJson(file, data) (atomic, with a .bak), readJson(file) (its recovery)
function createStore({ base, root = rootFor(base), deps = {} }) {
  const fsx = deps.fs || fs;
  const now = deps.now || Date.now;
  const randomId = deps.randomId || (() => require('crypto').randomBytes(4).toString('hex'));
  const settingsFile = () => require('../settings/settings-file');
  const readJson = deps.readJson || ((file) => (fsx.existsSync(file) ? settingsFile().loadJson(file) : {}));
  const writeJson = deps.writeJson || ((file, data) => settingsFile().writeJsonAtomic(file, data));
  const file = path.join(root, LIST_FILE);

  const list = () => normalize(readJson(file));
  const get = (id) => list().find((p) => p.id === id) || null;
  const save = (profiles) => writeJson(file, { version: 1, profiles });
  // A profile's folder: the base for Default, `<root>/<id>` for the rest (null for an id that is not a profile id).
  const dirOf = (id) => (id === DEFAULT_ID ? base : ID_RE.test(String(id)) ? path.join(root, id) : null);

  function add({ name, color, avatar } = {}) {
    const profiles = list();
    if (profiles.length > MAX_PROFILES) throw new Error('Too many profiles');
    let id;
    do id = `p-${randomId()}`; while (profiles.some((p) => p.id === id) || fsx.existsSync(path.join(root, id)));
    const used = new Set(profiles.map((p) => p.color));
    const profile = {
      id,
      name: cleanName(name) || `Profile ${profiles.length + 1}`,
      color: cleanColor(color, (COLORS.find((c) => !used.has(c.id)) || COLORS[profiles.length % COLORS.length]).id),
      avatar: cleanAvatar(avatar),
      created: now(),
    };
    fsx.mkdirSync(path.join(root, id), { recursive: true });
    save([...profiles, profile]);
    return profile;
  }

  function update(id, patch = {}) {
    const profiles = list();
    const p = profiles.find((x) => x.id === id);
    if (!p) return null;
    if ('name' in patch && cleanName(patch.name)) p.name = cleanName(patch.name);
    if ('color' in patch) p.color = cleanColor(patch.color, p.color);
    if ('avatar' in patch) p.avatar = cleanAvatar(patch.avatar);
    save(profiles);
    return p;
  }

  // Takes the profile off the list (its folder is the caller's: see remove() in createProfiles). Default can't go.
  function forget(id) {
    if (id === DEFAULT_ID) return false;
    const profiles = list();
    if (!profiles.some((p) => p.id === id)) return false;
    save(profiles.filter((p) => p.id !== id));
    return true;
  }

  return { base, root, file, list, get, dirOf, add, update, forget };
}

// Is a Lumen running on this profile folder? Windows: a folder with a running browser in it can't be renamed (its files are
// open), which is also the first step of deleting it, so the caller just tries. Elsewhere: Chromium's SingletonLock link
// names "<host>-<pid>" of the process holding it.
function lockHolderAlive(dir, { fs: fsx = fs, kill = process.kill.bind(process) } = {}) {
  let target;
  try { target = fsx.readlinkSync(path.join(dir, 'SingletonLock')); } catch { return false; }
  const pid = Number(/-(\d+)$/.exec(String(target))?.[1]);
  if (!pid) return false;
  try { kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

// How to start Lumen on profile `id`: { command, args, env }. A development run passes the app folder; a test run's child must
// find the same base folder (profile-guard reads CLAUDE_BROWSER_PROFILE), which this process may have pointed at its own profile.
function launchSpec({ id, execPath = process.execPath, packaged, appPath, env = process.env, test = false, base }) {
  const args = [...(packaged ? [] : [appPath]), `${ARG}${id}`];
  const childEnv = { ...env };
  if (test) childEnv.CLAUDE_BROWSER_PROFILE = base;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return { command: execPath, args, env: childEnv };
}

let current = null; // { id, base, root, dir }: set by apply(), read by the UI

// main.js, first thing after profile-guard: point userData at the profile named on the command line. Returns `current`.
// An id that isn't on the list (a deleted profile, a typo) starts the Default profile.
function apply(app, { test = false, env = process.env, argv = process.argv, fs: fsx = fs } = {}) {
  const base = app.getPath('userData');
  const store = createStore({ base, deps: { fs: fsx } });
  current = { id: DEFAULT_ID, base, root: store.root, dir: base };
  const wanted = argId(argv);
  if (!wanted || wanted === DEFAULT_ID) return current;
  let known = null;
  try { known = store.get(wanted); } catch { /* unreadable list: Default */ }
  if (!known) { console.error(`[lumen] no profile "${wanted}": starting the Default profile`); return current; }
  const dir = store.dirOf(wanted);
  try { fsx.mkdirSync(dir, { recursive: true }); } catch { /* Electron makes it */ }
  app.setPath('userData', dir);
  if (test) env.CLAUDE_BROWSER_PROFILE = dir; // (the rest of the app, and the processes it starts, read the variable too)
  current = { id: wanted, base, root: store.root, dir };
  return current;
}

module.exports = { DEFAULT_ID, ARG, ID_RE, COLORS, AVATARS, MAX_NAME, colorHex, cleanName, initial, rootFor, argId, normalize, createStore, lockHolderAlive, launchSpec, apply, current: () => current };
