// Which macOS signing path a build takes, from the environment alone (pure: values are only tested
// for presence, and nothing here ever prints one).
//
//   developer-id  CSC_LINK + CSC_KEY_PASSWORD (a base64 .p12 of a "Developer ID Application"
//                 certificate): hardened runtime, Apple signing by electron-builder. If notarization
//                 credentials are present too, electron-builder submits the app to Apple and staples
//                 the ticket. Gatekeeper opens it with no prompt.
//   self-signed   the repository's own certificate (LUMEN_SIGN_P12), applied by scripts/after-sign.js.
//   ad-hoc        neither: the build as it has always been.
//
// scripts/build.js turns the mode into electron-builder flags; the release workflow runs
// `node scripts/signing.js --github-output` to decide which steps to run.
const has = (env, k) => String((env || {})[k] || '').trim() !== '';
const all = (env, keys) => keys.every((k) => has(env, k));
const any = (env, keys) => keys.some((k) => has(env, k));

const API_KEY = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const APPLE_ID = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

// How notarization would authenticate: the App Store Connect API key (preferred, and what
// electron-builder tries second), the Apple ID route, or null. `partial` names a half-set group, so
// a mistyped secret is reported instead of silently skipping notarization.
function notarization(env) {
  if (all(env, APPLE_ID)) return { method: 'apple-id', partial: null, conflict: all(env, API_KEY) };
  if (all(env, API_KEY)) return { method: 'api-key', partial: null, conflict: false };
  const partial = any(env, API_KEY) ? 'APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER' : any(env, APPLE_ID) ? 'APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID' : null;
  return { method: null, partial, conflict: false };
}

// NOTE on precedence: electron-builder checks APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD first and only
// then the API key, so when both groups are complete it would use the Apple ID. To prefer the API
// key as intended, removeAppleIdWhenApiKey() tells the caller which variables to drop.
function macSigning(env = process.env) {
  const developerId = all(env, ['CSC_LINK', 'CSC_KEY_PASSWORD']);
  const selfSigned = !developerId && all(env, ['LUMEN_SIGN_P12', 'LUMEN_SIGN_PASSWORD']);
  const apiKeyFirst = all(env, API_KEY);
  const n = notarization(apiKeyFirst ? Object.fromEntries(Object.entries(env).filter(([k]) => !APPLE_ID.includes(k))) : env);
  return {
    mode: developerId ? 'developer-id' : selfSigned ? 'self-signed' : 'ad-hoc',
    notarize: developerId ? n.method : null, // notarizing needs a Developer ID signature
    partialNotarization: developerId ? n.partial : null,
    dropAppleId: developerId && apiKeyFirst, // both groups set: the API key wins
    evs: all(env, ['EVS_ACCOUNT_NAME', 'EVS_PASSWD']),
  };
}

// ---------------------------------------------------------------------------------------------
// Windows: Authenticode signing with Azure Artifact Signing (formerly Trusted Signing), done by
// electron-builder itself through win.azureSignOptions (docs/windows-signing.md). It is on only when
// every value below is set; with none of them the build is the unsigned build it has always been (the
// untouched Electron Lumen.exe, which scripts/build.js checks by hash). Values are only tested for
// presence and shape here, and nothing in this file ever prints one.
//
//   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   the service principal (repository secrets);
//                                    electron-builder's TrustedSigning PowerShell module reads them from
//                                    the environment itself (Azure's EnvironmentCredential)
//   AZURE_SIGNING_ENDPOINT           regional endpoint, https://<region>.codesigning.azure.net
//   AZURE_SIGNING_ACCOUNT            the Artifact Signing account name
//   AZURE_SIGNING_PROFILE            the certificate profile name
//   AZURE_SIGNING_PUBLISHER          the certificate subject (CN) exactly as validated, e.g. "Jane Doe"
const WIN_CREDENTIALS = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];
const WIN_SETTINGS = ['AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE', 'AZURE_SIGNING_PUBLISHER'];
const WIN_ALL = [...WIN_CREDENTIALS, ...WIN_SETTINGS];
const ENDPOINT = /^https:\/\/[a-z0-9-]+\.codesigning\.azure\.net\/?$/i;
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{1,98}[A-Za-z0-9]$/;
const val = (env, k) => String((env || {})[k] || '').trim();

function winSigning(env = process.env) {
  const missing = WIN_ALL.filter((k) => !has(env, k));
  const invalid = [];
  if (has(env, 'AZURE_SIGNING_ENDPOINT') && !ENDPOINT.test(val(env, 'AZURE_SIGNING_ENDPOINT'))) invalid.push('AZURE_SIGNING_ENDPOINT');
  for (const k of ['AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE']) if (has(env, k) && !RESOURCE_NAME.test(val(env, k))) invalid.push(k);
  const publisher = val(env, 'AZURE_SIGNING_PUBLISHER');
  if (publisher && (publisher.length > 200 || [...publisher].some((c) => c.charCodeAt(0) < 32))) invalid.push('AZURE_SIGNING_PUBLISHER');
  return {
    enabled: missing.length === 0 && invalid.length === 0,
    // Some, not all, of the values are set: reported instead of silently building unsigned.
    partial: missing.length > 0 && missing.length < WIN_ALL.length ? missing : null,
    invalid: invalid.length ? invalid : null,
    publisher,
  };
}

