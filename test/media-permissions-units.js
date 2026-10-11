// Camera and microphone are decided separately (browser/site-permissions.js): allowing one never covers the other, a prompt
// asks only about the devices with no decision, and old combined "origin|media" decisions become one entry each.
const SP = require('../src/browser/site-permissions');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const O = 'https://meet.example';
const both = { mediaTypes: ['audio', 'video'] };
const mic = { mediaTypes: ['audio'] };
const cam = { mediaTypes: ['video'] };

// ---- migration
{
  const d = new Map([[`${O}|media`, true], ['https://no.example|media', false], ['https://a.example|geolocation', true]]);
  check('migrate: reports a change', SP.migrate(d) === true);
  check('migrate: an old grant becomes a camera and a microphone grant', d.get(`${O}|camera`) === true && d.get(`${O}|microphone`) === true && !d.has(`${O}|media`));
  check('migrate: an old refusal stays a refusal for both', d.get('https://no.example|camera') === false && d.get('https://no.example|microphone') === false);
  check('migrate: other permissions are untouched', d.get('https://a.example|geolocation') === true && d.size === 5);
  check('migrate: running it again changes nothing', SP.migrate(d) === false && d.size === 5);
  const mixed = new Map([[`${O}|media`, true], [`${O}|camera`, false]]);
  SP.migrate(mixed);
  check('migrate: a decision made since for one device is not overwritten', mixed.get(`${O}|camera`) === false && mixed.get(`${O}|microphone`) === true && !mixed.has(`${O}|media`));
  // the old grant keeps working through the request and check paths
  check('migrated grant: a request for both needs no prompt', JSON.stringify(SP.plan(d, O, 'media', both)) === '{"deny":false,"ask":[]}');
  check('migrated grant: a check for either device says yes', SP.allowedNow(d, O, 'media', { mediaType: 'video' }) && SP.allowedNow(d, O, 'media', { mediaType: 'audio' }));
  check('migrated refusal: a request is refused outright', SP.plan(d, 'https://no.example', 'media', both).deny === true);
}

// ---- microphone allowed, camera still prompts
{
  const d = new Map([[`${O}|microphone`, true]]);
  check('mic allowed: a microphone-only request needs no prompt', JSON.stringify(SP.plan(d, O, 'media', mic)) === '{"deny":false,"ask":[]}');
  check('mic allowed: a camera-only request still prompts, for the camera', JSON.stringify(SP.plan(d, O, 'media', cam)) === '{"deny":false,"ask":["camera"]}');
  check('mic allowed: a request for both prompts only for the camera', JSON.stringify(SP.plan(d, O, 'media', both)) === '{"deny":false,"ask":["camera"]}');
  check('mic allowed: the prompt then says only "use your camera"', SP.promptKey('media', { mediaTypes: ['video'] }) === 'permission.media.video');
  check('mic allowed: a camera check says no, a microphone check says yes', !SP.allowedNow(d, O, 'media', { mediaType: 'video' }) && SP.allowedNow(d, O, 'media', { mediaType: 'audio' }));
  check('mic allowed: device enumeration (unnamed) is allowed, as the microphone is', SP.allowedNow(d, O, 'media', { mediaType: 'unknown' }) && SP.allowedNow(d, O, 'media', {}));
  d.set(`${O}|camera`, true);
  check('then camera allowed too: nothing is asked', SP.plan(d, O, 'media', both).ask.length === 0);
}

// ---- refusals, defaults and other permissions
{
  const d = new Map([[`${O}|camera`, false]]);
  check('camera refused: a request for both is refused without asking about the microphone', JSON.stringify(SP.plan(d, O, 'media', both)) === '{"deny":true,"ask":[]}');
  check('camera refused: a microphone-only request still prompts', JSON.stringify(SP.plan(d, O, 'media', mic)) === '{"deny":false,"ask":["microphone"]}');
  const blocked = (p) => p === 'camera';
  check('Block default: refuses an undecided camera, not an undecided microphone', SP.plan(new Map(), O, 'media', cam, blocked).deny === true && SP.plan(new Map(), O, 'media', mic, blocked).ask[0] === 'microphone');
  check('a request that names no device asks about both', SP.plan(new Map(), O, 'media', {}).ask.join() === 'camera,microphone');
  check('other permissions work as before', JSON.stringify(SP.plan(new Map(), O, 'geolocation', {})) === '{"deny":false,"ask":["geolocation"]}' && SP.plan(new Map([[`${O}|geolocation`, false]]), O, 'geolocation', {}).deny && SP.allowedNow(new Map([[`${O}|geolocation`, true]]), O, 'geolocation', {}));
}

// ---- what a page reads (permissions.query)
{
  const decisions = new Map([[`${O}|microphone`, true]]);
  const ses = {};
  SP.register(ses, { decisions, isBlocked: () => false });
  const states = SP.statesFor(ses, O);
  check('page states: microphone granted, camera still undecided (prompt)', states.microphone === 'granted' && !('camera' in states) && !('media' in states), JSON.stringify(states));
}

process.exit(failures ? 1 : 0);
