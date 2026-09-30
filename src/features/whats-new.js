// "What's new" after an update: once Lumen starts on a newer version than the one the user last
// saw, the release notes for every version in between come up once over the window (the dialogs
// overlay, features/dialogs.js showNotes), with "Got it" and a "Show what's new after updates" switch.
//
// The notes are CHANGELOG.md, shipped inside the app (package.json build.files re-includes it after
// "!*.md"), so they work offline and are exactly what the release says. Each "## x.y.z (date)"
// section is a release; "## Unreleased" is skipped.
//
// settings.json keeps `lastSeenVersion` (the newest version the user has run) and `showWhatsNew`
// (the switch, default on; settings-backend.js validates both). A first run ever records the version
// and shows nothing; a downgrade changes nothing. Test mode never shows it on its own: a test opts in
// with LUMEN_WHATS_NEW_TEST=1 (packaged builds ignore test mode, see test-mode.js). It is drawn over
// the normal browser window only, never a private one (those have no dialogs overlay).
const fs = require('fs');
const path = require('path');

const CHANGELOG = path.join(__dirname, '..', '..', 'CHANGELOG.md');
const CHANGELOG_URL = 'https://github.com/emah-maker/lumen/blob/main/CHANGELOG.md';
const MAX_RELEASES = 12; // a long-skipped update lists this many, newest first, and links to the rest
const ON_DEMAND = 3; // Help → What's New… shows this many releases up to the running one

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const cleanVersion = (v) => (typeof v === 'string' && VERSION.test(v.trim()) && v.trim().length <= 40 ? v.trim() : null);

// -1, 0 or 1. A prerelease (0.4.0-beta.1) sorts before its release; prerelease tags compare as text.
function compareVersions(a, b) {
  const pa = VERSION.exec(String(a));
  const pb = VERSION.exec(String(b));
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

// CHANGELOG.md -> [{ version, date, blocks: [{ type: 'li' | 'p', text }] }], in file order (newest
// first). A bullet's wrapped lines join it; blank lines end a paragraph.
function parseChangelog(text) {
  const releases = [];
  let current = null;
  let block = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      block = null;
      const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s*\(([^)]*)\))?/.exec(heading[1]);
      current = m ? { version: m[1], date: (m[2] || '').trim(), blocks: [] } : null; // Unreleased and anything else: skipped
      if (current) releases.push(current);
      continue;
    }
    if (/^#\s/.test(raw)) { current = null; block = null; continue; } // the file's own title
    if (!current) continue;
    const line = raw.trim().replace(/^#{3,6}\s+/, ''); // a sub-heading reads as a paragraph
    if (!line) { block = null; continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      block = { type: 'li', text: bullet[1] };
      current.blocks.push(block);
    } else if (block) {
      block.text += ` ${line}`;
    } else {
      block = { type: 'p', text: line };
      current.blocks.push(block);
    }
  }
  return releases.filter((r) => r.blocks.length);
}

// Releases newer than `from` and not newer than `to`, newest first.
function releasesBetween(releases, from, to) {
  return releases
    .filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

// What to do at startup: { show, record } (record: the version to store, or null).
function decide({ stored, current, enabled }) {
  const now = cleanVersion(current);
  if (!now) return { show: false, record: null };
  const seen = cleanVersion(stored);
  if (!seen) return { show: false, record: now }; // first run ever (or a broken value): nothing to announce
  if (compareVersions(now, seen) <= 0) return { show: false, record: null }; // same version, or a downgrade
  return { show: enabled !== false, record: now };
}

// deps: { app, readSettings, writeSettings, showNotes(opts) -> Promise<{ checkboxChecked }>, t,
//         test (bool), changelogPath? }
function createWhatsNew(deps) {
  let checked = false;
  let showing = false;
  const changelogFile = deps.changelogPath || CHANGELOG;

  function releases() {
    try {
      return parseChangelog(fs.readFileSync(changelogFile, 'utf8'));
    } catch (err) {
      console.error('[lumen] could not read the release notes:', err.message);
      return [];
    }
  }
  const enabled = () => deps.readSettings().showWhatsNew !== false;
  function record(version) {
    deps.writeSettings({ ...deps.readSettings(), lastSeenVersion: version });
  }

  // Resolves true once the notes were shown and closed.
  async function present(list, { from = null } = {}) {
    if (!list.length || showing) return false;
    showing = true;
    try {
      const current = deps.app.getVersion();
      const shown = list.slice(0, MAX_RELEASES);
      const { checkboxChecked } = await deps.showNotes({
        title: from ? deps.t('whatsNew.updatedFrom', { from, to: current }) : '',
        message: deps.t('whatsNew.title', { version: current }),
        notes: shown.map((r) => ({ version: r.version, date: r.date, blocks: r.blocks })),
        more: list.length > shown.length ? deps.t('whatsNew.more', { n: list.length - shown.length }) : '',
        link: { label: deps.t('whatsNew.allNotes'), url: CHANGELOG_URL },
        buttons: [deps.t('whatsNew.gotIt')],
        checkboxLabel: deps.t('whatsNew.toggle'),
        checkboxChecked: enabled(),
      });
      if (Boolean(checkboxChecked) !== enabled()) deps.writeSettings({ ...deps.readSettings(), showWhatsNew: Boolean(checkboxChecked) });
      return true;
    } finally {
      showing = false;
    }
  }

  // Once per run, when the first browser window is ready.
  async function check() {
    if (checked) return false;
    checked = true;
    if (deps.test && !process.env.LUMEN_WHATS_NEW_TEST) return false; // tests opt in; a normal test run writes nothing
    const current = deps.app.getVersion();
    const stored = deps.readSettings().lastSeenVersion;
    const { show, record: version } = decide({ stored, current, enabled: enabled() });
    if (version) record(version); // before showing: a crash or quit with the card open never shows it twice
    if (!show) return false;
    return present(releasesBetween(releases(), stored, current), { from: cleanVersion(stored) });
  }

  // Help → What's New… and Settings → Updates: the running version's notes and the few before it.
  function open() {
    const current = deps.app.getVersion();
    const list = releases().filter((r) => compareVersions(r.version, current) <= 0).sort((a, b) => compareVersions(b.version, a.version)).slice(0, ON_DEMAND);
    return present(list);
  }

  return { check, open, releases, isShowing: () => showing };
}

module.exports = { createWhatsNew, parseChangelog, releasesBetween, compareVersions, decide, cleanVersion, CHANGELOG, CHANGELOG_URL, MAX_RELEASES };
