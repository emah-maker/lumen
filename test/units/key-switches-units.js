// [key switches] Settings → AI → API keys: each saved key has an on/off switch (settings.keysOff). A key switched off stays
// saved but Lumen uses none of it: main.js providerKey / anthropicKeyOn return nothing for it, so its models leave the picker,
// the image router never asks it (image-router-units.js covers that side), and switching it back on needs no retyping.
// Plain Node: the setting's checks and its apply hook, and the wiring in main.js and the Settings page read from source.
// The real window (a key switched off and on, the model menu following) is test/e2e/key-switches.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const SB = require('../../src/settings/settings-backend');
const FO = require('../../src/features/feature-offers');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const src = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', p), 'utf8');

(async () => {
  // ---- the setting
  check('every key is on by default', J(SB.DEFAULTS.keysOff) === '[]');
  check('it takes the providers Settings lists, each once', J(SB.validate('keysOff', ['openai', 'anthropic', 'openai', 'xai', 'gemini', 'openrouter'])) === J(['openai', 'anthropic', 'xai', 'gemini', 'openrouter']));
  check('anything else is dropped (unknown ids, the local AI, other secrets)', J(SB.validate('keysOff', ['banana', 'local', 'telegram', 'safebrowsing', 7, null, 'gemini'])) === J(['gemini']));
  check('a value that is not a list is refused', SB.validate('keysOff', 'openai') === null && SB.validate('keysOff', null) === null && SB.validate('keysOff', { openai: true }) === null);

  // ---- a change reaches the running browser (the model list and the Claude client follow)
  {
    let settings = {};
    let changed = 0;
    const backend = SB.create({
      app: { getPath: () => os.tmpdir(), disableHardwareAcceleration() {}, commandLine: { appendSwitch() {} }, getLocale: () => 'en' },
      session: { defaultSession: { availableSpellCheckerLanguages: [], getSpellCheckerLanguages: () => [] } }, nativeTheme: {}, dialog: {}, shell: {}, readSettings: () => settings, writeSettings: (s) => { settings = s; },
      onKeysOffChange: () => { changed++; },
    });
    await backend.set('keysOff', ['openai']);
    check('switching a key off is saved and tells main.js at once', J(settings.keysOff) === J(['openai']) && changed === 1, J({ settings, changed }));
    await backend.set('keysOff', []);
    check('switching it back on is saved too (nothing else about the key changes)', J(settings.keysOff) === '[]' && changed === 2 && !('keys' in settings) && !('apiKeyEnc' in settings), J({ settings, changed }));
  }

  // ---- main.js: an off key is never used
  {
    const main = src('main.js');
    const fn = (name) => { const at = main.indexOf(`function ${name}(`); return at < 0 ? '' : main.slice(at, main.indexOf('\n}\n', at)); };
    check('providerKey returns nothing for a key switched off (saved or from the environment)', /if \(keyOff\(provider\)\) return null;/.test(fn('providerKey')) && fn('providerKey').indexOf('keyOff(provider)') < fn('providerKey').indexOf('process.env'), fn('providerKey'));
    check('the Anthropic key switched off: Claude is offered only through an `ant auth login` sign-in', /anthropicKeyOn = \(\) => !keyOff\('anthropic'\)/.test(main) && /return Boolean\(anthropicKeyOn\(\) \|\|/.test(fn('anthropicUsable')));
    check('the Claude client never falls back to ANTHROPIC_API_KEY when the key is off', /off \? new Anthropic\(\{ apiKey: null/.test(fn('getClient')), fn('getClient'));
    check('a change rebuilds the Claude client and the model lists', /onKeysOffChange: \(\) => \{ client = null; for \(const p of Object\.keys\(providers\.PROVIDERS\)\) if \(p !== 'local'\) refreshModels\(p\)/.test(main));
    check('Settings is told which keys are off', /anthropicKeyOff: keyOff\('anthropic'\)/.test(main) && /off: keyOff\(p\),/.test(main));
    check('saving or removing a key does not touch the switch (it stays off until switched on)', !/keysOff/.test(main.slice(main.indexOf("ipcMain.handle('settings:set-provider-key'"), main.indexOf("ipcMain.handle('openrouter:models'"))));
  }

  // ---- the Settings page and its words
  {
    const ui = src('renderer/settings.js');
    const en = JSON.parse(src('locales/en.json'));
    check('each key that is set gets a switch (a key that is not set has nothing to switch)', /info\.stored \|\| info\.env \? onOff\(\) : null/.test(ui) && /class: 'switch key-switch', role: 'switch'/.test(ui));
    check('the switch saves keysOff and the model list follows', /save\('keysOff', \[\.\.\.next\], input\)/.test(ui) && /await refreshModels\(\);\s*renderKeys\(\);/.test(ui));
    check('a key that is off says Off, and its switch is named for the key', en['settings.ai.keyOff'] === 'Off' && /\{name\}/.test(en['settings.ai.keyUse']) && /switch it back on/.test(en['settings.ai.keysDesc']));
    check('"Make pictures with" marks the providers that are not set up or whose key is off', en['settings.ai.imageGen'] === 'Make pictures with' && en['settings.ai.imageGen.notSetUp'] && /k\.off \|\| !\(k\.stored \|\| k\.env\)/.test(ui) && /autoUseRender\(\);\s*imageEngineRender\(\);/.test(ui));
  }

  // ---- "New in Lumen"
  {
    const line = FO.OFFERS.find((o) => o.key === 'keysOff');
    const en = JSON.parse(src('locales/en.json'));
    check('the switches are shown once on the "New in Lumen" card, opening Settings → API keys', line?.kind === 'setup' && line.section === 'ai-keys-page' && en[`offers.${line.id}`] && en[`offers.${line.id}.desc`], J(line));
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
