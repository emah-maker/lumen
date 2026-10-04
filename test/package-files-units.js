// What electron-builder puts in the app, per platform, without packaging anything: the real build config from
// package.json, loaded and merged the way the CLI does (app-builder-lib's getConfig), then its own file matchers run
// over a fixture checkout. 0.5.7's Mac build failed because build.mac.files existed: electron-builder turns the
// top-level build.files into a file set of its own, so a platform `files` list became a second matcher without
// the top-level filters or the default excludes, and the Mac app got the whole checkout (.git, test/, docs/...)
// and codesign stopped on .git's read-only pack files. Windows-only koffi is dropped from the Mac app by
// scripts/after-pack.js instead. No network, no Electron, no packaging.
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const root = path.join(__dirname, '..');
const { getConfig } = require('app-builder-lib/out/util/config/config.js');
const { getMainFileMatchers, getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher.js');
const { computeFileSets } = require('app-builder-lib/out/util/appFileCopier.js');
const afterPack = require('../scripts/after-pack');

// A checkout with everything that must stay out of the app next to what must go in.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pkgfiles-'));
  const put = (rel, text = 'x') => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  for (const rel of ['src/main.js', 'src/preload/webauthn-preload.js', 'mcp.js', 'CHANGELOG.md', 'LICENSE',
    '.git/HEAD', '.git/objects/pack/pack-1.idx', '.claude/worktrees/w/src/main.js', '.claude/settings.json',
    'test/units.js', 'docs/index.md', 'scripts/build.js', 'site/index.html', '.github/workflows/release.yml',
    'README.md', 'package-lock.json', 'eslint.config.js', 'build/icon.png', 'dist/Lumen-Setup.exe',
    'node_modules/openai/index.js', 'node_modules/koffi/index.js']) put(rel);
  return dir;
}

async function appFiles(dir, config, platform) {
  const info = { isPrepackedAppAsar: false, areNodeModulesHandledExternally: false, projectDir: dir, appDir: dir, buildResourcesDir: 'build', config, debugLogger: { isEnabled: false } };
  const options = config[platform] || {};
  const matchers = getMainFileMatchers(dir, path.join(dir, 'out', 'app'), (x) => x, options, { info }, path.join(dir, 'dist'), false);
  const sets = await computeFileSets(matchers, null, { info }, false);
  const files = sets.flatMap((s) => s.files.filter((f) => !s.metadata.get(f) || !s.metadata.get(f).isDirectory()).map((f) => path.relative(dir, f).split(path.sep).join('/')));
  const modules = getNodeModuleFileMatcher(dir, path.join(dir, 'out', 'app'), (x) => x, options, info).createFilter();
  const moduleShips = (rel) => modules(path.join(dir, rel), { isDirectory: () => false, moduleFullFilePath: rel });
  return { matchers, files, moduleShips };
}

(async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build;
  for (const key of ['mac', 'mas', 'win', 'linux', 'dmg', 'nsis', 'portable']) {
    check(`package.json: build.${key} has no "files" (it would replace the shared filters with a second, unfiltered matcher)`, !(pkg[key] && 'files' in pkg[key]), JSON.stringify(pkg[key] && pkg[key].files));
  }

  const dir = fixture();
  try {
    const config = await getConfig(dir, null, null);
    for (const platform of ['mac', 'win']) {
      const { matchers, files, moduleShips } = await appFiles(dir, config, platform);
      check(`${platform}: one file matcher for the app (all filters in one list)`, matchers.length === 1, matchers.map(String).join('\n'));
      for (const must of ['package.json', 'src/main.js', 'src/preload/webauthn-preload.js', 'mcp.js', 'CHANGELOG.md', 'LICENSE']) {
        check(`${platform}: ships ${must}`, files.includes(must), files.join(', '));
      }
      for (const prefix of ['.git/', '.claude/', 'test/', 'docs/', 'scripts/', 'site/', '.github/', 'build/', 'dist/', 'node_modules/']) {
        const leaked = files.filter((f) => f.startsWith(prefix));
        check(`${platform}: nothing from ${prefix} in the app`, leaked.length === 0, leaked.join(', '));
      }
      for (const no of ['README.md', 'package-lock.json', 'eslint.config.js']) check(`${platform}: no ${no}`, !files.includes(no), files.join(', '));
      check(`${platform}: node modules still ship (openai)`, moduleShips('node_modules/openai/index.js'), '');
      check(`${platform}: koffi's sources and import libraries never ship`, !moduleShips('node_modules/koffi/doc/a.md') && !moduleShips('node_modules/koffi/src/koffi/src/call.cc') && !moduleShips('node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.lib'), '');
      if (platform === 'win') {
        check('win: koffi and its Windows x64 binary ship', moduleShips('node_modules/koffi/index.js') && moduleShips('node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node'), '');
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }

  // after-pack drops koffi from the Mac app (before codesign) and leaves Windows alone.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-prune-'));
  try {
    const macModules = path.join(out, 'mac', 'Lumen.app', 'Contents', 'Resources', 'app', 'node_modules');
    const winModules = path.join(out, 'win-unpacked', 'resources', 'app', 'node_modules');
    for (const modules of [macModules, winModules]) {
      for (const rel of ['koffi/index.js', '@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node', '@koromix/koffi-win32-x64/win32_x64/koffi.node', 'openai/index.js']) {
        fs.mkdirSync(path.dirname(path.join(modules, rel)), { recursive: true });
        fs.writeFileSync(path.join(modules, rel), 'x');
      }
    }
    const removed = afterPack.pruneWindowsOnlyModules(path.join(out, 'mac'), 'darwin');
    check('after-pack: the Mac app loses koffi and @koromix', !fs.existsSync(path.join(macModules, 'koffi')) && !fs.existsSync(path.join(macModules, '@koromix')) && removed.length === 2, JSON.stringify(removed));
    check('after-pack: the Mac app keeps its other modules', fs.existsSync(path.join(macModules, 'openai', 'index.js')), '');
    const winRemoved = afterPack.pruneWindowsOnlyModules(path.join(out, 'win-unpacked'), 'win32');
    check('after-pack: the Windows app keeps koffi and its binary', winRemoved.length === 0 && fs.existsSync(path.join(winModules, 'koffi', 'index.js')) && fs.existsSync(path.join(winModules, '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node')), JSON.stringify(winRemoved));
    check('after-pack: the hook itself runs the prune', /pruneWindowsOnlyModules\(appOutDir, electronPlatformName\)/.test(afterPack.default.toString()), '');
  } finally {
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
})().catch((err) => check('package files', false, err.stack)).then(() => {
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
});
