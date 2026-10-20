// [plan mode] The sidebar AI looks before it acts: with plan mode on (the composer's "Plan first" chip, "/plan <task>", or Settings →
// AI → "Start new chats in plan mode"), it may only read (pages, tabs, the web) and ends with a propose_plan call. The chat shows the
// plan as a card (renderer/plan-mode.js) with Run plan / Edit / Keep planning; Run plan sends the approved plan as the next message
// and allows exactly the plan's sites for that chat (the chat's approved sites, the same set an "Allow" card adds to). Cards for
// buying, sending, posting or submitting still ask, and so does a script after reading a page (its own "script:<host>" key).
// Pure: agent.js gates the tools with planToolError and runs propose_plan with validatePlan; main.js turns an approved plan's sites
// into approved hosts with approvedHosts; the renderer (a plain script, no require) formats the approved message with approvedText.
{
  // Tools that only read, allowed while planning. Everything else (click, type, navigate, open_tab, run_script, fill_form, upload,
  // scroll, an outside MCP tool, a connector...) is refused with PLAN_REFUSAL. An allowlist, so a tool added later is refused until
  // someone decides it only reads. batch is allowed because each of its steps is checked on its own (agent.js allowStep);
  // delegate because its helpers only read (ai/subagents.js HELPER_TOOLS).
  const PLAN_TOOLS = new Set(['read_page', 'find', 'screenshot', 'read_urls', 'read_tabs', 'list_tabs', 'web_search', 'read_pdf', 'get_console', 'get_network', 'video_overview', 'video_frames', 'analyze_posts', 'find_sources', 'research_board', 'project_files', 'delegate', 'wait', 'wait_for', 'batch', 'propose_plan']);
  const PLAN_DESKTOP_READS = new Set(['list_apps', 'read_app', 'screenshot_app']); // [desktop apps] the desktop tool's reading actions
  const PLAN_REFUSAL = 'Plan mode: propose a plan first. While planning you may only read (read_page, find, screenshot, read_urls, read_tabs, list_tabs, web_search and the like); nothing that clicks, types, navigates, opens tabs or runs scripts. When you know enough, call propose_plan with the steps, and the user decides whether to run it.';
  const LIMITS = { title: 120, steps: 20, step: 400, sites: 10 };

  // null when `name` may run while planning, else the refusal text.
  function planToolError(name, input = {}) {
    if (name === 'word') return ['list', 'read'].includes(String(input?.action || '')) ? null : PLAN_REFUSAL; // [word] reading only
    if (name === 'desktop') return PLAN_DESKTOP_READS.has(String(input?.action || '')) ? null : PLAN_REFUSAL;
    return PLAN_TOOLS.has(name) ? null : PLAN_REFUSAL;
  }

  // "example.com", "https://Example.com/path", "shop.example.com:8443" -> the host as the approval cards key it ('' for anything else).
  function planSite(raw) {
    const text = String(raw ?? '').trim().toLowerCase();
    if (!text || text.length > 255 || /\s/.test(text)) return '';
    let url;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`); } catch { return ''; }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return '';
    const host = url.host.replace(/\.(?=:|$)/, '');
    if (!host || host.includes('*')) return '';
    if (!/^(localhost|\[[0-9a-f:]+\]|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?$/.test(host)) return '';
    return host;
  }

  const stepText = (s) => (typeof s === 'string' ? s : s && typeof s === 'object' && typeof s.text === 'string' ? s.text : '');

  // A propose_plan input (or a plan the user edited on the card) -> { plan: { title, steps, sites, risky_steps } } or { error }.
  // risky_steps are 1-based step numbers. The error is written for the model, so it can call again.
  function validatePlan(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'The plan must be an object with title, steps, sites and risky_steps.' };
    const title = String(input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.title) || 'Plan';
    if (!Array.isArray(input.steps)) return { error: 'steps must be a list of short sentences, one per step.' };
    const steps = input.steps.map((s) => stepText(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!steps.length) return { error: 'The plan needs at least one step.' };
    if (steps.length > LIMITS.steps) return { error: `A plan has at most ${LIMITS.steps} steps; group the small ones.` };
    const sites = [];
    for (const [i, raw] of (Array.isArray(input.sites) ? input.sites : []).entries()) {
      const host = planSite(raw);
      if (!host) return { error: `sites[${i}] ("${String(raw).slice(0, 80)}") is not a site name. Use host names such as "www.example.com".` };
      if (!sites.includes(host)) sites.push(host);
    }
    if (sites.length > LIMITS.sites) return { error: `A plan names at most ${LIMITS.sites} sites.` };
    const risky = [];
    for (const raw of Array.isArray(input.risky_steps) ? input.risky_steps : []) {
      const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
      if (!Number.isInteger(n) || n < 1 || n > steps.length) return { error: `risky_steps holds step numbers from 1 to ${steps.length}; ${JSON.stringify(raw)} is not one.` };
      if (!risky.includes(n)) risky.push(n);
    }
    risky.sort((a, b) => a - b);
    return { plan: { title, steps: steps.map((s) => s.slice(0, LIMITS.step)), sites, risky_steps: risky } };
  }

  // The sites an approved plan allows for its chat (validated again: the plan comes back from the renderer).
  function approvedHosts(plan) {
    const checked = validatePlan(plan);
    return checked.plan ? checked.plan.sites : [];
  }

  // What Run plan adds to the chat's approved sites for each of them: "interact:<host>", which agent.js ensureAllowed takes as an OK to
  // click and type there and nothing more. The plan's sites come from a model that has read pages, so a page could have put one there:
  // opening it, sending a search or a read to it (the "open <host>" card, keyed by the plain host) and scripts there still ask.
  const interactKey = (host) => `interact:${host}`;
  const approvedKeys = (plan) => approvedHosts(plan).map(interactKey);

  // The message Run plan sends: the plan as the user approved it (edits included), as plain text the chat shows and the model reads.
  function approvedText(plan, words = {}) {
    const w = { head: 'Run this plan. I approved it as written; still stop and ask me before anything that buys, pays, sends, posts, submits or deletes.', sites: 'Sites:', risky: 'Ask me before these steps as usual:', ...words };
    const lines = [w.head, '', plan.title, ...plan.steps.map((s, i) => `${i + 1}. ${s}${plan.risky_steps.includes(i + 1) ? ' (risky)' : ''}`)];
    if (plan.sites.length) lines.push('', `${w.sites} ${plan.sites.join(', ')}`);
    if (plan.risky_steps.length) lines.push(`${w.risky} ${plan.risky_steps.join(', ')}`);
    return lines.join('\n');
  }

  // "/plan find me a cheap flight" -> { task: 'find me a cheap flight' }; "/plan" alone -> { task: '' }; anything else null.
  function planCommand(text) {
    const m = /^\/plan(?:\s+([\s\S]*))?$/i.exec(String(text ?? '').trim());
    return m ? { task: (m[1] || '').trim() } : null;
  }

  // Said to the model in the message's browser_state block while planning (never shown in the chat).
  const PLAN_NOTE = 'Plan mode is on for this message. Do not act yet: only read (read_page, find, screenshot, read_urls, read_tabs, list_tabs, web_search) to learn what the task needs. Tools that click, type, navigate, open tabs, upload or run scripts are refused. Then call propose_plan once: a short title, numbered steps in plain words, every site the plan will act on (host names), and the numbers of risky steps (anything that buys, pays, sends, posts, submits, deletes or signs up). After propose_plan, stop: reply with one short sentence at most. The user runs, edits or rejects the plan.\n';

  const PLAN_TOOL = {
    name: 'propose_plan',
    description: 'Plan mode only: show the user your plan for the task as a card they can run, edit or send back. Call it once, after reading what you need, then stop.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the plan does, in a few words.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'The steps in order, one short sentence each (at most 20).' },
        sites: { type: 'array', items: { type: 'string' }, description: 'Host names of every site the plan will click, type or navigate on, e.g. "www.example.com" (at most 10). Running the plan allows exactly these.' },
        risky_steps: { type: 'array', items: { type: 'integer' }, description: 'Numbers (from 1) of steps that buy, pay, send, post, submit, delete or sign up.' },
      },
      required: ['title', 'steps', 'sites'],
    },
  };

  const planApi = { PLAN_TOOLS, PLAN_REFUSAL, PLAN_NOTE, PLAN_TOOL, LIMITS, planToolError, planSite, validatePlan, approvedHosts, interactKey, approvedKeys, approvedText, planCommand };
  if (typeof module !== 'undefined' && module.exports) module.exports = planApi;
  else globalThis.planMode = planApi; // (the renderer: globalThis is the window)
}
