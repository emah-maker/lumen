// The text of a GitHub release: what changed (the version's CHANGELOG section), which file to download, and a link to the
// install guide (docs/install.md). release.yml runs it before publishing and passes the file as the release body.
//
//   node scripts/release/release-notes.js <version|vX.Y.Z> [--out <file>]     (prints to stdout without --out)
const fs = require('fs');
const path = require('path');

const REPO = 'https://github.com/emah-maker/lumen';

// The section of CHANGELOG.md for `version`: the lines under "## X.Y.Z (date)" up to the next "## " heading, trimmed.
function changelogSection(changelog, version) {
  const lines = String(changelog).split(/\r?\n/);
  const head = new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

// The release body. `version` without the v.
function releaseNotes(version, changelog) {
  const v = version;
  const changes = changelogSection(changelog, v);
  return [
    '## Which file do I download?',
    '',
    '| Your computer | Download |',
    '|---|---|',
    `| Windows 10 or 11 | \`Lumen-Setup-${v}.exe\`: the installer. Double-click it; no admin prompt, no wizard. |`,
    `| Windows, no installer (or Smart App Control on) | \`Lumen-${v}-win-x64.zip\`: unzip anywhere and run \`Lumen.exe\`. |`,
    `| Mac with Apple silicon (M1 and later) | \`Lumen-${v}-mac-arm64.dmg\`: open it and drag Lumen onto Applications. |`,
    `| Mac with Intel | \`Lumen-${v}-mac-x64.dmg\`: open it and drag Lumen onto Applications. |`,
    '',
    'Already have Lumen? It updates itself: look for **Restart to update** in the toolbar, or open **Settings → About Lumen → Updates**.',
    '',
    '<details><summary>The other files (for Lumen\'s updater; you don\'t need them)</summary>',
    '',
    `- \`Lumen-${v}-mac-arm64.zip\`, \`Lumen-${v}-mac-x64.zip\`: the Mac app zipped. The updater downloads these; you can also unzip one and drag \`Lumen.app\` to Applications.`,
    '- `latest.yml`, `latest-mac.yml`: the update manifests (newest version and the SHA-512 hash of each download).',
    '- `*.blockmap`: lets an update fetch only the parts that changed.',
    '',
    '</details>',
    '',
    `Step-by-step install, first launch, updates and troubleshooting: **[Install guide](${REPO}/blob/v${v}/docs/install.md)**.`,
    '',
    `## What's new in ${v}`,
    '',
    changes || `See [CHANGELOG.md](${REPO}/blob/v${v}/CHANGELOG.md).`,
    '',
  ].join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const version = String(args.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1)) || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error('usage: node scripts/release/release-notes.js <X.Y.Z|vX.Y.Z> [--out <file>]'); process.exit(2); }
  const changelog = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
  if (!changelogSection(changelog, version)) console.error(`release-notes: no "## ${version}" section in CHANGELOG.md; the notes link to it instead`);
  const text = releaseNotes(version, changelog);
  const out = outAt >= 0 ? args[outAt + 1] : null;
  if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
}

module.exports = { changelogSection, releaseNotes };