// electron-builder flags for a signed Windows build, none for the unsigned one. signAndEditExecutable
// is turned on here (package.json keeps it off so the unsigned Lumen.exe stays byte-identical to
// Electron's): electron-builder then edits Lumen.exe's icon and version info and signs it, the Setup
// exe and the uninstaller. forceCodeSigning makes a file that could not be signed fail the build.
function winBuilderArgs(env = process.env) {
  const w = winSigning(env);
  if (!w.enabled) return [];
  return [
    '-c.win.signAndEditExecutable=true',
    '-c.forceCodeSigning=true',
    `-c.win.azureSignOptions.endpoint=${val(env, 'AZURE_SIGNING_ENDPOINT')}`,
    `-c.win.azureSignOptions.codeSigningAccountName=${val(env, 'AZURE_SIGNING_ACCOUNT')}`,
    `-c.win.azureSignOptions.certificateProfileName=${val(env, 'AZURE_SIGNING_PROFILE')}`,
    `-c.win.azureSignOptions.publisherName=${w.publisher}`,
  ];
}

// Castlabs wants Widevine VMP signing after Authenticode on Windows, and electron-builder signs after
// the afterPack hook, so a signed build defers VMP to the afterSign hook (LUMEN_DEFER_VMP=1).
function winBuilderEnv(env = process.env) {
  return winSigning(env).enabled ? { ...env, LUMEN_DEFER_VMP: '1' } : env;
}

// electron-builder flags for the mode. package.json holds the shared mac settings; this picks the
// rest. Without a Developer ID it is exactly the old build: ad-hoc identity "-", hardened runtime
// off (package.json), notarization skipped even if stray APPLE_* variables exist. With one, the
// ad-hoc identity is left out so electron-builder uses the CSC_LINK certificate, hardened runtime is
// on (Apple's notarization requires it), and notarization runs when credentials exist.
function builderArgs(env = process.env) {
  const s = macSigning(env);
  if (s.mode !== 'developer-id') return ['-c.mac.identity=-', '-c.mac.notarize=false'];
  return ['-c.mac.hardenedRuntime=true', `-c.mac.notarize=${s.notarize ? 'true' : 'false'}`];
}

// The environment for electron-builder: a Developer ID build looks the certificate up (the release
// workflow sets CSC_IDENTITY_AUTO_DISCOVERY=false for the self-signed path) and lets the API key win.
function builderEnv(env = process.env) {
  const s = macSigning(env);
  if (s.mode !== 'developer-id') return env;
  const out = { ...env, CSC_IDENTITY_AUTO_DISCOVERY: 'true' };
  if (s.dropAppleId) for (const k of APPLE_ID) delete out[k];
  // The workflow imports the certificate into its own keychain (electron-builder's own import fails on
  // current macOS runners at set-key-partition-list) and names it in LUMEN_KEYCHAIN: electron-builder
  // then finds the Developer ID identity there instead of importing CSC_LINK again.
  if (has(env, 'LUMEN_KEYCHAIN')) {
    out.CSC_KEYCHAIN = String(env.LUMEN_KEYCHAIN).trim();
    delete out.CSC_LINK;
    delete out.CSC_KEY_PASSWORD;
  }
  return out;
}

exports.macSigning = macSigning;
exports.builderArgs = builderArgs;
exports.builderEnv = builderEnv;
exports.notarization = notarization;
exports.winSigning = winSigning;
exports.winBuilderArgs = winBuilderArgs;
exports.winBuilderEnv = winBuilderEnv;

if (require.main === module && process.argv.includes('--win')) {
  const w = winSigning();
  if (process.argv.includes('--github-output')) console.log(`enabled=${w.enabled}`);
  else console.log(`Windows signing: ${w.enabled ? 'Azure Artifact Signing' : 'off (unsigned build)'}`);
  if (w.partial) console.warn(`::warning::Azure signing is only partly set up (missing: ${w.partial.join(', ')}); building unsigned`);
  if (w.invalid) console.warn(`::warning::${w.invalid.join(', ')} does not look right; building unsigned`);
} else if (require.main === module) {
  const s = macSigning();
  if (process.argv.includes('--github-output')) {
    console.log([`mode=${s.mode}`, `developer_id=${s.mode === 'developer-id'}`, `notarize=${s.notarize || 'none'}`, `evs=${s.evs}`].join('\n'));
  } else {
    console.log(`macOS signing: ${s.mode}${s.mode === 'developer-id' ? `, notarization: ${s.notarize || 'off (no credentials)'}` : ''}; Widevine VMP signing: ${s.evs ? 'EVS credentials set' : 'not configured'}`);
    if (s.partialNotarization) console.warn(`warning: ${s.partialNotarization} is only partly set; the app will be signed but not notarized`);
  }
}
