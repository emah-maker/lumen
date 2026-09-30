// The ad blocker's slow jobs, off the main thread (features/adblock.js): fetching fresh filter lists and patching
// the engine with the sign-in exceptions (~0.4 s of work that froze tabs and the UI while it ran). The engine is
// built here, saved, and main loads the saved file (~15 ms).
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { FiltersEngine } = require('@ghostery/adblocker');

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp-worker`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

(async () => {
  const { base, patched, exceptions, patch, refresh } = workerData;
  let engine;
  if (refresh) {
    // New lists: the prebuilt engine, downloaded (no cache: the kept one is what is being replaced).
    engine = await FiltersEngine.fromPrebuiltFull(fetch);
    await writeAtomic(base, engine.serialize());
  } else {
    engine = FiltersEngine.deserialize(new Uint8Array(await fs.promises.readFile(base)));
  }
  engine.updateFromDiff({ added: exceptions });
  await writeAtomic(patched, engine.serialize());
  const st = await fs.promises.stat(base);
  await writeAtomic(`${patched}.json`, JSON.stringify({ patch, baseMtime: st.mtimeMs, baseSize: st.size }));
  parentPort.postMessage({ ok: true });
})().catch((err) => parentPort.postMessage({ ok: false, error: String(err?.message || err) }));
