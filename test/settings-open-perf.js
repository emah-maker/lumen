// [settings speed] Opening Settings must feel instant, hidden and STRICT, cold (the first open of a session) and warm (a second open), on a
// profile that looks used for a long time (40 saved chats, a spread of changed settings), for the default page and two deep links.
// Times are milliseconds from the open call (test/_settings-open-rig.js: the page's own clock, setImmediate gaps in main, longtask and
// long-animation-frame observers). The default page is opened the way a user does: a real pointerdown on the menu button (Lumen starts
// loading Settings then), and the pick 90 ms later, timed from the pointerdown. A deep link opened by a call is timed from the call. The limits are the targets; a failure is fixed in the code or the measurement, never by widening a limit.
//   - first paint of the visible section   < 150 ms
//   - the section filled in (no "Loading" placeholders)   < 150 ms
//   - the page answers input (a Space on a focused toggle)   < 250 ms
//   - no main-process task over 20 ms during the open
//   - no renderer long task over 50 ms during the open
require('./_tmp-cleanup');
// DEADLINE: a step that waits for something that never happens fails the suite with a message instead of holding the e2e lock.
const DEADLINE = setTimeout(() => { console.log('FAIL  the suite did not finish in 280 s (a step is stuck: see the last PASS above)'); process.exit(1); }, 280000);
const { _electron: electron } = require('playwright-core');
const { seedProfile, measure, tmpProfile, env, root, sleep } = require('./_settings-open-rig');

const LIMITS = { paint: 150, filled: 150, input: 250, main: 20, longtask: 50 };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const profile = tmpProfile();
  await seedProfile(profile);
  for (const section of ['', 'ai', 'privacy']) {
    const r = await measure(profile, section, { intent: section === '' }); // (the default page: opened from the menu button; a deep link is a function call)
    for (const when of ['cold', 'warm']) {
      const m = r[when];
      const name = `${section || 'default'} ${when}`;
      console.log(`      ${name}: paint ${m.paint} filled ${m.filled} input ${m.input} ready ${m.ready} | main max ${m.mainMax} | longtasks ${JSON.stringify(m.longtasks)}`);
      check(`${name}: first paint of the visible section under ${LIMITS.paint} ms (${m.paint} ms)`, m.paint !== null && m.paint < LIMITS.paint, m.paint);
      check(`${name}: the section is filled in, with no placeholders, under ${LIMITS.filled} ms (${m.filled} ms)`, m.filled !== null && m.filled < LIMITS.filled && !m.placeholders, `${m.filled} placeholders=${m.placeholders}`);
      check(`${name}: the page answers input under ${LIMITS.input} ms (${m.input} ms)`, m.input !== null && m.input < LIMITS.input, m.input);
      check(`${name}: no main-process task over ${LIMITS.main} ms (worst ${m.mainMax} ms)`, m.mainMax <= LIMITS.main, JSON.stringify(m.mainOver));
      check(`${name}: no renderer long task over ${LIMITS.longtask} ms`, m.longtasks.every((t) => t.dur <= LIMITS.longtask), JSON.stringify(m.longtasks));
      check(`${name}: every section is built in the end (data-ready)`, m.ready !== null, 'never ready');
    }
  }
  // Nothing is kept: a Settings page started on intent with no open after it is closed within about 5 s, and does not become a tab.
  const app = await electron.launch({ args: [root], env: env(tmpProfile()) });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(1500);
    const tabsBefore = await app.evaluate(() => global.__settings.tabs().length);
    await ui.evaluate(() => document.getElementById('app-menu').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await sleep(300);
    check('a press on the menu button starts Settings loading', await app.evaluate(() => global.__settings.hasSpare()), 'no spare');
    await sleep(5600);
    check('...and it is closed again when no open follows (nothing is kept)', !(await app.evaluate(() => global.__settings.hasSpare())), 'still kept');
    check('...and it never became a tab', (await app.evaluate(() => global.__settings.tabs().length)) === tabsBefore, 'a tab appeared');
  } finally { await app.close().catch(() => {}); }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
