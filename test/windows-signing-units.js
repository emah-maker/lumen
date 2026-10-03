// Pure unit test for the Windows signing groundwork in scripts/signing.js (Azure Artifact Signing
// through electron-builder's win.azureSignOptions): nothing is signed unless every AZURE_* value is
// set, the flags carry the right option names, and the unsigned build stays exactly as it was.
// No Azure account, certificate or network needed.
const fs = require('fs');
const path = require('path');
const S = require('../scripts/signing');
const P = require('../scripts/after-pack');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const root = path.join(__dirname, '..');

const full = {
  AZURE_TENANT_ID: 'tenant-1', AZURE_CLIENT_ID: 'client-1', AZURE_CLIENT_SECRET: 'secret-1',
  AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
  AZURE_SIGNING_ACCOUNT: 'lumen-signing',
  AZURE_SIGNING_PROFILE: 'lumen-public',
  AZURE_SIGNING_PUBLISHER: 'Jane Doe',
};
const without = (k) => Object.fromEntries(Object.entries(full).filter(([key]) => key !== k));

check('no variables: signing off, nothing partial, no flags', !S.winSigning({}).enabled && S.winSigning({}).partial === null && S.winBuilderArgs({}).length === 0, JSON.stringify(S.winSigning({})));
check('blank values count as missing', !S.winSigning({ ...full, AZURE_CLIENT_SECRET: '   ' }).enabled, '');
check('all values: signing on', S.winSigning(full).enabled && S.winSigning(full).publisher === 'Jane Doe', JSON.stringify(S.winSigning(full)));
for (const k of Object.keys(full)) check(`missing ${k}: off and reported as partial, no flags`, !S.winSigning(without(k)).enabled && S.winSigning(without(k)).partial.join() === k && S.winBuilderArgs(without(k)).length === 0, JSON.stringify(S.winSigning(without(k))));
check('only the credentials (no account settings): off, partial', !S.winSigning({ AZURE_TENANT_ID: 'tenant-1', AZURE_CLIENT_ID: 'client-1', AZURE_CLIENT_SECRET: 'secret-1' }).enabled, '');
check('an endpoint that is not a codesigning.azure.net URL is rejected', S.winSigning({ ...full, AZURE_SIGNING_ENDPOINT: 'http://eus.codesigning.azure.net' }).invalid[0] === 'AZURE_SIGNING_ENDPOINT' && S.winBuilderArgs({ ...full, AZURE_SIGNING_ENDPOINT: 'https://evil.example.com' }).length === 0, '');
check('account and profile names must be plain names', S.winSigning({ ...full, AZURE_SIGNING_ACCOUNT: "a'; calc" }).invalid.includes('AZURE_SIGNING_ACCOUNT') && S.winSigning({ ...full, AZURE_SIGNING_PROFILE: 'a b' }).invalid.includes('AZURE_SIGNING_PROFILE'), '');
check('a publisher with control characters is rejected', S.winSigning({ ...full, AZURE_SIGNING_PUBLISHER: 'a\nb' }).invalid[0] === 'AZURE_SIGNING_PUBLISHER', '');

const args = S.winBuilderArgs(full);
check('flags: signing on turns signAndEditExecutable on and forces code signing', args.includes('-c.win.signAndEditExecutable=true') && args.includes('-c.forceCodeSigning=true'), args.join(' '));
check('flags: the azureSignOptions names electron-builder expects', args.includes('-c.win.azureSignOptions.endpoint=https://eus.codesigning.azure.net')
  && args.includes('-c.win.azureSignOptions.codeSigningAccountName=lumen-signing')
  && args.includes('-c.win.azureSignOptions.certificateProfileName=lumen-public')
  && args.includes('-c.win.azureSignOptions.publisherName=Jane Doe'), args.join(' '));
check('flags: no credential value is ever passed on the command line', !args.some((a) => /tenant-1|client-1|secret-1/.test(a)), args.join(' '));

const plain = { FOO: '1' };
check('env: unsigned build passes the environment through untouched', S.winBuilderEnv(plain) === plain, '');
const env = S.winBuilderEnv(full);
check('env: signed build defers Widevine VMP signing and keeps the credentials for the TrustedSigning module', env.LUMEN_DEFER_VMP === '1' && env.AZURE_CLIENT_SECRET === 'secret-1' && !('LUMEN_DEFER_VMP' in full), '');
check('after-pack: VMP is deferred only when LUMEN_DEFER_VMP=1', P.deferVmp({ LUMEN_DEFER_VMP: '1' }) && !P.deferVmp({}) && !P.deferVmp({ LUMEN_DEFER_VMP: '0' }), '');

// The committed configuration stays the unsigned one: nothing signs without the variables.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build;
check('package.json: win.signAndEditExecutable stays false and no azureSignOptions is committed (the stock Lumen.exe stays byte-identical)', pkg.win.signAndEditExecutable === false && !('azureSignOptions' in pkg.win) && !('forceCodeSigning' in pkg), JSON.stringify(pkg.win));

const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
check('release workflow: Azure values come from secrets/variables and the build step is gated on the detect step', /secrets\.AZURE_CLIENT_SECRET/.test(wf) && /steps\.winsign\.outputs\.enabled == 'true'/.test(wf) && /Verify Windows signature/.test(wf), '');

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
