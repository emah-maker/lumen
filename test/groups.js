// Tab groups: opener groups, same-site auto groups, user choices respected, collapse, restore,
// "Organize Tabs with AI" with a fake model, the group_tabs / ungroup_tabs tools, and topic groups
// (local clusters, protection of tabs the user grouped or dragged, undo, automatic, and with AI).
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

  // Two "sites": 127.0.0.1 and localhost on the same port are different hosts.
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const title = decodeURIComponent(req.url.slice(1)) || 'home';
    res.end(`<title>${title} - Docs</title><a id="blank" href="/child-of-${encodeURIComponent(title)}" target="_blank">open</a>`);
  }).listen(0);
  const port = server.address().port;
  const siteA = `http://127.0.0.1:${port}`;
  const siteB = `http://localhost:${port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-groups-'));
  // This suite checks grouping by site first; by topic (the default) is switched on where it is tested.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ tabGrouping: 'site' }));
  const launch = () => electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  let app = await launch();
  let ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Polls until fn() is truthy (returns true) or the time runs out (returns false).
  const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };
  const tabsNow = () => app.evaluate(() => global.__tabsArray());
  const groupsNow = () => app.evaluate(() => global.__tabGroups.state());
  const open = (url) => app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-stop-loading', r)); return t.id; }, url);

  // 1. Opener: one link opened in a new tab does not create a group; from a grouped tab it joins.
  const opener = await open(`${siteB}/opener`);
  const tabsAtStart = (await tabsNow()).length;
  await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("document.getElementById('blank').click()"));
  await waitFor(async () => (await tabsNow()).length > tabsAtStart);
  await sleep(300); // grouping (which must not happen) runs just after the tab opens
  let t = await tabsNow();
  const openerTab = t.find((x) => x.id === opener);
  const child = t[t.findIndex((x) => x.id === opener) + 1];
  check('link opened in a new tab does NOT create a group on its own', child && child.id !== opener && !openerTab.groupId && !child.groupId, JSON.stringify(t));
  let g = await groupsNow();
  check('no group was made from one opener + child', g.length === 0, JSON.stringify(g));
  // Put the opener in a group by hand; a link opened from it then joins that group.
  await app.evaluate((_e, ids) => global.__agent.execute('group_tabs', { name: 'Reading', tab_ids: ids }), [opener]);
  await app.evaluate((_e, id) => global.__agent.execute('switch_tab', { tab_id: id }), opener);
  await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("document.getElementById('blank').click()"));
  await waitFor(async () => { const id = (await groupsNow()).find((x) => x.name === 'Reading')?.id; return id && (await tabsNow()).filter((x) => x.groupId === id).length === 2; });
  t = await tabsNow();
  const readingGroup = (await groupsNow()).find((x) => x.name === 'Reading');
  check('a link opened from a grouped tab joins its group', t.filter((x) => x.groupId === readingGroup?.id).length === 2, JSON.stringify(t));
  // Tidy up for the next checks: keep the opener (ungrouped), close the two child tabs.
  const children = t.filter((y) => y.groupId === readingGroup?.id && y.id !== opener).map((y) => y.id);
  await app.evaluate((_e, ids) => global.__agent.execute('ungroup_tabs', { tab_ids: ids }), [opener]);
  for (const id of [...children, child?.id].filter(Boolean)) await app.evaluate((_e, tid) => global.__agent.execute('close_tab', { tab_id: tid }), id);
  await sleep(300);

  // 2. Three tabs from one site group themselves.
  for (const p of ['alpha', 'beta', 'gamma']) await open(`${siteA}/${p}`);
  await waitFor(async () => { const id = (await groupsNow()).find((x) => x.name === '127.0.0.1')?.id; return id && (await tabsNow()).filter((x) => x.groupId === id).length === 3; });
  await ui.waitForSelector('.group-label', { timeout: 3000 }).catch(() => {});
  t = await tabsNow();
  g = await groupsNow();
  const siteGroup = g.find((x) => x.name === '127.0.0.1');
  const siteTabs = t.filter((x) => siteGroup && x.groupId === siteGroup.id);
  check('3 tabs from one site form a group', siteTabs.length === 3, JSON.stringify({ t, g }));
  const idx = siteTabs.map((x) => t.findIndex((y) => y.id === x.id));
  check('grouped tabs sit together', idx.every((v, i) => i === 0 || v === idx[i - 1] + 1), JSON.stringify(idx));
  const labels = await ui.$$eval('.group-label', (els) => els.map((e) => ({ name: e.querySelector('.group-name')?.textContent, expanded: e.getAttribute('aria-expanded'), aria: e.getAttribute('aria-label') })));
  check('group labels render in the tab strip', labels.length === 1 && labels.some((l) => l.aria === 'Group 127.0.0.1, 3 tabs'), JSON.stringify(labels));

  // 3. A 4th tab from the site joins the existing group.
  const fourth = await open(`${siteA}/delta`);
  await waitFor(async () => (await tabsNow()).find((x) => x.id === fourth)?.groupId === siteGroup.id);
  t = await tabsNow();
  check('later tabs from that site join its group', t.find((x) => x.id === fourth).groupId === siteGroup.id, JSON.stringify(t));

  // 4. Remove by user: not regrouped.
  await app.evaluate((_e, id) => global.__tabGroups.remove(id, { byUser: true }), fourth);
  await app.evaluate((_e, id) => global.__agent.execute('switch_tab', { tab_id: id }), fourth);
  await app.evaluate(() => global.__agent.execute('navigate', { url: `${global.__agent.browser.activeTab().webContents.getURL()}?again` }));
  await sleep(900);
  t = await tabsNow();
  check('a tab the user removed is not pulled back in', !t.find((x) => x.id === fourth).groupId, JSON.stringify(t.find((x) => x.id === fourth)));

  // 5. Collapse hides the group's tabs (the active tab stays).
  await app.evaluate(() => global.__agent.execute('switch_tab', { tab_id: 1 }));
  await waitFor(async () => (await app.evaluate(() => global.__agent.browser.activeTab().id)) === 1);
  await sleep(200); // let the strip redraw for the new active tab
  const visibleBefore = await ui.locator('.tab').count();
  await ui.click(`.group-label[data-group="${siteGroup.id}"]`);
  await waitFor(async () => (await ui.locator('.tab').count()) === visibleBefore - 3);
  const visibleAfter = await ui.locator('.tab').count();
  const collapsedLabel = await ui.getAttribute(`.group-label[data-group="${siteGroup.id}"]`, 'aria-expanded');
  check('collapsing a group hides its tabs', visibleAfter === visibleBefore - 3 && collapsedLabel === 'false', `${visibleBefore} -> ${visibleAfter}, expanded=${collapsedLabel}`);
  await ui.click(`.group-label[data-group="${siteGroup.id}"]`);
  await waitFor(async () => (await ui.locator('.tab').count()) === visibleBefore);
  check('expanding shows them again', (await ui.locator('.tab').count()) === visibleBefore, await ui.locator('.tab').count());

  // 6. Agent tools.
  let r = await app.evaluate(async (_e, ids) => global.__agent.execute('group_tabs', { name: 'Research', tab_ids: ids }), [opener, fourth]);
  g = await groupsNow();
  t = await tabsNow();
  const research = g.find((x) => x.name === 'Research');
  check('group_tabs creates a named group', research && t.filter((x) => x.groupId === research.id).length === 2, `${r} ${JSON.stringify(g)}`);
  const listed = JSON.parse(await app.evaluate(() => global.__agent.execute('list_tabs', {})));
  check('list_tabs shows group names', listed.some((x) => x.id === opener && x.group === 'Research'), JSON.stringify(listed));
  r = await app.evaluate(async (_e, ids) => global.__agent.execute('ungroup_tabs', { tab_ids: ids }), [opener, fourth]);
  check('ungroup_tabs removes them and drops the empty group', !(await groupsNow()).some((x) => x.name === 'Research'), r);

  // 7. Organize with AI (fake Claude returning structured JSON). A (fake) Anthropic key keeps these
  // API-path steps on the API: with no key, Organize goes to Claude Code instead (7b).
  await app.evaluate(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake';
    global.__organizeAlwaysAsk = true; // ask the model even when the local groups look clear (the real app skips it then)
    global.__organizeRequest = null;
    global.__agent.getClient = () => ({ messages: { create: async (params) => {
      global.__organizeRequest = JSON.parse(JSON.stringify(params));
      const wire = JSON.parse(params.messages[0].content);
      const ids = Object.values(wire.u || {}).flat().map((x) => x[0]);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ n: [], p: [], m: [], g: [{ s: 'Reading List Stuff Extra', t: ids.slice(0, 3) }, { s: 'Solo', t: [ids[3]] }, { s: 'Bad', t: [999, ids[0]] }] }) }] };
    } } });
  });
  await app.evaluate(() => global.__organizeTabs());
  g = await groupsNow();
  const req = await app.evaluate(() => global.__organizeRequest);
  check('organize sends only compact summaries (ids, titles, hosts) with a strict JSON schema, small max_tokens and temperature 0', req?.output_config?.format?.type === 'json_schema' && req.max_tokens <= 800 && req.temperature === 0 && !/untrusted_page_content|PAGE TEXT|https?:\/\//.test(JSON.stringify(req.messages)), JSON.stringify(req).slice(0, 300));
  check('organize: the local groups apply first, the model then adds its group; singletons and unknown ids are dropped', g.length === 1 && g[0].name === 'Reading List Stuff', JSON.stringify(g));

  // 7b. Organize through the user's own Claude Code (fake CLI step): no API key involved.
  const cli = await app.evaluate(async () => {
    const saved = { settings: global.__agent.messages.settings, run: global.__cliJson.completeJSON, openai: process.env.OPENAI_API_KEY, getClient: global.__agent.getClient };
    const cc = global.__agent.engines.claudecode;
    const savedCc = { detect: cc.detect, status: cc.status };
    const calls = [];
    global.__agent.getClient = () => { throw new Error('the API must not be used'); };
    cc.detect = async () => 'claude-fake.exe';
    cc.status = async () => ({ installed: true, signedIn: true });
    global.__cliJson.completeJSON = async (opts) => {
      calls.push({ engine: opts.engine, bin: opts.bin, model: opts.model, user: opts.user, schema: Boolean(opts.schema) });
      const ids = Object.values(JSON.parse(opts.user).u || {}).flat().map((x) => x[0]);
      return { n: [], p: [], m: [], g: [{ s: 'From Claude Code', t: ids.slice(0, 2) }] };
    };
    try {
      global.__agent.messages.settings = { ...(saved.settings || {}), model: 'claudecode:opus' };
      await global.__organizeTabs();
      const picked = global.__tabGroups.state().map((x) => x.name);
      delete process.env.OPENAI_API_KEY;
      const noKey = await global.__groupingRoute('openai:gpt-5-mini');
      const grok = await global.__groupingRoute('grokbuild:grok-4.7');
      cc.status = async () => ({ installed: false, signedIn: false });
      const none = await global.__groupingRoute('openai:gpt-5-mini').then(() => null, (e) => e.message);
      return { calls, picked, noKey, grok, none };
    } finally {
      global.__agent.messages.settings = saved.settings;
      global.__cliJson.completeJSON = saved.run;
      global.__agent.getClient = saved.getClient;
      Object.assign(cc, savedCc);
      if (saved.openai !== undefined) process.env.OPENAI_API_KEY = saved.openai;
    }
  });
  check('organize with Claude Code: runs the CLI (Haiku for speed), never the API', cli.calls.length === 1 && cli.calls[0].engine === 'claudecode' && cli.calls[0].bin === 'claude-fake.exe' && cli.calls[0].model === 'haiku' && cli.calls[0].schema, JSON.stringify(cli.calls));
  check('organize with Claude Code: only group summaries and leftover ids, titles and hosts are sent', cli.calls[0] && Object.keys(JSON.parse(cli.calls[0].user)).every((k) => ['g', 'u'].includes(k)) && !/https?:\/\/|[?#]/.test(Object.keys(JSON.parse(cli.calls[0].user).u || {}).join('')), cli.calls[0]?.user);
  check('organize with Claude Code: its groups are applied', cli.picked.includes('From Claude Code'), JSON.stringify(cli.picked));
  check('organize: an API model with no key falls back to Claude Code', cli.noKey.engine === 'claudecode' && cli.noKey.model === 'haiku', JSON.stringify(cli.noKey));
  check('organize: a Grok Build pick runs Grok Build with its model', cli.grok.engine === 'grokbuild' && cli.grok.model === 'grok-4.7', JSON.stringify(cli.grok));
  check('organize: with no key and no Claude Code, the error says what to do', /API key/.test(cli.none || '') && /Claude Code/.test(cli.none || ''), cli.none);

  // 8. Restore after restart.
  const before = { groups: await groupsNow(), tabs: await tabsNow() };
  await sleep(3500); // session save
  await app.close();
  app = await launch();
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await waitFor(async () => (await groupsNow()).length === before.groups.length, 5000);
  const after = await groupsNow();
  check('groups come back after a restart', after.length === before.groups.length && after[0]?.name === before.groups[0]?.name, JSON.stringify({ before: before.groups, after }));
  const restoredMembers = (await tabsNow()).filter((x) => x.groupId === after[0]?.id).length;
  check('restored group keeps its tabs', restoredMembers === before.tabs.filter((x) => x.groupId === before.groups[0]?.id).length, restoredMembers);

  // 9. Automatic grouping can be turned off.
  await ui.evaluate(() => window.assistant.setAutoGroup(false));
  const extra = [];
  for (const p of ['one', 'two', 'three']) extra.push(await open(`${siteB}/${p}`));
  await sleep(900);
  t = await tabsNow();
  check('with automatic groups off, nothing is grouped', extra.every((id) => !t.find((x) => x.id === id).groupId), JSON.stringify(t));

  // 10. Topic groups: 3 recipe tabs + 2 GitHub tabs + 1 unrelated -> 2 groups and 1 loose tab.
  const recipes = [];
  for (const p of ['Easy Banana Bread Recipe', 'Chocolate Chip Cookie Recipes', 'Classic Pancake Recipe']) recipes.push(await open(`${siteA}/${encodeURIComponent(p)}`));
  const repos = [];
  for (const p of ['facebook react GitHub', 'microsoft vscode GitHub']) repos.push(await open(`${siteA}/${encodeURIComponent(p)}`));
  const unrelated = await open(`${siteA}/${encodeURIComponent('Weather forecast Boston')}`);
  // A recipe tab the user grouped by hand, and one the user dragged: organizing leaves both alone.
  const mine = await open(`${siteA}/${encodeURIComponent('Lemon Tart Recipe')}`);
  await app.evaluate((_e, id) => global.__agent.execute('group_tabs', { name: 'Mine', tab_ids: [id] }), mine);
  const dragged = await open(`${siteA}/${encodeURIComponent('Apple Pie Recipe')}`);
  await app.evaluate((_e, id) => global.__markDragged(id), dragged);
  const groupsBefore = await groupsNow();
  const count = await app.evaluate(() => global.__organizeByTopic());
  t = await tabsNow();
  g = await groupsNow();
  const groupOf = (id) => t.find((x) => x.id === id)?.groupId;
  const recipeGroup = g.find((x) => x.id === groupOf(recipes[0]));
  const repoGroup = g.find((x) => x.id === groupOf(repos[0]));
  check('topic: the 3 recipe tabs form one group', recipeGroup && recipes.every((id) => groupOf(id) === recipeGroup.id) && /recipe/i.test(recipeGroup.name), JSON.stringify({ g, t }));
  check('topic: the 2 GitHub tabs form another', repoGroup && repoGroup !== recipeGroup && repos.every((id) => groupOf(id) === repoGroup.id) && /github/i.test(repoGroup.name), JSON.stringify(g));
  check('topic: the unrelated tab stays loose', !groupOf(unrelated), groupOf(unrelated));
  check('topic: a tab the user grouped keeps its group', g.find((x) => x.id === groupOf(mine))?.name === 'Mine', JSON.stringify(g));
  check('topic: a tab the user dragged is not regrouped', !groupOf(dragged), groupOf(dragged));
  check('topic: organize reports the groups it made', count >= 2, count);
  await app.evaluate(() => global.__undoOrganize());
  t = await tabsNow();
  g = await groupsNow();
  check('undo puts every tab and group back', [...recipes, ...repos].every((id) => !groupOf(id)) && g.length === groupsBefore.length && g.find((x) => x.id === groupOf(mine))?.name === 'Mine', JSON.stringify({ g, groupsBefore }));

  // Automatic "By topic": 4+ loose related tabs group themselves.
  await app.evaluate(() => global.__setTabGrouping('topic'));
  await waitFor(async () => { const all = await tabsNow(); const first = all.find((x) => x.id === recipes[0])?.groupId; return first && recipes.every((id) => all.find((x) => x.id === id)?.groupId === first); });
  t = await tabsNow();
  g = await groupsNow();
  check('automatic by topic groups the recipe tabs', recipes.every((id) => groupOf(id) && groupOf(id) === groupOf(recipes[0])), JSON.stringify(t));
  check('automatic by topic leaves the dragged tab alone', !groupOf(dragged), groupOf(dragged));

  // With AI naming on: the cheapest model of the chat's provider (Haiku), only ids, titles and hosts.
  await app.evaluate(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-fake'; // the API path (see 7); this app was restarted since
    global.__topicRequest = null;
    global.__agent.getClient = () => ({ messages: { create: async (params) => {
      global.__topicRequest = JSON.parse(JSON.stringify(params));
      const list = JSON.parse(params.messages[0].content.split('Tabs:\n')[1]);
      const ids = list.filter((x) => /Banana|Cookie|Pancake/.test(x.title)).map((x) => x.id);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ groups: [{ name: 'Weekend Baking', tab_ids: ids }] }) }] };
    } } });
  });
  await app.evaluate(() => global.__setTopicAi(true));
  await app.evaluate(() => global.__organizeByTopic());
  t = await tabsNow();
  g = await groupsNow();
  const req2 = await app.evaluate(() => global.__topicRequest);
  check('AI topics use the cheapest model (Haiku) with titles and hosts only', req2?.model === 'claude-haiku-4-5' && !/untrusted_page_content|PAGE TEXT/.test(JSON.stringify(req2)), JSON.stringify(req2)?.slice(0, 200));
  check('AI topics apply the named group', g.some((x) => x.name === 'Weekend Baking' && recipes.every((id) => groupOf(id) === x.id)), JSON.stringify(g));
  await app.evaluate(() => global.__setTopicAi(false));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
