// Sign-in files shared with the CLIs (Codex per-chat homes, Grok's GROK_HOME), plain Node, nothing from the real ~/.codex or ~/.grok.
// The fake CLI's token file holds a refresh token that is SINGLE USE, as with the real CLIs: refreshing rotates it and the old one is
// dead from then on ("refresh token already used" -> the user has to sign in again). A refresh with a dead token is the bug these
// suites guard against, so every scenario counts them (`dead`) and a run that ends with one fails.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-authsync-'));

const authSync = require('../src/ai/auth-sync');
const cx = require('../src/ai/codex');
const gb = require('../src/ai/grok-build');

let clock = Date.now() - 600000; // every write gets its own, later modification time (as real refreshes minutes apart do)
const tick = () => { clock += 5000; return new Date(clock); };
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); const t = tick(); fs.utimesSync(file, t, t); };
const get = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// The identity provider: one valid refresh token at a time.
function makeServer(first = 'rt-0') {
  const server = { valid: first, n: 0, dead: 0, refreshes: 0 };
  // The CLI refreshes the token it finds in `file`: a valid one rotates (written back as a new file, as Grok does, or in place, as
  // Codex does), a dead one counts and leaves the file alone.
  server.refresh = (file, { replace = false } = {}) => {
    const have = get(file);
    if (have !== server.valid) { server.dead++; return false; }
    server.refreshes++;
    server.valid = `rt-${++server.n}`;
    if (replace) { fs.rmSync(file, { force: true }); }
    put(file, server.valid);
    return true;
  };
  return server;
}

