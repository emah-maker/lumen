// Captures the README's screenshots and GIFs into docs/media/.
//
//   node scripts/capture-media.js                 # everything
//   node scripts/capture-media.js newtab settings # only some (newtab, settings, mcp, groups, agent)
//
// Each capture launches Lumen with a throwaway profile (CLAUDE_BROWSER_TEST=1, a fresh
// CLAUDE_BROWSER_PROFILE), puts the window at 1440×900 on the primary display, always on top, and
// records that screen region with ffmpeg's gdigrab (Windows). Everything is driven through Electron
// and Playwright's CDP connection: the script never moves the mouse or sends OS-level input.
// Without ffmpeg (or off Windows) it falls back to webContents.capturePage PNGs of the UI window,
// which leaves out the tab's own view; GIFs and the MP4 are skipped then.
//
// The agent capture runs a real task with "Claude · your account (Claude Code)". Claude Code keeps
// its own login outside Lumen's profile, so the throwaway profile still uses this computer's
// existing `claude` login, read-only. It is skipped (with a message) when the CLI isn't signed in.
const { _electron: electron } = require('playwright-core');
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'media');
const WIDTH = 1440;
const HEIGHT = 900;
const GIF_LIMIT = 8 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[capture]', ...a);

const hasFfmpeg = process.platform === 'win32' && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
if (!hasFfmpeg) log('ffmpeg with gdigrab is not available: PNGs come from capturePage (UI only), no GIF/MP4.');

// ---------------------------------------------------------------- launching

async function launch({ dark = false, seed = {} } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-media-'));
  // Settings in place before the first window: the theme, and anything a capture needs.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ theme: dark ? 'dark' : 'light', ...seed }));
  const env = {
    ...process.env,
    CLAUDE_BROWSER_TEST: '1',
    CLAUDE_BROWSER_PROFILE: profile,
    // An empty Anthropic CLI profile and no API keys: nothing personal shows in the model menu or
    // Settings. Claude Code's own login (~/.claude) is untouched and used as-is.
    ANTHROPIC_CONFIG_DIR: path.join(profile, 'ant-cli'),
  };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'LUMEN_GROK_SIDEBAR']) delete env[k];
  // Playwright emulates a light prefers-color-scheme unless told otherwise.
  const app = await electron.launch({ args: [ROOT], env, colorScheme: dark ? 'dark' : 'light' });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const rect = await app.evaluate(async ({ BrowserWindow, screen }, { width, height }) => {
    const win = BrowserWindow.getAllWindows().find((w) => /renderer[\\/]index\.html/.test(w.webContents.getURL())) || BrowserWindow.getAllWindows()[0];
    const area = screen.getPrimaryDisplay().workArea;
    if (win.isMaximized()) win.unmaximize();
    win.setContentBounds({ x: area.x + Math.max(0, Math.round((area.width - width) / 2)), y: area.y + Math.max(0, Math.round((area.height - height) / 2)), width, height });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.show();
    win.focus();
    await new Promise((r) => setTimeout(r, 600));
    const content = win.getContentBounds();
    // gdigrab works in physical pixels.
    return process.platform === 'win32' ? screen.dipToScreenRect(win, content) : content;
  }, { width: WIDTH, height: HEIGHT });
  // Draw as focused even if Windows kept focus elsewhere (the UI dims itself when inactive).
  await ui.evaluate(() => document.body.classList.remove('window-inactive'));
  await sleep(800);
  return { app, ui, rect, profile };
}

async function close({ app, profile }) {
  await app.close().catch(() => {});
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------- capturing

const even = (n) => Math.floor(n / 2) * 2;
const grabArgs = (rect, fps) => ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0',
  '-offset_x', String(rect.x), '-offset_y', String(rect.y), '-video_size', `${even(rect.width)}x${even(rect.height)}`, '-i', 'desktop'];

async function png(ctx, name) {
  const file = path.join(OUT, name);
  await ctx.ui.evaluate(() => document.body.classList.remove('window-inactive'));
  if (hasFfmpeg) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...grabArgs(ctx.rect, 5), '-frames:v', '1', file]);
  } else {
    const image = await ctx.app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(file, Buffer.from(image, 'base64'));
  }
  log(`${name}  ${kb(file)}`);
}

