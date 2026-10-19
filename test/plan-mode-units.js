// [plan mode] Plain Node, fakes only: ai/plan-mode.js (which tools may run while planning, the plan's checks, the approved message),
// the tool layer's refusal while planning (agent.js planCheck, batch steps included), propose_plan's card event, the sites Run plan
// allows for the chat (and only those), the plan card drawn again from a saved chat, and source guards for the wiring in main.js.
require('./_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const P = require('../src/ai/plan-mode');
const manners = require('../src/features/ai-manners');
const { Agent } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  // ---- tool gating (pure)
  for (const name of ['read_page', 'find', 'screenshot', 'read_urls', 'read_tabs', 'list_tabs', 'web_search', 'read_pdf', 'find_sources', 'delegate', 'batch', 'propose_plan']) {
    check(`planning: ${name} may run`, P.planToolError(name) === null);
  }
  for (const name of ['click', 'click_at', 'type_text', 'press_key', 'fill_form', 'upload_file', 'navigate', 'open_tab', 'switch_tab', 'close_tab', 'run_script', 'scroll', 'hover', 'drag', 'handle_dialog', 'document', 'run_macro', 'go_back', 'reload', 'group_tabs', 'clipboard', 'connector', 'mcp__server__do_thing', 'some_new_tool']) {
    check(`planning: ${name} is refused with the plan-mode message`, P.planToolError(name) === P.PLAN_REFUSAL && /^Plan mode: propose a plan first/.test(P.PLAN_REFUSAL));
  }
  check('every tool hands-off mode counts as acting is refused while planning', [...manners.ACTION_TOOLS].every((n) => P.planToolError(n) !== null), [...manners.ACTION_TOOLS].filter((n) => P.planToolError(n) === null).join(', '));
  check('desktop: reading actions may run while planning', ['list_apps', 'read_app', 'screenshot_app'].every((a) => P.planToolError('desktop', { action: a }) === null));
  check('desktop: acting ones are refused', ['click', 'type', 'press_keys', 'open_app', 'focus_app', ''].every((a) => P.planToolError('desktop', { action: a }) !== null));

  // ---- plan parsing and validation
  {
    const got = P.validatePlan({ title: '  Book   a table ', steps: ['Open the site', { text: 'Pick Friday 7pm' }, '  ', 'Confirm the booking'], sites: ['https://WWW.Example.com/path?q=1', 'www.example.com', 'shop.test:8443'], risky_steps: [3, '3'] });
    check('a plan is cleaned: title trimmed, empty steps dropped', got.plan && got.plan.title === 'Book a table' && got.plan.steps.length === 3 && got.plan.steps[1] === 'Pick Friday 7pm', JSON.stringify(got));
    check('sites become hosts, lower case, once each, port kept', JSON.stringify(got.plan?.sites) === JSON.stringify(['www.example.com', 'shop.test:8443']), JSON.stringify(got.plan?.sites));
    check('risky steps are step numbers, once each', JSON.stringify(got.plan?.risky_steps) === '[3]', JSON.stringify(got.plan?.risky_steps));
    check('no title: "Plan"', P.validatePlan({ steps: ['a'], sites: [] }).plan?.title === 'Plan');
    check('no sites is fine (a plan that only reads)', P.validatePlan({ title: 't', steps: ['a'] }).plan?.sites.length === 0);
  }
  for (const [label, input, re] of [
    ['not an object', null, /object/],
    ['steps missing', { title: 't', sites: [] }, /steps must be a list/],
    ['no real step', { title: 't', steps: ['  '], sites: [] }, /at least one step/],
    ['too many steps', { title: 't', steps: Array.from({ length: 21 }, (_, i) => `s${i}`), sites: [] }, /at most 20 steps/],
    ['a javascript: site', { steps: ['a'], sites: ['javascript:alert(1)'] }, /sites\[0\]/],
    ['a wildcard site', { steps: ['a'], sites: ['*.example.com'] }, /sites\[0\]/],
    ['a site with a password', { steps: ['a'], sites: ['https://u:p@example.com'] }, /sites\[0\]/],
    ['a sentence for a site', { steps: ['a'], sites: ['the airline website'] }, /sites\[0\]/],
    ['a file: site', { steps: ['a'], sites: ['file:///etc/passwd'] }, /sites\[0\]/],
    ['too many sites', { steps: ['a'], sites: Array.from({ length: 11 }, (_, i) => `s${i}.example.com`) }, /at most 10 sites/],
    ['a risky step past the end', { steps: ['a', 'b'], sites: [], risky_steps: [3] }, /risky_steps/],
    ['a risky step that is not a number', { steps: ['a'], sites: [], risky_steps: ['first'] }, /risky_steps/],
  ]) {
    const got = P.validatePlan(input);
    check(`invalid plan (${label}) is refused with a reason`, !got.plan && re.test(got.error || ''), JSON.stringify(got));
  }
  check('planSite: localhost and an IPv6 literal are sites', P.planSite('localhost:3000') === 'localhost:3000' && P.planSite('http://[::1]:8080/') === '[::1]:8080');
  check('planSite: a trailing dot is dropped', P.planSite('example.com.') === 'example.com');
  check('step text is capped', P.validatePlan({ steps: ['x'.repeat(1000)], sites: [] }).plan.steps[0].length === P.LIMITS.step);

  // ---- the approved message and its sites
  {
    const plan = P.validatePlan({ title: 'Order', steps: ['Search', 'Add to cart', 'Pay'], sites: ['shop.example.com'], risky_steps: [3] }).plan;
    const text = P.approvedText(plan);
    check('approved text: numbered steps, risky ones marked', /\n1\. Search\n2\. Add to cart\n3\. Pay \(risky\)/.test(text), text);
    check('approved text: the sites and the steps to ask about', /Sites: shop\.example\.com/.test(text) && /as usual: 3/.test(text), text);
    check('approved text: still asks before buying or sending', /buys, pays, sends, posts, submits or deletes/.test(text), text);
    check('approved text takes translated words', P.approvedText(plan, { head: 'Los', sites: 'Seiten:', risky: 'Fragen:' }).startsWith('Los\n'));
    check('approvedHosts: exactly the plan\'s sites', JSON.stringify(P.approvedHosts(plan)) === '["shop.example.com"]');
    check('approvedHosts: a plan that does not check out allows nothing', P.approvedHosts({ steps: ['a'], sites: ['*.evil.test'] }).length === 0 && P.approvedHosts(null).length === 0);
  }

  // ---- /plan
  check('/plan <task>', P.planCommand('/plan book a flight')?.task === 'book a flight');
  check('/plan alone', P.planCommand('/plan')?.task === '');
  check('/PLAN with a newline', P.planCommand('/PLAN\nfind two hotels')?.task === 'find two hotels');
  check('/planet and plain text are not /plan', P.planCommand('/planet x') === null && P.planCommand('plan this') === null);

  // ---- the tool layer (agent.js)
  {
    const wc = { id: 50, isDestroyed: () => false, getTitle: () => 'shop', getURL: () => 'https://shop.example.com/cart' };
    let url = 'https://shop.example.com/cart';
    wc.getURL = () => url;
    const browser = {
      activeTab: () => ({ id: 5, webContents: wc }), tabById: (id) => (id === 5 ? { id, webContents: wc } : null), listTabs: () => [{ id: 5, url, title: 'shop' }],
      effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => 'none', maxSteps: () => 0, autoApprove: () => false, bypassPermissions: () => false,
      handsOff: () => false, isAiTab: () => false, tabOff: () => false, typingText: () => '', deviceAccess: () => true, profileDir: () => '',
    };
    const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5' }));
    agent.closeSignedInTabs = () => {};
    const asked = [];
    agent.askApproval = async (host, emit, signal, opts = {}) => { asked.push(`${opts.action || 'interact'}:${host}`); return true; };
    const signal = new AbortController().signal;
    const events = [];
    const emit = (e) => events.push(e);
    const inRun = (meta, fn) => agent.inTask(5, signal, fn, [], null, meta);

    const plan = { hosts: new Set(), planMode: true };
    let msg = await refused(() => inRun(plan, () => agent.ensureAllowed('click', emit, signal, { input: { text: 'Buy' } })));
    check('planning: click is refused in the tool layer, before any card', msg === P.PLAN_REFUSAL && asked.length === 0, `${msg} / ${asked}`);
    msg = await refused(() => inRun(plan, () => agent.ensureAllowed('navigate', emit, signal, { input: { url: 'https://other.test/' } })));
    check('planning: navigate is refused', msg === P.PLAN_REFUSAL, msg);
    msg = await refused(() => inRun(plan, () => agent.ensureAllowed('run_script', emit, signal, { input: { code: '1' } })));
    check('planning: run_script is refused (it reads, but it can also act)', msg === P.PLAN_REFUSAL, msg);
    msg = await refused(() => inRun(plan, () => agent.ensureAllowed('read_page', emit, signal, { input: {} })));
    check('planning: read_page goes through', msg === null, msg);
    msg = await refused(() => inRun(plan, async () => { await agent.ensureAllowed('batch', emit, signal, { input: { steps: [] } }); await agent.allowStep('type_text', { text: 'x' }); }));
    check('planning: an acting step inside batch is refused too (allowStep)', msg === P.PLAN_REFUSAL, msg);
    msg = await refused(() => inRun({ hosts: new Set(), planMode: true, helper: true }, () => agent.ensureAllowed('fill_form', emit, signal, { input: { fields: [] } })));
    check('planning: a helper under a planning message is held to it as well', msg === P.PLAN_REFUSAL, msg);
    msg = await refused(() => inRun({ hosts: new Set(), planMode: true, userRun: true }, () => agent.ensureAllowed('click', emit, signal, { input: { text: 'x' } })));
    check('a macro the user runs is the user\'s own action: not held by plan mode', msg === null, msg);

    // propose_plan: the card's event, only while planning
    events.length = 0;
    let result = null;
    msg = await refused(async () => { result = await inRun(plan, async () => { await agent.ensureAllowed('propose_plan', emit, signal, { input: {} }); return agent.proposePlan({ title: 'Cart', steps: ['Check the cart', 'Pay'], sites: ['shop.example.com'], risky_steps: [2] }); }); });
    const card = events.find((e) => e.type === 'plan');
    check('propose_plan sends the cleaned plan to the chat as a card', msg === null && card && card.plan.title === 'Cart' && card.plan.sites[0] === 'shop.example.com' && card.plan.risky_steps[0] === 2, `${msg} ${JSON.stringify(events)}`);
    check('propose_plan tells the model to stop', /Stop here/.test(String(result)), result);
    msg = await refused(() => inRun(plan, async () => { await agent.ensureAllowed('propose_plan', emit, signal, { input: {} }); return agent.proposePlan({ title: 'x', steps: [], sites: [] }); }));
    check('an invalid plan goes back to the model with the reason', /at least one step/.test(msg || ''), msg);
    msg = await refused(() => inRun({ hosts: new Set() }, async () => { await agent.ensureAllowed('propose_plan', emit, signal, { input: {} }); return agent.proposePlan({ title: 'x', steps: ['a'], sites: [] }); }));
    check('outside plan mode propose_plan is refused', /only for plan mode/.test(msg || ''), msg);

    // Run plan: exactly the plan's sites are allowed for the chat (main.js adds approvedHosts to the chat's hosts)
    const hosts = new Set();
    for (const h of P.approvedHosts({ title: 'Cart', steps: ['Pay'], sites: ['shop.example.com'] })) hosts.add(h);
    asked.length = 0;
    msg = await refused(() => inRun({ hosts }, () => agent.ensureAllowed('click', emit, signal, { input: { text: 'Pay' } })));
    check('after Run plan: a click on a plan site asks no card', msg === null && asked.length === 0, `${msg} / ${asked}`);
    url = 'https://other.example.org/';
    msg = await refused(() => inRun({ hosts }, () => agent.ensureAllowed('click', emit, signal, { input: { text: 'x' } })));
    check('after Run plan: a site the plan did not name still asks', msg === null && asked.join() === 'interact:other.example.org', asked.join());
    url = 'https://shop.example.com/cart';
    asked.length = 0;
    const tainted = { hosts, tainted: true };
    msg = await refused(() => inRun(tainted, () => agent.ensureAllowed('run_script', emit, signal, { input: { code: '1' }, run: tainted })));
    check('after Run plan: a script after reading a page still asks (its own card)', msg === null && asked.join() === 'script:shop.example.com', asked.join());
    check('the plan\'s sites are not pre-approved for scripts', !hosts.has('script:shop.example.com') || asked.length === 1);

    // A saved chat draws the plan card again (transcript item)
    agent.messages = [
      { role: 'user', content: [{ type: 'text', text: 'plan a checkout' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Here is the plan.' }, { type: 'tool_use', id: 't1', name: 'propose_plan', input: { title: 'Cart', steps: ['Pay'], sites: ['shop.example.com'] } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ];
    const items = agent.transcript();
    const planned = items.find((i) => i.plan);
    check('transcript: the proposed plan rides on its message, for the card', planned && planned.plan.title === 'Cart' && planned.text === 'Here is the plan.', JSON.stringify(items));
  }

  // ---- wiring (source guards)
  {
    const main = src('src/main.js');
    check('main.js: Run plan adds only approvedHosts(plan) to the chat\'s approved sites', /planOpts\.approvedPlan\) for \(const host of planModeLib\.approvedHosts\(planOpts\.approvedPlan\)\) hosts\.add\(host\)/.test(main));
    check('main.js: an approved plan never runs in plan mode', /else if \(planOpts\.plan === true\) askExtra\.plan = true/.test(main));
    const agentSrc = src('src/ai/agent.js');
    check('agent.js: planCheck runs before any card or outside tool in ensureAllowed', agentSrc.indexOf('this.planCheck(name, input, run);') > 0 && agentSrc.indexOf('this.planCheck(name, input, run);') < agentSrc.indexOf('if (this.isExternalTool(name)) return this.allowExternal(name, input, gate);'));
    check('agent.js: CLI engines answer a plan-mode message with a note, never run it', /if \(planning && \(viaClaudeCode \|\| viaGrokBuild \|\| viaAntigravity \|\| viaCodex\)\)/.test(agentSrc));
    check('agent.js: the propose_plan call runs proposePlan', agentSrc.includes("case 'propose_plan': return this.proposePlan(input);"));
    check('agent.js: propose_plan is offered only while planning', /plan \? \[planMode\.PLAN_TOOL\] : \[\]/.test(agentSrc) && /this\.planning\(\) \? \[OTHER_PLAN\] : \[\]/.test(agentSrc));
    check('skills: "plan" is reserved for the command', /'btw', 'plan'\]/.test(src('src/features/skills.js')));
    const html = src('src/renderer/index.src.html');
    check('the sidebar loads the rules before the card', html.indexOf('../ai/plan-mode.js') > 0 && html.indexOf('../ai/plan-mode.js') < html.indexOf('"plan-mode.js"'));
    check('the full-page chat loads them too', src('src/renderer/chat-page.html').includes('<script src="plan-mode.js"></script>'));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