(async () => {
  // ---------- auth-sync primitives ----------
  {
    const a = path.join(tmp, 'p', 'a.json'); const b = path.join(tmp, 'p', 'b.json'); const c = path.join(tmp, 'p', 'c.json');
    put(a, 'old'); put(b, 'newest'); put(c, 'mid');
    fs.utimesSync(c, new Date(clock - 20000), new Date(clock - 20000));
    const n = await authSync.syncNewest([a, b, c]);
    check('syncNewest: the newest file goes to every other copy, none is overwritten by an older one', n === 2 && get(a) === 'newest' && get(b) === 'newest' && get(c) === 'newest', [get(a), get(b), get(c)].join());
    check('syncNewest: nothing to do when all are equal', (await authSync.syncNewest([a, b, c])) === 0);
    check('syncNewest: a missing source is fine', (await authSync.syncNewest([path.join(tmp, 'none1'), path.join(tmp, 'none2')])) === 0);
    const old = path.join(tmp, 'p', 'old.json');
    put(old, 'stale'); fs.utimesSync(old, new Date(clock - 900000), new Date(clock - 900000));
    check('copyIfNewer never copies an older file over a newer one', (await authSync.copyIfNewer(old, a)) === false && get(a) === 'newest');
    check('no temp files are left behind', fs.readdirSync(path.join(tmp, 'p')).every((f) => !/\.lumen-/.test(f)), fs.readdirSync(path.join(tmp, 'p')).join());
  }

  // ---------- Codex: parallel chats, each with its own CODEX_HOME ----------
  {
    const root = path.join(tmp, 'codex'); const userHome = path.join(root, 'user');
    const chats = path.join(root, 'userData', 'codex-chats');
    const homes = ['a', 'b', 'c'].map((k) => path.join(chats, k));
    const server = makeServer();
    put(path.join(userHome, 'auth.json'), server.valid);
    // a run: pull, the CLI maybe refreshes inside it, then the copy-back
    const run = async (home, { refresh = false } = {}) => {
      await cx.pullAuth({ userHome, home });
      if (refresh) server.refresh(path.join(home, 'auth.json'), { replace: true });
      else if (get(path.join(home, 'auth.json')) !== server.valid) server.dead++; // the CLI would fail on a stale token as soon as it refreshes
      await cx.returnAuth({ userHome, home });
    };
    for (const h of homes) { fs.mkdirSync(h, { recursive: true }); await run(h); }
    await run(homes[0], { refresh: true }); // chat a's token expired: refreshed
    check('Codex: a refresh in one chat reaches the user\'s file and every other chat home', homes.every((h) => get(path.join(h, 'auth.json')) === server.valid) && get(path.join(userHome, 'auth.json')) === server.valid, homes.map((h) => get(path.join(h, 'auth.json'))).join());
    await run(homes[1]); await run(homes[2]); // the other chats' next messages start with the rotated token
    await run(homes[2], { refresh: true }); await run(homes[1], { refresh: true }); await run(homes[0]);
    check('Codex: chats refreshing one after the other never use a dead token', server.dead === 0 && server.refreshes === 3, `dead ${server.dead}, refreshes ${server.refreshes}`);
    // a chat that is idle (its home stale) while another refreshes: its next run picks the new token up
    await cx.pullAuth({ userHome, home: homes[0] });
    put(path.join(userHome, 'auth.json'), 'rt-from-codex-login'); server.valid = 'rt-from-codex-login'; // `codex login` in a terminal
    await run(homes[1]);
    check('Codex: a newer sign-in of the user\'s goes into the chat home', get(path.join(homes[1], 'auth.json')) === 'rt-from-codex-login' && server.dead === 0);
    // two chats finishing at the same moment: their copy-backs are serialized and nothing is lost
    await Promise.all(homes.map((h) => cx.pullAuth({ userHome, home: h })));
    server.refresh(path.join(homes[0], 'auth.json'), { replace: true });
    await Promise.all(homes.map((h) => cx.returnAuth({ userHome, home: h })));
    check('Codex: copy-backs finishing together keep the refreshed token everywhere', homes.every((h) => get(path.join(h, 'auth.json')) === server.valid) && get(path.join(userHome, 'auth.json')) === server.valid);
    check('Codex: no temp files are left in the chat homes', homes.every((h) => fs.readdirSync(h).every((f) => !/\.lumen-/.test(f))));
  }

  // ---------- Grok: Lumen's GROK_HOME with the user's auth.json linked in ----------
  {
    const root = path.join(tmp, 'grok'); const userHome = path.join(root, 'user'); const home = path.join(root, 'grok-home');
    fs.mkdirSync(home, { recursive: true });
    const server = makeServer();
    put(path.join(userHome, 'auth.json'), server.valid);
    const mine = () => path.join(home, 'auth.json');
    const real = () => path.join(userHome, 'auth.json');

    // 1. Grok refreshes (replacing the file), Lumen quits / crashes before the copy-back; the next start must not drop that token
    const before = gb.linkAuth(userHome, home);
    check('Grok: linked', get(mine()) === server.valid && before);
    server.refresh(mine(), { replace: true }); // the refresh Grok did in the run
    const after = gb.linkAuth(userHome, home); // Lumen starts again, the copy-back never happened
    check('Grok: a refreshed token whose copy-back never happened is carried back, not deleted by the next link', get(real()) === server.valid && get(mine()) === server.valid, `${get(real())} / ${get(mine())} / ${server.valid}`);
    check('Grok: the next run holds a valid token', get(mine()) === server.valid && server.dead === 0);

    // 2. the user's terminal refreshed meanwhile (newer file of theirs): never overwritten by Lumen's older copy
    server.refresh(real(), { replace: true });
    check('Grok: the user\'s newer sign-in is not overwritten by Lumen\'s older copy', !gb.settleAuth(userHome, home, after) && get(real()) === server.valid);
    gb.linkAuth(userHome, home);
    check('Grok: and the next link hands Grok that newer token', get(mine()) === server.valid);

    // 3. a one-shot (cli-json) and a sidebar run on the same home, the sidebar's Grok refreshing in between
    const a = gb.linkAuth(userHome, home);
    server.refresh(mine(), { replace: true });
    const oneshot = gb.linkAuth(userHome, home); // the background task starts while the sidebar's run is going
    check('Grok: a second link while a run holds a refreshed token keeps that token', get(mine()) === server.valid && get(real()) === server.valid && server.dead === 0, `${get(mine())} ${get(real())} ${server.valid}`);
    gb.settleAuth(userHome, home, a); gb.settleAuth(userHome, home, oneshot);
    check('Grok: the copy-backs after it leave the token alone', get(real()) === server.valid && get(mine()) === server.valid);

    // 4. async path with the sign-in lock: parallel runs and a kept process
    const release1 = gb.holdAuth(userHome, home);
    const link1 = await gb.shareAuth(userHome, home);
    const release2 = gb.holdAuth(userHome, home); // a second chat's run, same link
    const link2 = await gb.shareAuth(userHome, home);
    check('Grok: parallel runs share one link', link1 === link2 || (link1 && link2 && link1.mtimeNs === link2.mtimeNs));
    server.refresh(mine(), { replace: true });
    await release1(); // not the last run: nothing copied yet
    await release2(); // the last: copied back once
    check('Grok: the last run\'s end copies the rotated token back', get(real()) === server.valid, `${get(real())} vs ${server.valid}`);
    const hold = gb.holdAuth(userHome, home); await gb.shareAuth(userHome, home); // a kept process: holds for its whole life
    server.refresh(mine(), { replace: true });
    await hold.settle(); // after its turn
    check('Grok: a kept process\'s refresh is copied back after its turn', get(real()) === server.valid);
    await hold();
    const final = await gb.linkAuthAsync(userHome, home);
    check('Grok: linking again afterwards keeps the newest token for every run; none used a dead one', get(mine()) === server.valid && get(real()) === server.valid && final && server.dead === 0, `dead ${server.dead}`);
    check('Grok: no temp files are left in GROK_HOME', fs.readdirSync(home).every((f) => !/\.lumen-/.test(f)), fs.readdirSync(home).join());
  }

  // ---------- "sign in again" only when the CLI really says so ----------
  {
    const claude = require('../src/ai/claude-code').describeFailure;
    const codex = cx.describeFailure;
    const grok = gb.describeFailure;
    const signedOut = (r) => /not signed in/.test(r.text);
    check('a real sign-in failure is still reported as one (Claude Code / Codex / Grok Build)',
      signedOut(claude('OAuth token has expired. Please run /login', 1)) && signedOut(claude('Invalid API key · Please run /login', 1))
      && signedOut(codex('unexpected status 401 Unauthorized: token expired', 1)) && signedOut(codex('Your refresh token was already used. Please sign in again', 1)) && signedOut(codex('Not logged in', 1))
      && signedOut(grok('You are not authenticated. Run `grok login`', 1)) && signedOut(grok('Not logged in', 1)));
    check('a network, rate or server error that mentions OAuth is not reported as signed out',
      !signedOut(claude('OAuth token refresh failed: ECONNRESET', 1)) && !signedOut(claude('Failed to authenticate: fetch failed (network error)', 1)) && !signedOut(claude('API Error: 529 overloaded_error while checking credentials', 1))
      && !signedOut(codex('failed to refresh token: connection reset by peer', 1)) && !signedOut(codex('authentication failed: request timed out', 1))
      && !signedOut(grok('oauth token refresh error: ETIMEDOUT', 1)) && !signedOut(grok('could not authenticate: dns error, try again', 1)));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nAll sign-in sync checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
