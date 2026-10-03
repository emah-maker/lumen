// The AI status card (features/aistatus-view.js, its connector in features/widgets.js, usage.glance, cooldown snapshots): the
// shaping from raw facts, the small-size layout plan and that the page's CSS uses the same sizes. Pure node: no window, no network.
const fs = require('fs');
const path = require('path');
const AS = require('../src/features/aistatus-view');

module.exports = async function aiStatusUnits(check) {
  const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
  const H = 3600e3;
  const engines = (o = {}) => ({ claudecode: { installed: true, signedIn: true }, grokbuild: { installed: true, signedIn: false, enabled: true }, antigravity: { installed: false }, ...o });
  const byId = (d, id) => d.ais.find((a) => a.id === id);

  // ---- states ----
  const none = AS.shape({}, NOW);
  check('ai status: nothing set up says so, and lists the three CLIs as not installed', none.summary === 'No AI set up' && none.ais.length === 3 && none.ais.every((a) => a.state === 'missing' && a.stateText === 'Not installed'), JSON.stringify(none.summary));
  const d = AS.shape({ apis: ['anthropic', 'openai', 'bogus'], engines: engines(), current: { provider: 'claudecode', label: 'Sonnet' } }, NOW);
  check('ai status: API providers are listed once connected; an unknown provider is ignored', d.ais.filter((a) => a.kind === 'api').map((a) => a.id).join() === 'anthropic,openai' && !byId(d, 'bogus'), '');
  check('ai status: signed in, signed out and not installed CLIs', byId(d, 'claudecode').stateText === 'Signed in' && byId(d, 'grokbuild').state === 'out' && byId(d, 'grokbuild').stateText === 'Signed out' && byId(d, 'antigravity').state === 'missing', JSON.stringify(d.ais.map((a) => a.state)));
  check('ai status: usable AIs come first, then signed out, then not installed, in a fixed order', d.ais.map((a) => a.id).join() === 'anthropic,claudecode,openai,grokbuild,antigravity', d.ais.map((a) => a.id).join());
  check('ai status: the model in use is on its AI only', byId(d, 'claudecode').current && byId(d, 'claudecode').model === 'Sonnet' && d.ais.filter((a) => a.current).length === 1 && !byId(d, 'openai').model, '');
  check('ai status: an installed CLI switched off in the sidebar says so', byId(AS.shape({ engines: engines({ grokbuild: { installed: true, signedIn: true, enabled: false } }) }, NOW), 'grokbuild').stateText === 'Off in the sidebar', '');

  // ---- limits, usage ----
  const limited = AS.shape({ apis: ['anthropic'], engines: engines(), cooling: { claudecode: { until: NOW + 3 * H, kind: 'limit', exact: true, scope: 'provider' } } }, NOW);
  const cc = byId(limited, 'claudecode');
  check('ai status: a limit shows "Limit reached" and when it resets', cc.state === 'limited' && cc.stateText === 'Limit reached' && /^Resets \d{1,2}:\d{2}/.test(cc.note), JSON.stringify(cc));
  check('ai status: a limit sorts after what is ready, and the compact note names it', limited.ais[0].state === 'ready' && /^Claude Code limit reached, resets /.test(limited.sub) && limited.counts.limited === 1, limited.sub);
  const guess = byId(AS.shape({ engines: engines(), cooling: { claudecode: { until: NOW + H, kind: 'limit', exact: false, scope: 'provider' } } }, NOW), 'claudecode');
  check('ai status: a guessed end is "about", not an exact reset', /^Paused until about /.test(guess.note), guess.note);
  const gone = byId(AS.shape({ engines: engines(), cooling: { claudecode: { until: NOW - 1, kind: 'limit', scope: 'provider' } } }, NOW), 'claudecode');
  check('ai status: a limit that has ended is not shown', gone.state === 'ready', JSON.stringify(gone));
  const down = byId(AS.shape({ engines: engines(), cooling: { claudecode: { until: NOW + 900e3, kind: 'unreachable', scope: 'provider' } } }, NOW), 'claudecode');
  check('ai status: unreachable is its own state', down.state === 'down' && down.stateText === 'Unreachable', JSON.stringify(down));
  const family = byId(AS.shape({ engines: engines(), cooling: { claudecode: { until: NOW + 2 * H, kind: 'limit', exact: true, scope: 'model', model: 'Opus' } } }, NOW), 'claudecode');
  check('ai status: one model out leaves the AI ready, with a note', family.state === 'ready' && /^Opus limit reached, resets /.test(family.note), JSON.stringify(family));
  const grok = byId(AS.shape({ engines: engines({ grokbuild: { installed: true, signedIn: true, enabled: true } }), grokLimit: { resetsAt: null } }, NOW), 'grokbuild');
  check('ai status: Grok Build’s own limit message counts even with no reset time', grok.state === 'limited' && grok.note === 'Resets later', JSON.stringify(grok));
  const meter = byId(AS.shape({ engines: engines(), meter: { percent: 62.4, resetsAt: NOW + 2 * H }, today: { claudecode: { turns: 3, costUSD: 0.4237 } } }, NOW), 'claudecode');
  check('ai status: Claude Code’s 5-hour reading and today’s cost are the hint', /^62% of the 5-hour limit used, resets \d.* · \$0\.42 today$/.test(meter.note), meter.note);
  check('ai status: a reading whose window ended is dropped', byId(AS.shape({ engines: engines(), meter: { percent: 90, resetsAt: NOW - 5 } }, NOW), 'claudecode').note === '', '');
  check('ai status: full access shows for a CLI only when the setting is on (and is ignored when absent)', byId(AS.shape({ engines: engines(), fullAccess: { claudecode: true, grokbuild: undefined, antigravity: false, openai: true } }, NOW), 'claudecode').fullAccess === true && !byId(AS.shape({ engines: engines(), fullAccess: { grokbuild: undefined } }, NOW), 'grokbuild').fullAccess && !('fullAccess' in byId(AS.shape({ engines: engines(), fullAccess: { claudecode: false } }, NOW), 'claudecode')), '');

  // ---- the small card's chips: logo, dot, word, one fact ----
  check('ai status chips: every AI has a logo name, a short word and a full sentence', AS.ORDER.every((id) => { const a = byId(AS.shape({ apis: AS.ORDER, engines: engines({ codex: { installed: true, signedIn: true } }) }, NOW), id); return a && a.brand === AS.BRANDS[id] && a.short === AS.SHORT[a.state] && a.label.startsWith(`${a.name}: ${a.stateText}`); }), '');
  check('ai status chips: Claude and Claude Code share a logo, Grok and Grok Build too; every brand is one the page can draw', AS.BRANDS.anthropic === AS.BRANDS.claudecode && AS.BRANDS.xai === AS.BRANDS.grokbuild && new Set(Object.values(AS.BRANDS)).size === 6, JSON.stringify(AS.BRANDS));
  check('ai status chips: the words are Ready, Limit, Down, Sign in, Off, Missing (a state is never only a colour)', ['ready', 'limited', 'down', 'out', 'off', 'missing'].map((k) => AS.SHORT[k]).join() === 'Ready,Limit,Down,Sign in,Off,Missing', '');
  check('ai status chips: a limit’s fact is when it resets (~ when only guessed); the label has the sentence', /^\d{1,2}:\d{2}/.test(cc.fact) && /^~\d{1,2}:\d{2}/.test(guess.fact) && cc.short === 'Limit' && /^Claude Code: Limit reached\. Resets /.test(cc.label), `${cc.fact} ${guess.fact} ${cc.label}`);
  check('ai status chips: the fact is the 5-hour reading, else today’s cost, else nothing', meter.fact === '62% used' && byId(AS.shape({ engines: engines(), today: { claudecode: { costUSD: 0.4237 } } }, NOW), 'claudecode').fact === '$0.42' && byId(d, 'claudecode').fact === '' && byId(d, 'grokbuild').fact === '', meter.fact);
  check('ai status chips: unreachable names when it tries again; signed out and not installed say what to do', down.fact !== '' && /^Claude Code: Unreachable\. Trying again /.test(down.label) && byId(d, 'grokbuild').label === 'Grok Build: Signed out. Sign in under Settings' && byId(d, 'antigravity').short === 'Missing', down.label);

  // ---- the live strip and the summary ----
  const live = AS.shape({ apis: ['anthropic', 'openai'], engines: engines(), runs: { working: 1, waiting: 2, max: 3 }, aiTabs: 4, handsOff: true }, NOW);
  check('ai status: summary counts ready and working', live.summary === '3 ready · 1 working · 2 waiting' && AS.shape({ apis: ['openai'], engines: engines() }, NOW).summary === '2 ready · idle', live.summary);
  check('ai status: the live strip has chats working of the maximum, the queue, AI tabs and Hands-off', live.liveText.join(' | ') === '1 of 3 chats working | 2 waiting | 4 AI tabs | Hands-off on', live.liveText.join(' | '));
  const idle = AS.shape({ apis: ['openai'], engines: engines(), runs: { working: 0, waiting: 0, max: 3 }, aiTabs: 1 }, NOW);
  check('ai status: idle says no chats working and names a single tab in the singular', idle.liveText.join(' | ') === 'No chats working | 1 AI tab' && idle.sub === '1 AI tab', idle.liveText.join(' | '));
  check('ai status: hands-off is the note when nothing is limited', AS.shape({ apis: ['openai'], engines: engines(), handsOff: true }, NOW).sub === 'Hands-off on', '');
  check('ai status: garbage in gives sane numbers out, never a throw', (() => { const g = AS.shape({ apis: 'x', engines: null, runs: { working: -3, waiting: 'a', max: 0 }, aiTabs: NaN, cooling: [] }, NOW); return g.live.working === 0 && g.live.max === 1 && g.live.tabs === 0 && Array.isArray(g.ais); })() && AS.shape(null, NOW).ais.length === 3 && AS.shape(undefined).ais.length === 3, '');
  check('ai status: nothing secret is in the data (no key, token or address)', !/sk-|token|secret|https?:|@/i.test(JSON.stringify(AS.shape({ apis: ['anthropic'], engines: engines(), current: { provider: 'anthropic', label: 'Sonnet 5' } }, NOW))), '');
  check('ai status: the result is plain, small data (it travels in the page address)', JSON.stringify(AS.shape({ apis: AS.ORDER, engines: engines(), runs: { working: 9, waiting: 9, max: 9 }, aiTabs: 99, handsOff: true, cooling: Object.fromEntries(AS.ORDER.map((id) => [id, { until: NOW + H, kind: 'limit', exact: true, scope: 'provider' }])) }, NOW)).length < 3500, '');
  check('ai status: reset times read as clock times, with the day when it is not today', /^\d{1,2}:\d{2}/.test(AS.clockText(NOW + H, NOW)) && /^[A-Za-z]{3,}.* \d{1,2}:\d{2}/.test(AS.clockText(NOW + 2 * 24 * H, NOW)) && AS.clockText('x', NOW) === '', AS.clockText(NOW + 2 * 24 * H, NOW));

  // ---- Codex CLI: shown once installed; its own limit state, 5-hour reading and sign-in ----
  check('ai status: Codex CLI is listed only once it is installed (it is not a sidebar engine)', !byId(AS.shape({ engines: engines() }, NOW), 'codex') && !byId(AS.shape({ engines: engines({ codex: { installed: false } }) }, NOW), 'codex') && byId(AS.shape({ engines: engines({ codex: { installed: true, signedIn: true } }) }, NOW), 'codex')?.stateText === 'Signed in', '');
  check('ai status: Codex signed out says so; its logo is OpenAI’s', byId(AS.shape({ engines: engines({ codex: { installed: true, signedIn: false } }) }, NOW), 'codex')?.state === 'out' && AS.BRANDS.codex === 'openai' && AS.NAMES.codex === 'Codex CLI', '');
  const cx = byId(AS.shape({ engines: engines({ codex: { installed: true, signedIn: true } }), codexLimit: { resetsAt: NOW + 2 * H } }, NOW), 'codex');
  check('ai status: Codex limit reached shows the reset time the plan reported', cx.state === 'limited' && cx.stateText === 'Limit reached' && /^Resets \d{1,2}:\d{2}/.test(cx.note), JSON.stringify(cx));
  const cm = byId(AS.shape({ engines: engines({ codex: { installed: true, signedIn: true } }), codexMeter: { percent: 41.6, resetsAt: NOW + 3 * H } }, NOW), 'codex');
  check('ai status: Codex 5-hour reading is the hint (and Claude’s meter is not applied to it)', /^42% of the 5-hour limit used, resets /.test(cm.note) && cm.fact === '42% used' && byId(AS.shape({ engines: engines({ codex: { installed: true, signedIn: true } }), meter: { percent: 90, resetsAt: NOW + H } }, NOW), 'codex').note === '', cm.note);
  check('ai status: a Grok limit does not mark Codex limited', byId(AS.shape({ engines: engines({ codex: { installed: true, signedIn: true }, grokbuild: { installed: true, signedIn: true, enabled: true } }), grokLimit: { resetsAt: null } }, NOW), 'codex').state === 'ready', '');

  // ---- the layout plan, and the page's CSS following it ----
  const L = AS.layoutFor;
  check('ai status layout: the smallest card is the summary and dots, with no list or live strip', L({ width: 102, height: 94 }).mode === 'dots' && !L({ width: 102, height: 94 }).live && L({ width: 102, height: 94 }).sub === false, JSON.stringify(L({ width: 102, height: 94 })));
  check('ai status layout: a wide but short card stays compact; a narrow tall one gets rows, stacked', L({ width: 300, height: 100 }).mode === 'dots' && L({ width: 120, height: 200 }).mode === 'dots' && L({ width: 160, height: 140 }).mode === 'dots' && L({ width: 160, height: 160 }).mode === 'rows' && !L({ width: 160, height: 160 }).inline && L({ width: 215, height: 115 }).mode === 'rows' && L({ width: 215, height: 115 }).inline, JSON.stringify([L({ width: 160, height: 160 }), L({ width: 215, height: 115 })]));
  check('ai status layout: more room adds the inline state, the detail lines and the live strip, never less', (() => { let prev = null; for (const [w, h] of [[160, 120], [215, 120], [240, 155], [300, 200], [400, 300]]) { const p = L({ width: w, height: h }); const score = (p.mode === 'detail' ? 2 : p.mode === 'rows' ? 1 : 0) + (p.inline ? 1 : 0) + (p.live ? 1 : 0); if (prev !== null && score < prev) return false; prev = score; } return true; })(), '');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'newtab.html'), 'utf8');
  const T = AS.THRESHOLDS;
  const has = (re) => re.test(html);
  check('ai status page: the CSS switches layouts at the plan’s sizes (@container card)', has(new RegExp(`@container card \\(min-width: ${T.rows.minWidth}px\\) and \\(min-height: ${T.rows.minHeight}px\\) \\{ \\.ai-compact \\{ display: none; \\} \\.ai-list`))
    && has(new RegExp(`@container card \\(min-width: ${T.inline.minWidth}px\\) and \\(min-height: ${T.inline.minHeight}px\\) \\{ \\.ai-compact \\{ display: none; \\} \\.ai-list`))
    && has(new RegExp(`@container card \\(min-width: ${T.inline.minWidth}px\\) and \\(min-height: ${T.inline.minHeight}px\\) \\{\\s*\\.ai-row`))
    && has(new RegExp(`@container card \\(min-width: ${T.detail.minWidth}px\\) and \\(min-height: ${T.detail.minHeight}px\\) \\{ \\.ai-detail`))
    && has(new RegExp(`@container card \\(min-width: ${T.rows.minWidth}px\\) and \\(min-height: ${T.live.minHeight}px\\) \\{ \\.ai-live`))
    && has(new RegExp(`@container card \\(min-height: ${T.sub.minHeight}px\\) \\{ \\.ai-sub`)), '');
  const css = html.slice(html.indexOf('/* AI status:'), html.indexOf('/* Stocks and Crypto'));
  check('ai status page: state has shapes as well as colours, the dots carry text for a screen reader, and dark and glass have their colours', /\.s-limited > \.ai-mark/.test(css) && /\.s-out > \.ai-mark/.test(css) && /\.ai-sr/.test(css) && /prefers-color-scheme: dark\) \{ \.w-card\.aistatus/.test(css) && /body\.on-media \.w-card\.aistatus/.test(css), '');

  // ---- wired end to end ----
  const { CONNECTORS, INLINE, createWidgets } = require('../src/features/widgets');
  const WL = require('../src/features/widget-layout');
  const WS = require('../src/renderer/widget-summary');
  const WE = require('../src/features/widget-edit');
  check('ai status: a connector, a default and minimum size of 2 by 2, a picker entry and a name', Boolean(CONNECTORS.aistatus) && WL.limitsOf('aistatus').minW === 2 && WL.limitsOf('aistatus').minH === 2 && WL.defaultSize('aistatus').w >= 2 && WS.ORDER.includes('aistatus') && WS.kindName('aistatus') === 'AI status' && typeof INLINE.aistatus === 'function', '');
  check('ai status: the add-widget picker lists it with a hint', WE.pickerEntries({ types: ['aistatus'], hidden: [], table: null, stack: false }).some((e) => e.type === 'aistatus' && e.label === 'AI status' && e.hint), JSON.stringify(WE.pickerEntries({ types: ['aistatus'], hidden: [], table: null, stack: false })));
  let stored = { homeWidgets: [{ id: 'wai0001', type: 'aistatus', x: 0, y: 0, w: 3, h: 3 }] };
  let facts = { apis: ['openai'], engines: engines(), runs: { working: 0, waiting: 0, max: 3 }, aiTabs: 0 };
  let updates = 0;
  const widgets = createWidgets({ readSettings: () => stored, writeSettings: (s) => { stored = s; }, fetch: async () => { throw new Error('no network'); }, getSecret: () => null, setSecret: () => {}, onUpdate: () => { updates++; }, aiStatus: () => facts });
  await widgets.refresh(widgets.list()[0]);
  const card = widgets.forPage().find((c) => c.id === 'wai0001');
  check('ai status: the card gets the shaped data from main’s facts and never fetches', card && card.type === 'aistatus' && card.data.summary === '2 ready · idle' && card.title === 'AI status' && !card.error && card.setup, JSON.stringify(card && card.data && card.data.summary));
  const base = updates; // (the first fetch already told the page)
  check('ai status: the first look asks the page to update, an unchanged one does not', widgets.aiStatusChanged() === true && updates === base + 1 && widgets.aiStatusChanged() === false && updates === base + 1, `updates=${updates}`);
  facts = { ...facts, runs: { working: 1, waiting: 0, max: 3 } };
  check('ai status: a chat starting changes the card and updates the page once', widgets.aiStatusChanged() === true && updates === base + 2 && widgets.forPage().find((c) => c.id === 'wai0001').data.live.working === 1, `updates=${updates}`);
  stored = { homeWidgets: [] };
  facts = { ...facts, runs: { working: 2, waiting: 0, max: 3 } };
  check('ai status: with no such card on the page nothing is computed or sent', widgets.aiStatusChanged() === false && updates === base + 2, `updates=${updates}`);

  // ---- the facts main hands over ----
  const fb = require('../src/ai/fallback');
  const cool = fb.createCooldowns();
  cool.mark('claudecode:default', { kind: 'limit', scope: 'provider', resetsAt: NOW + 2 * H, exact: true }, NOW);
  cool.mark('openai:gpt-5.6', { kind: 'limit', scope: 'model', resetsAt: NOW + H, exact: false }, NOW);
  cool.mark('claudecode:opus', { kind: 'limit', scope: 'model', family: 'opus', resetsAt: NOW + 5 * H, exact: true }, NOW);
  const snap = cool.snapshot(NOW);
  check('cooldown snapshot: per provider, a whole-provider limit wins over a model one', snap.claudecode.scope === 'provider' && snap.claudecode.kind === 'limit' && snap.claudecode.until === NOW + 2 * H && snap.openai.scope === 'model' && snap.openai.model === 'gpt-5.6', JSON.stringify(snap));
  check('cooldown snapshot: ended entries are gone', Object.keys(cool.snapshot(NOW + 9 * H)).length === 0 && fb.createCooldowns().snapshot(NOW) && Object.keys(fb.createCooldowns().snapshot(NOW)).length === 0, '');
  const { createUsage } = require('../src/features/usage');
  const usage = createUsage({ app: { getPath: () => require('os').tmpdir() }, claudeBin: async () => null, now: () => NOW, otherActivity: async () => false });
  usage.record('claudecode', { usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.25, models: ['sonnet'] }, rateLimit: null, model: 'sonnet' });
  usage.record('grokbuild', { limit: { text: 'limit reached', resetsAt: NOW + H } });
  const g = usage.glance(NOW);
  check('usage glance: today per engine, Grok’s limit, and a quick synchronous answer', g.today.claudecode.turns === 1 && Math.abs(g.today.claudecode.costUSD - 0.25) < 1e-9 && g.grokLimit && g.grokLimit.resetsAt === NOW + H && g.meter === null && usage.glance(NOW + 2 * H).grokLimit === null, JSON.stringify(g));
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
