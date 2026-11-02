// [uBlock mode] uBlock Origin itself (Manifest V2), Settings → Privacy and security → Ad blocker's third choice (features/ublock-mode.js).
// The Chrome Web Store no longer serves it, so it comes from its author's GitHub releases: the signed CRX each release carries.
// Its signature is checked (features/crx.js) and its id must be the one gorhill's key gives, so only his builds install.
// It is unpacked where the store's extensions live (userData/Extensions/<id>/<version>_0, manifest.key set), so Lumen's start-up loads it
// like any installed extension. The store's updater skips it (its update_url is not the store's): checkForUpdate() here looks at the
// latest release once a day instead.
// Electron 44 runs it only with preload/extensions-mv2-preload.js (its `browser` object and the requests' tab ids).
const fs = require('fs');
const path = require('path');
const readCrx = (buf) => require('./crx').readCrx(buf); // (loaded with the first download)

// (A test run serves its own release list and a fixture signed with a throwaway key: test-mode.js, test/e2e/ublock-origin.js.)
const TEST = Boolean(process.env.CLAUDE_BROWSER_TEST && process.env.LUMEN_TEST_UBO_RELEASES && /^[a-p]{32}$/.test(process.env.LUMEN_TEST_UBO_ID || ''));
const UBO_ID = TEST ? process.env.LUMEN_TEST_UBO_ID : 'fkgkibajhfbepljeaefdnfnegdcjomkh';
const RELEASES = TEST ? process.env.LUMEN_TEST_UBO_RELEASES : 'https://api.github.com/repos/gorhill/uBlock/releases/latest';
const ASSET = /^uBlock0_[\w.]+\.chromium\.crx$/;
const DAY = 24 * 60 * 60 * 1000;

// "1.75.2" > "1.75.0"; a release candidate's letters count as nothing (only the latest full release is ever offered).
const newer = (a, b) => {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

// { version, url } of the latest full release's Chromium package.
async function latestRelease(fetchImpl = fetch) {
  const res = await fetchImpl(RELEASES, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const release = await res.json();
  const asset = (release.assets || []).find((a) => ASSET.test(a.name || ''));
  if (!asset?.browser_download_url) throw new Error('The latest release has no Chromium package');
  return { version: String(release.tag_name || '').replace(/^v/, ''), url: asset.browser_download_url };
}

// Downloads, checks and unpacks a release; returns the folder to load. The version loaded now stays until prune() (after the switch).
async function install(url, extensionsDir, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`The download failed (${res.status})`);
  const crx = readCrx(Buffer.from(await res.arrayBuffer()));
  if (crx.id !== UBO_ID) throw new Error('The package is not signed by uBlock Origin’s author');
  const AdmZip = require('adm-zip');
  const root = path.join(extensionsDir, UBO_ID);
  const temp = path.join(root, `.download-${process.pid}-${Date.now()}`);
  try {
    new AdmZip(crx.zip).extractAllTo(temp, true);
    const manifestFile = path.join(temp, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (!manifest.version || manifest.manifest_version !== 2) throw new Error('The package is not uBlock Origin');
    manifest.key = crx.publicKey; // (the id stays the same when it loads from disk)
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const dir = path.join(root, `${manifest.version}_0`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(temp, dir);
    return dir;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// Every other version's folder, once `keep` is the one loaded.
function prune(extensionsDir, keep) {
  const root = path.join(extensionsDir, UBO_ID);
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) if (path.join(root, name) !== keep) fs.rmSync(path.join(root, name), { recursive: true, force: true });
}

// The newest release's folder when it is newer than `version` (and a day has passed since the last look); null otherwise.
// stamp: { read(), write(ms) } for when it last looked.
async function checkForUpdate(version, extensionsDir, { stamp, fetchImpl = fetch, now = Date.now() } = {}) {
  if (stamp && now - (stamp.read() || 0) < DAY) return null;
  stamp?.write(now);
  const latest = await latestRelease(fetchImpl);
  if (!newer(latest.version, version)) return null;
  return install(latest.url, extensionsDir, fetchImpl);
}

module.exports = { UBO_ID, RELEASES, latestRelease, install, prune, checkForUpdate, newer };
