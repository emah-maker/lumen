// Opens lumen://settings (a section) in a test app and returns a function that runs code in it.
// usage: const inSettings = await openSettingsTab(app, 'you-and-ai'); await inSettings("document.title")
async function openSettingsTab(app, section = 'you-and-ai') {
  const id = await app.evaluate((_e, s) => global.__settings.open(s), section);
  const run = (code) => app.evaluate(async (_e, [i, c]) => {
    try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; }
  }, [id, code]);
  for (let i = 0; i < 80; i++) {
    if ((await run('document.body?.dataset.ready === "1"')) === true) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  run.id = id;
  return run;
}

module.exports = { openSettingsTab };
