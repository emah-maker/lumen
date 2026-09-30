// Builds the GitHub Pages site into _site/ (deployed by .github/workflows/pages.yml; `node
// scripts/build-site.js` then open _site/index.html through any local server to preview it).
// The site is site/* as is, plus the Markdown it renders (README.md, CHANGELOG.md, docs/*.md under
// md/), the README's media (docs/media) and the app icon. Nothing is generated or bundled.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

fs.rmSync(OUT, { recursive: true, force: true });
copy(path.join(ROOT, 'site'), OUT);
for (const file of ['README.md', 'CHANGELOG.md']) copy(path.join(ROOT, file), path.join(OUT, 'md', file));
for (const file of fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md'))) copy(path.join(ROOT, 'docs', file), path.join(OUT, 'md', 'docs', file));
copy(path.join(ROOT, 'docs', 'media'), path.join(OUT, 'docs', 'media'));
copy(path.join(ROOT, 'assets', 'icon.png'), path.join(OUT, 'assets', 'icon.png'));
fs.writeFileSync(path.join(OUT, '.nojekyll'), ''); // serve files as they are (no Jekyll processing)

const count = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log(`Built ${path.relative(ROOT, OUT)}/ (${count(OUT)} files)`);
