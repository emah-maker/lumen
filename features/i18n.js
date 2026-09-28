// UI strings: locales/en.json is the source, and locales/<lang>.json (e.g. de.json, pt-BR.json)
// overrides any of its keys. The locale follows the system's (app.getLocale()); a key missing from
// it falls back to English, and a key missing from English shows as the key itself, so a gap is
// visible rather than blank. Main-process menus and dialogs call t(); the UI window and the
// settings page get the merged table through their preloads (ui:strings, settings:strings).
// Adding a locale: see CONTRIBUTING.md.
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'locales');

function readTable(dir, name) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// 'pt-BR' tries pt-BR.json, then pt.json. Only letters, digits and '-' reach the file system.
function candidates(locale) {
  const clean = String(locale || '').replace(/_/g, '-').replace(/[^A-Za-z0-9-]/g, '');
  if (!clean) return [];
  const base = clean.split('-')[0];
  return [...new Set([clean, base])].filter((name) => name.toLowerCase() !== 'en');
}

function format(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole));
}

// A string table: `t(key, vars)` with {name} placeholders. Kept as a factory so the tests can load
// any folder and locale.
function createI18n({ locale = 'en', dir = DEFAULT_DIR } = {}) {
  const english = readTable(dir, 'en');
  let chosen = 'en';
  let overrides = {};
  for (const name of candidates(locale)) {
    const table = readTable(dir, name);
    if (Object.keys(table).length) { chosen = name; overrides = table; break; }
  }
  const strings = { ...english };
  for (const [key, value] of Object.entries(overrides)) if (typeof value === 'string' && value) strings[key] = value;
  const t = (key, vars) => format(typeof strings[key] === 'string' ? strings[key] : key, vars);
  return { locale: chosen, strings, english, t };
}

// The app's own table, made on first use (app.getLocale() is only reliable once the app is ready).
// In test mode LUMEN_LOCALE / LUMEN_LOCALES_DIR pick the locale and folder.
let current = null;
function i18n() {
  if (current) return current;
  // Plain Node (the unit tests) has no `app`: English.
  const app = process.type === 'browser' ? require('electron').app : null;
  const test = Boolean(app) && require('../test-mode').isTest();
  const locale = (test && process.env.LUMEN_LOCALE) || app?.getLocale() || 'en';
  const dir = (test && process.env.LUMEN_LOCALES_DIR) || DEFAULT_DIR;
  current = createI18n({ locale, dir });
  return current;
}

const t = (key, vars) => i18n().t(key, vars);

module.exports = { createI18n, i18n, t, candidates, format };
