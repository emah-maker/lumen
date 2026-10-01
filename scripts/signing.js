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
// Windows: SignPath Authenticode signing (docs/windows-signing.md). Signing itself happens in the
// release workflow (the SignPath action), not in electron-builder; this only reads the environment.
// On when the secrets SIGNPATH_API_TOKEN and SIGNPATH_ORGANIZATION_ID and the variable
// SIGNPATH_PROJECT_SLUG are all set; otherwise the build is the unsigned build it has always been
// (the stock Electron exe, one electron-builder pass). Optional variables: SIGNPATH_SIGNING_POLICY_SLUG
// (default release-signing on a v* tag, test-signing otherwise), SIGNPATH_APP_CONFIG_SLUG (default
// lumen-app), SIGNPATH_INSTALLER_CONFIG_SLUG (default lumen-installer), SIGNPATH_SIGN_APP ("false"
// signs only the Setup exe and keeps the stock Lumen.exe).
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WIN_REQUIRED = ['SIGNPATH_API_TOKEN', 'SIGNPATH_ORGANIZATION_ID', 'SIGNPATH_PROJECT_SLUG'];

function winSigning(env = process.env) {
  const missing = WIN_REQUIRED.filter((k) => !has(env, k));
  const val = (k, dflt) => (has(env, k) ? String(env[k]).trim() : dflt);
  const tag = /^refs\/tags\/v/.test(String((env || {}).GITHUB_REF || ''));
  const project = val('SIGNPATH_PROJECT_SLUG', '');
  const policy = val('SIGNPATH_SIGNING_POLICY_SLUG', tag ? 'release-signing' : 'test-signing');
  const appConfig = val('SIGNPATH_APP_CONFIG_SLUG', 'lumen-app');
  const installerConfig = val('SIGNPATH_INSTALLER_CONFIG_SLUG', 'lumen-installer');
  // These reach the workflow's outputs and the action's inputs: only plain slugs are accepted.
  const invalid = [['SIGNPATH_PROJECT_SLUG', project, has(env, 'SIGNPATH_PROJECT_SLUG')], ['SIGNPATH_SIGNING_POLICY_SLUG', policy, true], ['SIGNPATH_APP_CONFIG_SLUG', appConfig, true], ['SIGNPATH_INSTALLER_CONFIG_SLUG', installerConfig, true]]
    .filter(([, v, check]) => check && !SLUG.test(v)).map(([k]) => k);
  const enabled = missing.length === 0 && invalid.length === 0;
  const signApp = enabled && !/^(false|0|no|off)$/i.test(val('SIGNPATH_SIGN_APP', 'true'));
  return {
    enabled,
    // Some, not all, of the required values are set: reported instead of silently building unsigned.
    partial: missing.length > 0 && missing.length < WIN_REQUIRED.length ? missing : null,
    invalid: invalid.length ? invalid : null,
    signApp, // also sign Lumen.exe in win-unpacked (a first request) before the installer is built
    policy,
    // A test-signing certificate is not trusted by Windows, so only a release policy verifies as Valid.
    trusted: policy !== 'test-signing',
    project,
    appConfig,
    installerConfig,
  };
}

// electron-builder flags for the first Windows pass of a SignPath build that signs Lumen.exe:
// `--win dir` keeps the icon and version info on Lumen.exe (ProductName "Lumen": SignPath Foundation
// requires file metadata restrictions) and skips electron-builder's own signing. The second pass
// (`--win nsis zip --prepackaged <signed dir>`) takes no extra flags. The unsigned build passes none.
function winBuilderArgs(phase) {
  return phase === 'app' ? ['-c.win.signAndEditExecutable=true', '-c.win.signExecutable=false'] : [];
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

if (require.main === module && process.argv.includes('--win')) {
  const w = winSigning();
  if (process.argv.includes('--github-output')) {
    console.log([`enabled=${w.enabled}`, `sign_app=${w.signApp}`, `trusted=${w.trusted}`, `policy=${w.policy}`, `project=${w.enabled ? w.project : ''}`, `app_config=${w.appConfig}`, `installer_config=${w.installerConfig}`].join('\n'));
  } else {
    console.log(`Windows signing: ${w.enabled ? `SignPath, policy ${w.policy}, ${w.signApp ? 'Lumen.exe and the Setup exe' : 'the Setup exe only'}` : 'off (unsigned build)'}`);
  }
  if (w.partial) console.warn(`::warning::SignPath is only partly set up (missing: ${w.partial.join(', ')}); building unsigned`);
  if (w.invalid) console.warn(`::warning::${w.invalid.join(', ')} is not a plain SignPath slug; building unsigned`);
} else if (require.main === module) {
  const s = macSigning();
  if (process.argv.includes('--github-output')) {
    console.log([`mode=${s.mode}`, `developer_id=${s.mode === 'developer-id'}`, `notarize=${s.notarize || 'none'}`, `evs=${s.evs}`].join('\n'));
  } else {
    console.log(`macOS signing: ${s.mode}${s.mode === 'developer-id' ? `, notarization: ${s.notarize || 'off (no credentials)'}` : ''}; Widevine VMP signing: ${s.evs ? 'EVS credentials set' : 'not configured'}`);
    if (s.partialNotarization) console.warn(`warning: ${s.partialNotarization} is only partly set; the app will be signed but not notarized`);
  }
}
