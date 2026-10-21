// The GitHub release body (scripts/release/release-notes.js): the version's CHANGELOG section, the download table naming every file
// release.yml publishes, and the link to the install guide.
const fs = require('fs');
const path = require('path');
const { changelogSection, releaseNotes } = require('../../scripts/release/release-notes');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

const CL = ['# Changelog', '', '## Unreleased', '', '- **Next.** soon', '', '## 1.2.3 (2026-10-19)', '', '- **A.** one', '- **B.** two', '', '## 1.2.2 (2026-10-18)', '', '- **Old.** before', ''].join('\n');

check('section: the lines under "## X.Y.Z (date)" up to the next heading', changelogSection(CL, '1.2.3') === '- **A.** one\n- **B.** two', changelogSection(CL, '1.2.3'));
check('section: the last section runs to the end of the file', changelogSection(CL, '1.2.2') === '- **Old.** before');
check('section: a missing version is empty, and 1.2.3 does not match 1.2.30', changelogSection(CL, '9.9.9') === '' && changelogSection(CL.replace('## 1.2.3 ', '## 1.2.30 '), '1.2.3') === '');
check('section: CRLF line endings', changelogSection(CL.replace(/\n/g, '\r\n'), '1.2.3') === '- **A.** one\n- **B.** two');

const notes = releaseNotes('1.2.3', CL);
const files = ['Lumen-Setup-1.2.3.exe', 'Lumen-1.2.3-win-x64.zip', 'Lumen-1.2.3-mac-arm64.dmg', 'Lumen-1.2.3-mac-x64.dmg', 'Lumen-1.2.3-mac-arm64.zip', 'Lumen-1.2.3-mac-x64.zip', 'latest.yml', 'latest-mac.yml', '.blockmap'];
check('notes: every file release.yml publishes is described', files.every((f) => notes.includes(f)), files.filter((f) => !notes.includes(f)).join(', '));
check("notes: what's new is the version's CHANGELOG section", notes.includes("## What's new in 1.2.3") && notes.includes('- **B.** two') && !notes.includes('**Old.**') && !notes.includes('**Next.**'));
check('notes: the install guide link points at the tagged docs/install.md', notes.includes('/blob/v1.2.3/docs/install.md'));
check('notes: with no section, a link to the CHANGELOG stands in', releaseNotes('9.9.9', CL).includes('/blob/v9.9.9/CHANGELOG.md'));
check('the install guide exists and names the same downloads', (() => { const g = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'install.md'), 'utf8'); return ['Lumen-Setup-<version>.exe', 'win-x64.zip', 'mac-arm64.dmg', 'mac-x64.dmg', 'latest.yml', 'blockmap'].every((f) => g.includes(f)); })());
const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
check('release.yml builds the notes and passes them as the body', /node scripts\/release-notes\.js/.test(workflow) && /body_path:/.test(workflow));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
