// [settings speed] Opening Settings must feel instant, hidden and STRICT, cold (the first open of a session) and warm (a second open), on a
// profile that looks used for a long time (40 saved chats, a spread of changed settings), for the default page and two deep links.
// Times are milliseconds from the open call (test/_settings-open-rig.js: the page's own clock, setImmediate gaps in main, longtask and
// long-animation-frame observers). The limits are the targets; a failure is fixed in the code or the measurement, never by widening a limit.
//   - first paint of the visible section   < 150 ms
//   - the section filled in (no "Loading" placeholders)   < 150 ms
//   - the page answers input (a Space on a focused toggle)   < 250 ms
//   - no main-process task over 20 ms during the open
//   - no renderer long task over 50 ms during the open
require('./_tmp-cleanup');
const { seedProfile, measure, tmpProfile } = require('./_settings-open-rig');

const LIMITS = { paint: 150, filled: 150, input: 250, main: 20, longtask: 50 };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const profile = tmpProfile();
  await seedProfile(profile);
  for (const section of ['', 'ai', 'privacy']) {
    const r = await measure(profile, section);
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
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
