// Tab groups: opener groups, same-site auto groups, user choices respected, collapse, restore,
// "Organize Tabs with AI" with a fake model, and the group_tabs / ungroup_tabs tools.
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
  const launch = () => electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  let app = await launch();
  let ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tabsNow = () => app.evaluate(() => global.__tabsArray());
  const groupsNow = () => app.evaluate(() => global.__tabGroups.state());
  const open = (url) => app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-stop-loading', r)); return t.id; }, url);

  // 1. Opener: one link opened in a new tab does not create a group; from a grouped tab it joins.
  const opener = await open(`${siteB}/opener`);
  await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("document.getElementById('blank').click()"));
  await sleep(1500);
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
  await sleep(1500);
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
  await sleep(900);
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
  await sleep(900);
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
  await sleep(300);
  const visibleBefore = await ui.locator('.tab').count();
  await ui.click(`.group-label[data-group="${siteGroup.id}"]`);
  await sleep(600);
  const visibleAfter = await ui.locator('.tab').count();
  const collapsedLabel = await ui.getAttribute(`.group-label[data-group="${siteGroup.id}"]`, 'aria-expanded');
  check('collapsing a group hides its tabs', visibleAfter === visibleBefore - 3 && collapsedLabel === 'false', `${visibleBefore} -> ${visibleAfter}, expanded=${collapsedLabel}`);
  await ui.click(`.group-label[data-group="${siteGroup.id}"]`);
  await sleep(600);
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

  // 7. Organize with AI (fake Claude returning structured JSON).
  await app.evaluate(() => {
    global.__organizeRequest = null;
    global.__agent.getClient = () => ({ messages: { create: async (params) => {
      global.__organizeRequest = JSON.parse(JSON.stringify(params));
      const tabs = JSON.parse(params.messages[0].content.split('Tabs:\n')[1]);
      const ids = tabs.map((x) => x.id);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ groups: [{ name: 'Reading List Stuff Extra', tab_ids: ids.slice(0, 3) }, { name: 'Solo', tab_ids: [ids[3]] }, { name: 'Bad', tab_ids: [999, ids[0]] }] }) }] };
    } } });
  });
  await app.evaluate(() => global.__organizeTabs());
  g = await groupsNow();
  const req = await app.evaluate(() => global.__organizeRequest);
  check('organize sends only ids, titles and hosts with a JSON schema', req?.output_config?.format?.type === 'json_schema' && !/untrusted_page_content|PAGE TEXT/.test(JSON.stringify(req)), JSON.stringify(req).slice(0, 200));
  check('organize applies groups; singletons and unknown ids are dropped', g.length === 1 && g[0].name === 'Reading List Stuff', JSON.stringify(g));

  // 8. Restore after restart.
  const before = { groups: await groupsNow(), tabs: await tabsNow() };
  await sleep(3500); // session save
  await app.close();
  app = await launch();
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await sleep(1500);
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

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
