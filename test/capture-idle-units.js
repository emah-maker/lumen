// Plain Node: whenCaptureIdle (features/tab-capture.js), what the steps of making an agent's window wait for so they do not land on a screenshot's result.
const { captureJpeg, whenCaptureIdle } = require('../src/features/tab-capture');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeTab(delayMs) {
  return {
    debugger: {
      isAttached: () => true,
      detach() {},
      sendCommand: async (method) => {
        await sleep(delayMs);
        return method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { clientWidth: 100, clientHeight: 80, pageX: 0, pageY: 0 } } : { data: 'abc' };
      },
    },
  };
}

(async () => {
  let t = Date.now();
  await whenCaptureIdle();
  check('with no screenshot going on it resolves at once', Date.now() - t < 20, Date.now() - t);

  const shot = captureJpeg(fakeTab(30), { maxWidth: 720, quality: 60 });
  let idle = false;
  t = Date.now();
  const waited = whenCaptureIdle().then(() => { idle = true; });
  await sleep(10);
  check('while a screenshot is being taken it waits', idle === false, idle);
  const got = await shot;
  await waited;
  check('...and goes on once it is done (the screenshot itself is untouched)', idle === true && got?.data === 'abc' && Date.now() - t >= 40, JSON.stringify({ idle, got, ms: Date.now() - t }));

  const slow = captureJpeg(fakeTab(200), { maxWidth: 720, quality: 60 });
  t = Date.now();
  await whenCaptureIdle(50);
  const ms = Date.now() - t;
  check('it gives up after maxMs when screenshots keep coming', ms >= 45 && ms < 150, ms);
  await slow;

  const two = [captureJpeg(fakeTab(20), { maxWidth: 720, quality: 60 }), captureJpeg(fakeTab(20), { maxWidth: 720, quality: 60 })];
  t = Date.now();
  await whenCaptureIdle();
  const both = await Promise.all(two);
  check('with two queued it waits for both', Date.now() - t >= 70 && both.every((x) => x?.data === 'abc'), Date.now() - t);
  await whenCaptureIdle();
  check('afterwards it is idle again', true, '');

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