// Starts a screen recording of the window; stop() resolves with the .mp4 path.
function record(ctx, name, fps = 20) {
  if (!hasFfmpeg) return { stop: async () => null };
  const file = path.join(OUT, name);
  const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...grabArgs(ctx.rect, fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'ignore', 'inherit'] });
  return {
    stop: () => new Promise((resolve) => {
      p.on('close', () => resolve(file));
      p.stdin.write('q');
      p.stdin.end();
    }),
  };
}

// MP4 -> GIF under 8 MB: palettegen/paletteuse, stepping down width and frame rate until it fits.
function toGif(mp4, gifName, { speed = 1 } = {}) {
  const gif = path.join(OUT, gifName);
  const attempts = [[1200, 12], [1000, 10], [900, 8], [800, 7], [720, 6], [640, 5]];
  for (const [width, fps] of attempts) {
    const filters = `${speed !== 1 ? `setpts=PTS/${speed},` : ''}fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-filter_complex', filters, '-loop', '0', gif]);
    if (fs.statSync(gif).size < GIF_LIMIT) break;
  }
  log(`${gifName}  ${kb(gif)}`);
}

const kb = (file) => `${Math.round(fs.statSync(file).size / 1024)} KB`;

// ---------------------------------------------------------------- captures

async function openAndWait(app, url) {
  return app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => { t.webContents.once('did-finish-load', r); setTimeout(r, 15000); });
    return t.id;
  }, url);
}

async function newtab() {
  for (const dark of [false, true]) {
    const ctx = await launch({ dark });
    await ctx.ui.evaluate(() => document.activeElement?.blur());
    await sleep(1500);
    await png(ctx, `newtab-${dark ? 'dark' : 'light'}.png`);
    await close(ctx);
  }
}

async function settings() {
  const ctx = await launch();
  // In place of the starting new tab, as if opened from it.
  const first = await ctx.app.evaluate(() => global.__tabsArray()[0]?.id);
  await ctx.app.evaluate(() => global.__settings.open('you-and-ai'));
  if (first) await ctx.app.evaluate((_e, id) => global.__agent.browser.closeTab(id), first).catch(() => {});
  await sleep(2500);
  await ctx.ui.evaluate(() => document.activeElement?.blur());
  await png(ctx, 'settings.png');
  await close(ctx);
}

// A staged external-agent session: an MCP client's steps and an approval card, sent to the sidebar
// the same way features/ai-agents.js does (mcp:event). Nothing is connected for real.
async function mcp() {
  const ctx = await launch();
  const { app, ui } = ctx;
  const first = await app.evaluate(() => global.__tabsArray()[0]?.id);
  await openAndWait(app, 'https://en.wikipedia.org/wiki/Web_browser');
  if (first) await app.evaluate((_e, id) => global.__agent.browser.closeTab(id), first).catch(() => {});
  await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
  await sleep(900);
  const send = (event) => app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0].webContents.send('mcp:event', e), event);
  const client = 'Claude Code';
  await send({ type: 'session', active: true, remaining: 0, clientName: client });
  await send({ type: 'tool', id: 'm1', name: 'list_tabs', input: {}, clientName: client });
  await send({ type: 'tool_done', id: 'm1', ok: true, clientName: client });
  await send({ type: 'tool', id: 'm2', name: 'read_page', input: { mode: 'compact' }, clientName: client });
  await send({ type: 'tool_done', id: 'm2', ok: true, clientName: client });
  await send({ type: 'tool', id: 'm3', name: 'click', input: { text: 'History' }, clientName: client });
  await send({ type: 'approval', approvalId: 90001, host: 'en.wikipedia.org', clientName: client });
  await sleep(1200);
  await png(ctx, 'mcp-approval.png');
  await send({ type: 'approval_done', approvalId: 90001, ok: false, clientName: client });
  await send({ type: 'session', active: false, remaining: 0, clientName: client });
  await close(ctx);
}

const TOPIC_TABS = [
  'https://www.allrecipes.com/recipe/20144/banana-banana-bread/',
  'https://en.wikipedia.org/wiki/Lisbon',
  'https://react.dev/learn',
  'https://www.bbcgoodfood.com/recipes/easy-pancakes',
  'https://www.lonelyplanet.com/portugal/lisbon',
  'https://react.dev/reference/react/useState',
  'https://www.simplyrecipes.com/recipes/homemade_pizza/',
  'https://en.wikivoyage.org/wiki/Lisbon',
  'https://react.dev/reference/react/useEffect',
];

async function groups() {
  const ctx = await launch({ seed: { tabGrouping: 'off', autoGroupTabs: false, topicAi: false } });
  const { app, ui } = ctx;
  const first = await app.evaluate(() => global.__tabsArray()[0]?.id);
  for (const url of TOPIC_TABS) await openAndWait(app, url);
  // The starting new tab isn't part of the story.
  if (first) await app.evaluate((_e, id) => global.__agent.browser.closeTab(id), first).catch(() => {});
  await app.evaluate((_e, url) => { const t = global.__agent.browser.listTabs().find((x) => x.url.startsWith(url)); if (t) global.__agent.browser.switchTab(t.id); }, 'https://react.dev/learn').catch(() => {});
  await sleep(2500);
  await ui.evaluate(() => document.activeElement?.blur());
  const rec = record(ctx, 'tab-groups.mp4');
  await sleep(1800);
  const count = await app.evaluate(() => global.__organizeByTopic());
  log(`organizeByTopic made ${count} groups`);
  await sleep(3500);
  await png(ctx, 'tab-groups.png');
  const mp4 = await rec.stop();
  if (mp4) { toGif(mp4, 'tab-groups.gif'); fs.rmSync(mp4, { force: true }); }
  const tabs = await ui.$$eval('.tab', (els) => els.length);
  log(`tab strip shows ${tabs} tabs`);
  await close(ctx);
}

const AGENT_PROMPT = 'Open Hacker News and list the top 5 stories with their points, one line each.';

async function agent() {
  const bin = await require('../claude-code').findClaude();
  if (!bin) { log('agent: SKIPPED, the claude CLI is not installed'); return; }
  const status = spawnSync(bin, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 10000 });
  let signedIn = false;
  try { signedIn = JSON.parse(status.stdout).loggedIn === true; } catch {}
  if (!signedIn) { log('agent: SKIPPED, Claude Code is not signed in (run `claude`, then /login)'); return; }

  const ctx = await launch();
  const { app, ui } = ctx;
  await ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); });
  let ids = [];
  for (let i = 0; i < 40 && !ids.includes('claudecode:default'); i++) {
    await sleep(300);
    ids = await ui.$$eval('#model option', (os) => os.map((o) => o.value));
  }
  if (!ids.includes('claudecode:default')) { log('agent: SKIPPED, the model menu has no Claude Code option'); await close(ctx); return; }
  await ui.selectOption('#model', 'claudecode:default');
  await ui.evaluate(() => { window.__mediaEvents = []; window.assistant.onEvent((e) => window.__mediaEvents.push({ type: e.type, name: e.name, text: e.text })); });
  await sleep(1000);

  const rec = record(ctx, 'agent-task.mp4', 15);
  const t0 = Date.now();
  await sleep(1200);
  await ui.fill('#prompt', AGENT_PROMPT);
  await sleep(900);
  await ui.press('#prompt', 'Enter');
  let done = false;
  for (let i = 0; i < 360 && !done; i++) {
    await sleep(500);
    done = await ui.evaluate(() => window.__mediaEvents.some((e) => e.type === 'done' || e.type === 'error'));
  }
  await sleep(2500);
  const mp4 = await rec.stop();
  const events = await ui.evaluate(() => window.__mediaEvents);
  log(`agent: ${Math.round((Date.now() - t0) / 1000)}s, tools: ${events.filter((e) => e.type === 'tool').map((e) => e.name).join(', ')}; errors: ${events.filter((e) => e.type === 'error').map((e) => e.text).join(' | ') || 'none'}`);
  await ui.evaluate(() => document.getElementById('prompt').blur());
  await png(ctx, 'sidebar-agent.png');
  if (mp4) {
    log(`agent-task.mp4  ${kb(mp4)}`);
    const seconds = (Date.now() - t0) / 1000;
    toGif(mp4, 'agent-task.gif', { speed: seconds > 40 ? 2 : 1 });
  }
  await close(ctx);
}

const CAPTURES = { newtab, settings, mcp, groups, agent };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const wanted = process.argv.slice(2);
  for (const name of wanted.length ? wanted : Object.keys(CAPTURES)) {
    if (!CAPTURES[name]) { log(`unknown capture: ${name} (choose from ${Object.keys(CAPTURES).join(', ')})`); continue; }
    log(`--- ${name}`);
    await CAPTURES[name]();
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
