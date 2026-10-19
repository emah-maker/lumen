// "What's new" after an update (features/whats-new.js), plain Node (run from test/units.js, or on its
// own: `node test/whats-new-units.js`): CHANGELOG.md parsing, version order, which releases a jump
// covers, when the notes show (never on a first run, a downgrade or in test mode unless asked), that
// the version is recorded and the switch saved, the settings' validation, and that CHANGELOG.md ships
// inside the app with an entry for package.json's version.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async function whatsNewUnits(check) {
  const W = require('../src/features/whats-new');
  const SB = require('../src/settings/settings-backend');
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  // ---- versions
  check('whats-new: 0.2.13 is newer than 0.2.9 (numbers, not text)', W.compareVersions('0.2.13', '0.2.9') === 1 && W.compareVersions('0.2.9', '0.2.13') === -1, '');
  check('whats-new: equal versions compare equal', W.compareVersions('0.3.2', '0.3.2') === 0, '');
  check('whats-new: a prerelease comes before its release', W.compareVersions('0.4.0-beta.1', '0.4.0') === -1 && W.compareVersions('0.4.0', '0.4.0-beta.1') === 1 && W.compareVersions('0.4.0-beta.1', '0.3.9') === 1, '');
  check('whats-new: cleanVersion keeps x.y.z and refuses anything else', W.cleanVersion('0.3.2') === '0.3.2' && W.cleanVersion(' 1.0.0 ') === '1.0.0'
    && [null, undefined, 3, '', 'v0.3.2', '0.3', '0.3.2; rm -rf', '<b>1.0.0</b>', `1.0.0-${'x'.repeat(60)}`].every((v) => W.cleanVersion(v) === null), '');

  // ---- parsing
  const sample = [
    '# Changelog', '', 'Intro text that is not a release.', '', '## Unreleased', '', '- Not out yet.', '',
    '## 0.3.2 (2026-09-29)', '', '- First `thing`,', '  wrapped onto a second line.', '- Second **thing**.', '',
    '## 0.3.1 (2026-09-28)', '', 'A note paragraph.', '', '- Only item.', '',
    '## 0.3.0', '', '- No date here.', '',
    '## 0.2.9 (2026-09-01)', '',
  ].join('\n');
  const parsed = W.parseChangelog(sample);
  check('whats-new: parse finds the releases, newest first, and skips Unreleased and the intro', parsed.map((r) => r.version).join() === '0.3.2,0.3.1,0.3.0', parsed.map((r) => r.version).join());
  check('whats-new: parse reads the date', parsed[0].date === '2026-09-29' && parsed[2].date === '', JSON.stringify(parsed.map((r) => r.date)));
  check('whats-new: a wrapped bullet joins its first line', parsed[0].blocks[0].type === 'li' && parsed[0].blocks[0].text === 'First `thing`, wrapped onto a second line.', JSON.stringify(parsed[0].blocks[0]));
  check('whats-new: paragraphs and bullets keep their kind and order', parsed[1].blocks.map((b) => b.type).join() === 'p,li' && parsed[1].blocks[0].text === 'A note paragraph.', JSON.stringify(parsed[1].blocks));
  check('whats-new: a release with no notes is dropped', !parsed.some((r) => r.version === '0.2.9'), '');
  check('whats-new: CRLF files parse the same', JSON.stringify(W.parseChangelog(sample.replace(/\n/g, '\r\n'))) === JSON.stringify(parsed), '');
  check('whats-new: empty or missing text parses to nothing', W.parseChangelog('').length === 0 && W.parseChangelog(null).length === 0, '');

  const between = W.releasesBetween(parsed, '0.3.0', '0.3.2');
  check('whats-new: an update from 0.3.0 to 0.3.2 lists 0.3.2 and 0.3.1, not 0.3.0', between.map((r) => r.version).join() === '0.3.2,0.3.1', between.map((r) => r.version).join());
  check('whats-new: nothing newer than the running version is listed', W.releasesBetween(parsed, '0.3.0', '0.3.1').map((r) => r.version).join() === '0.3.1', '');

  // ---- when it shows
  const d = (stored, current, enabled = true) => W.decide({ stored, current, enabled });
  check('whats-new: a first run ever shows nothing and records the version', JSON.stringify(d(undefined, '0.3.2')) === JSON.stringify({ show: false, record: '0.3.2' }), JSON.stringify(d(undefined, '0.3.2')));
  check('whats-new: a broken stored value counts as a first run', JSON.stringify(d('banana', '0.3.2')) === JSON.stringify({ show: false, record: '0.3.2' }) && d({ v: 1 }, '0.3.2').show === false, '');
  check('whats-new: a newer version shows once and records it', JSON.stringify(d('0.3.0', '0.3.2')) === JSON.stringify({ show: true, record: '0.3.2' }), JSON.stringify(d('0.3.0', '0.3.2')));
  check('whats-new: the same version shows nothing and writes nothing', JSON.stringify(d('0.3.2', '0.3.2')) === JSON.stringify({ show: false, record: null }), '');
  check('whats-new: a downgrade shows nothing and keeps the newer version', JSON.stringify(d('0.4.0', '0.3.2')) === JSON.stringify({ show: false, record: null }), '');
  check('whats-new: with the switch off an update is recorded but not shown', JSON.stringify(d('0.3.0', '0.3.2', false)) === JSON.stringify({ show: false, record: '0.3.2' }), '');

  // ---- the controller, with a fake app, settings and dialog
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-whats-new-'));
  const changelogPath = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(changelogPath, sample);
  function make({ version = '0.3.2', settings = {}, test = false, answer = null } = {}) {
    let stored = { ...settings };
    const shown = [];
    const w = W.createWhatsNew({
      app: { getVersion: () => version },
      readSettings: () => ({ ...stored }),
      writeSettings: (s) => { stored = { ...s }; },
      t: (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`,
      test,
      changelogPath,
      showNotes: async (opts) => { shown.push(opts); return { response: 0, checkboxChecked: answer === null ? opts.checkboxChecked : answer }; },
    });
    return { w, shown, settings: () => stored };
  }
  const saved = process.env.LUMEN_WHATS_NEW_TEST;
  delete process.env.LUMEN_WHATS_NEW_TEST;
  try {
    let m = make();
    check('whats-new: first run: no card', (await m.w.check()) === false && m.shown.length === 0, JSON.stringify(m.shown));
    check('whats-new: first run: the version is recorded', m.settings().lastSeenVersion === '0.3.2', JSON.stringify(m.settings()));

    m = make({ settings: { lastSeenVersion: '0.3.0', keep: 'me' } });
    check('whats-new: after an update the card shows', (await m.w.check()) === true && m.shown.length === 1, JSON.stringify(m.shown));
    const card = m.shown[0];
    check('whats-new: the card lists the releases in between', card.notes.map((r) => r.version).join() === '0.3.2,0.3.1', JSON.stringify(card.notes.map((r) => r.version)));
    check('whats-new: the card says where it updated from', card.title === 'whatsNew.updatedFrom{"from":"0.3.0","to":"0.3.2"}' && card.message === 'whatsNew.title{"version":"0.3.2"}', `${card.title} | ${card.message}`);
    check('whats-new: the card has Got it, the switch (on) and a link to all notes', card.buttons.join() === 'whatsNew.gotIt' && card.checkboxLabel === 'whatsNew.toggle' && card.checkboxChecked === true && card.link.url.startsWith('https://github.com/emah-maker/lumen/'), JSON.stringify(card));
    check('whats-new: the new version is recorded, other settings kept', m.settings().lastSeenVersion === '0.3.2' && m.settings().keep === 'me', JSON.stringify(m.settings()));
    check('whats-new: leaving the switch on writes nothing for it', !('showWhatsNew' in m.settings()), JSON.stringify(m.settings()));
    check('whats-new: it checks once per launch', (await m.w.check()) === false && m.shown.length === 1, '');

    m = make({ settings: { lastSeenVersion: '0.3.0' }, answer: false });
    await m.w.check();
    check('whats-new: turning the switch off on the card saves showWhatsNew: false', m.settings().showWhatsNew === false, JSON.stringify(m.settings()));
    m = make({ settings: { lastSeenVersion: '0.3.1', showWhatsNew: false } });
    check('whats-new: with the switch off an update shows nothing', (await m.w.check()) === false && m.shown.length === 0 && m.settings().lastSeenVersion === '0.3.2', JSON.stringify(m.settings()));

    m = make({ settings: { lastSeenVersion: '0.3.2' } });
    check('whats-new: an unchanged version shows nothing', (await m.w.check()) === false && m.shown.length === 0, '');
    m = make({ settings: { lastSeenVersion: '0.2.0' }, version: '0.2.5' });
    check('whats-new: an update with no notes in the file shows nothing but is recorded', (await m.w.check()) === false && m.shown.length === 0 && m.settings().lastSeenVersion === '0.2.5', JSON.stringify(m.settings()));

    m = make({ settings: { lastSeenVersion: '0.3.0' }, test: true });
    check('whats-new: test mode never shows it (or writes anything) on its own', (await m.w.check()) === false && m.shown.length === 0 && m.settings().lastSeenVersion === '0.3.0', JSON.stringify(m.settings()));
    process.env.LUMEN_WHATS_NEW_TEST = '1';
    m = make({ settings: { lastSeenVersion: '0.3.0' }, test: true });
    check('whats-new: a test can ask for it (LUMEN_WHATS_NEW_TEST)', (await m.w.check()) === true && m.shown.length === 1, '');
    delete process.env.LUMEN_WHATS_NEW_TEST;

    m = make({ settings: { lastSeenVersion: '0.3.2', showWhatsNew: false } });
    check('whats-new: opened on demand it shows the running version first, even with the switch off', (await m.w.open()) === true && m.shown[0].notes[0].version === '0.3.2' && m.shown[0].title === '', JSON.stringify(m.shown[0]?.notes?.map((r) => r.version)));
    check('whats-new: on demand it lists a few releases, none newer than the running one', m.shown[0].notes.length <= 3 && m.shown[0].notes.every((r) => W.compareVersions(r.version, '0.3.2') <= 0), '');
    check('whats-new: on demand the switch starts as saved (off)', m.shown[0].checkboxChecked === false, '');
    m = make({ version: '0.3.1' });
    await m.w.open();
    check('whats-new: on demand a 0.3.1 build does not show 0.3.2 notes', m.shown[0].notes[0].version === '0.3.1', JSON.stringify(m.shown[0].notes.map((r) => r.version)));

    const many = ['# Changelog', ...Array.from({ length: 20 }, (_, i) => `## 1.0.${20 - i}\n\n- change ${20 - i}\n`)].join('\n');
    fs.writeFileSync(changelogPath, many);
    m = make({ settings: { lastSeenVersion: '0.9.0' }, version: '1.0.20' });
    await m.w.check();
    check(`whats-new: a long jump lists the newest ${W.MAX_RELEASES} and says how many more`, m.shown[0].notes.length === W.MAX_RELEASES && m.shown[0].notes[0].version === '1.0.20' && m.shown[0].more === `whatsNew.more{"n":${20 - W.MAX_RELEASES}}`, `${m.shown[0].notes.length} ${m.shown[0].more}`);

    fs.rmSync(changelogPath);
    const quiet = console.error;
    console.error = () => {};
    try {
      m = make({ settings: { lastSeenVersion: '0.3.0' } });
      check('whats-new: a missing CHANGELOG.md shows nothing and does not throw', (await m.w.check()) === false && m.shown.length === 0 && m.settings().lastSeenVersion === '0.3.2', '');
    } finally { console.error = quiet; }
  } finally {
    if (saved === undefined) delete process.env.LUMEN_WHATS_NEW_TEST; else process.env.LUMEN_WHATS_NEW_TEST = saved;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }

  // ---- settings
  check('whats-new: showWhatsNew defaults to on, lastSeenVersion to empty', SB.DEFAULTS.showWhatsNew === true && SB.DEFAULTS.lastSeenVersion === '', '');
  check('whats-new: showWhatsNew takes booleans only', SB.validate('showWhatsNew', false) === false && SB.validate('showWhatsNew', 'no') === null && SB.validate('showWhatsNew', 0) === null, '');
  check('whats-new: lastSeenVersion takes a version or empty, nothing else', SB.validate('lastSeenVersion', '0.3.2') === '0.3.2' && SB.validate('lastSeenVersion', '') === ''
    && SB.validate('lastSeenVersion', '<script>') === null && SB.validate('lastSeenVersion', 3) === null, '');

  // ---- the real changelog, and that it ships
  const real = W.parseChangelog(fs.readFileSync(W.CHANGELOG, 'utf8'));
  check(`whats-new: CHANGELOG.md has notes for package.json's version (${pkg.version})`, real.some((r) => r.version === pkg.version && r.blocks.length), real.slice(0, 3).map((r) => r.version).join());
  check('whats-new: CHANGELOG.md lists releases newest first', real.every((r, i) => i === 0 || W.compareVersions(real[i - 1].version, r.version) > 0), real.map((r) => r.version).join());
  const files = pkg.build.files;
  check('whats-new: the build re-includes CHANGELOG.md after excluding *.md (electron-builder applies patterns in order)', files.indexOf('CHANGELOG.md') > files.indexOf('!*.md') && files.indexOf('!*.md') !== -1, JSON.stringify(files));
  // The same matcher electron-builder uses (app-builder-lib/out/util/filter.js), applied to the file names.
  let shipped = null;
  try {
    const { Minimatch } = require('minimatch');
    const patterns = files.map((p) => new Minimatch(p, { dot: true }));
    shipped = (rel) => {
      let match = false;
      for (const pattern of patterns) { if (match !== pattern.negate) continue; match = pattern.match(rel, false); }
      return match;
    };
  } catch { /* minimatch is electron-builder's; skip the check without it */ }
  if (shipped) {
    check('whats-new: CHANGELOG.md and the feature ship, other Markdown and docs/ do not', shipped('CHANGELOG.md') && shipped('src/features/whats-new.js') && !shipped('README.md') && !shipped('docs/settings.md'),
      JSON.stringify({ changelog: shipped('CHANGELOG.md'), feature: shipped('src/features/whats-new.js'), readme: shipped('README.md'), docs: shipped('docs/settings.md') }));
  }
};

if (require.main === module) {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
  module.exports(check).catch((err) => check('whats-new units', false, err.stack)).then(() => {
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
  });
}
