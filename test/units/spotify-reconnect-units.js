// The Spotify card's Reconnect / Connect button (features/widgets.js spotifyReconnect, features/spotify-view.js): the card says it is waiting, a sign-in that works clears it,
// a canceled one leaves nothing, and an account that is not on the list of Lumen's own Spotify app (development mode, 25 people) gets a plain message and the own-app offer
// (data.signIn.state 'allowlist'); the token step recognises Spotify's refusal. Runs on its own (npm run test:units picks up test/*-units.js).
'use strict';
const { createWidgets } = require('../../src/features/widgets');
const SV = require('../../src/features/spotify-view');

const CLIENT = '0123456789abcdef0123456789abcdef';
const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });

module.exports = async function spotifyReconnectUnits(check) {
  const dev = JSON.stringify({ error: 'access_denied', error_description: 'User not registered in the Developer Dashboard' });
  check('token step: Spotify\'s "not registered in the Developer Dashboard" is recognised and explained (25 people, use your own app)', SV.isAllowlistError(403, dev) && SV.tokenError(403, dev) === SV.ALLOWLIST_MESSAGE && /25 people/.test(SV.ALLOWLIST_MESSAGE) && /your own free Spotify app/.test(SV.ALLOWLIST_MESSAGE), SV.tokenError(403, dev));
  check('token step: other refusals are not taken for it', !SV.isAllowlistError(400, JSON.stringify({ error: 'invalid_grant' })) && SV.tokenError(400, JSON.stringify({ error: 'invalid_grant' })) !== SV.ALLOWLIST_MESSAGE && !SV.isAllowlistError(500, dev), '');

  let tokenBody = null;
  const secrets = new Map();
  const id = 'wrec000001';
  const updates = { n: 0 };
  const w = createWidgets({
    readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode: 'status', clientId: '', art: false, x: 0, y: 0, w: 8, h: 7 }] }), writeSettings: () => {},
    fetch: async (url) => {
      const u = new URL(url);
      if (u.pathname === '/api/token') return tokenBody ? reply(tokenBody.status, tokenBody.body) : reply(200, { access_token: 'A', refresh_token: 'R', expires_in: 3600 });
      if (u.pathname === '/v1/me') return reply(200, { display_name: 'Me' });
      return reply(404);
    },
    getSecret: (n) => secrets.get(n) || null, setSecret: (n, v) => { if (v) secrets.set(n, v); else secrets.delete(n); }, onUpdate: () => { updates.n++; }, endpoints: () => ({}),
    rateMax: () => 1e6, searchRateMax: () => 1e6,
    spotifyEngine: { read: async () => ({ mode: 'status', state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: Date.now(), source: 'engine', kind: 'none', reason: '', art: '', signedIn: true, can: { search: true } }), warm() {}, command: () => true },
  });
  const page = () => w.forPage().find((c) => c.id === id).data || {};
  await w.refresh(w.list()[0], { force: true });
  check('status card, no account: Home is offered with a connect prompt (home.connect) and no shelves', page().can.home === true && page().home.connect === true && Object.keys(page().home.shelves).length === 0, JSON.stringify([page().can, page().home]));

  let seenWaiting = null;
  const r1 = await w.spotifyReconnect(id, async (clientId) => { seenWaiting = page().signIn; return { ok: false, allowlist: true, message: SV.ALLOWLIST_MESSAGE, clientId }; });
  check('Reconnect: the card says it is waiting for Spotify while the sign-in runs', seenWaiting && seenWaiting.state === 'waiting' && /Waiting for Spotify/.test(seenWaiting.message), JSON.stringify(seenWaiting));
  check('Reconnect, account not on Lumen\'s app list: the card carries the plain message (signIn.state allowlist)', r1 === false && page().signIn && page().signIn.state === 'allowlist' && /25 people/.test(page().signIn.message), JSON.stringify(page().signIn));
  await w.spotifyReconnect(id, async () => ({ ok: false, cancelled: true, message: 'canceled' }));
  check('Reconnect, canceled: nothing is left on the card', page().signIn === null || page().signIn === undefined, JSON.stringify(page().signIn));
  await w.spotifyReconnect(id, async () => ({ ok: false, message: 'Spotify sign-in failed: x' }));
  check('Reconnect, failed: the message shows (state failed)', page().signIn && page().signIn.state === 'failed' && /failed/.test(page().signIn.message), JSON.stringify(page().signIn));
  const ok = await w.spotifyReconnect(id, async () => { const s = w.spotifyStart(''); await s.exchange('GOOD'); return { ok: true }; });
  await new Promise((r) => setTimeout(r, 50));
  check('Reconnect, it worked: the prompt goes (the account is connected: no connect flag, no sign-in note)', ok === true && secrets.get('spotify') === 'R' && !page().home?.connect && !page().signIn, JSON.stringify([page().home, page().signIn]));

  // the token step itself, against the stand-in's refusal
  secrets.clear();
  tokenBody = { status: 403, body: { error: 'access_denied', error_description: 'User not registered in the Developer Dashboard' } };
  let caught = null;
  try { await w.spotifyStart('').exchange('CODE'); } catch (err) { caught = err; }
  check('sign-in token step refused for a listed-accounts-only app: the error is flagged allowlist and says what to do', caught && caught.allowlist === true && caught.message === SV.ALLOWLIST_MESSAGE, String(caught && caught.message));
  check('the sign-in session knows when it is Lumen\'s own app (builtin) and when it is the user\'s', w.spotifyStart('').builtin === true && w.spotifyStart(CLIENT).builtin === false, '');
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
