// [about you] A Job applications project's profile (features/project-about.js block) on every engine: the API chats' system prompt
// (systemFor), Claude Code's (claudeCodePlan), Grok Build's, and Codex's and Antigravity's first message; a profile changed after a Codex or
// Antigravity thread began rides on the next message (refreshFor). Plus the applications tool's remember path (agent.js applicationsTool):
// the user's own words (recordTyped, saidLately) are what a sensitive answer is checked against, never page text. Plain Node, fake engines.
require('../helpers/_tmp-cleanup');
const { Agent, systemFor } = require('../../src/ai/agent');
const A = require('../../src/features/project-about');
const auto = require('../../src/features/automations');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const J = JSON.stringify;

const profile = auto.normalizeProfile({ name: 'Co-op', fields: { fullName: 'Sam Lee', workAuth: 'Yes', sponsorship: 'No' }, answers: [{ question: 'What is your gender?', answer: 'Male' }] });
const about = A.block(profile);
const instructions = `<project_instructions>\nCo-op search.\n</project_instructions>\n\n${about}`;

(async () => {
  // ---- the block itself: fill without asking, one question for the rest, the demographics choice, never submit
  {
    check('block: filling the saved details is approved (no asking)', /fill every question they answer/.test(about) && /without asking/.test(about), about);
    check('block: the rest in ONE question, then saved with remember', /ONE short question listing every remaining item/.test(about) && /save each with remember/.test(about), about);
    check('block: never submits without the user', /Never submit or send the application until the user says to/.test(about));
    check('block: names the work boxes not saved yet', /Not saved yet[^\n]*Available from/.test(about) && !/Not saved yet[^\n]*Authorized to work/.test(about), about);
    check('block: default demographics choice is the saved answers, never a pick of its own', /use the saved answer for each/.test(about) && /Never pick one yourself/.test(about));
    check('block: decline says to pick "Decline to self-identify"', /Decline to self-identify/.test(A.block({ ...profile, demographics: 'decline' })));
    check('block: ask leaves them for the user', /answers these themselves each time/.test(A.block({ ...profile, demographics: 'ask' })));
    check('the profile keeps its demographics choice (and a bad one is the default)', auto.normalizeProfile({ demographics: 'decline' }).demographics === 'decline' && auto.normalizeProfile({ demographics: 'x' }).demographics === 'saved');
  }

  // ---- the API chats: the system prompt
  {
    const sys = systemFor({ model: 'claude-sonnet-5-5', projectInstructions: instructions });
    check('API engine: the profile is in the system prompt', sys.includes('<about_user>') && sys.includes('Authorized to work here?: Yes'), sys.slice(-400));
    const other = systemFor({ model: 'openai:gpt-6', projectInstructions: instructions });
    check('API engine (another provider): the same', other.includes('<about_user>'), '');
  }

  // ---- the CLI engines
  const fakeBrowser = (extra = {}) => ({ activeTab: () => null, tabById: () => null, listTabs: () => [], effectiveModel: (x) => x, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0, effort: () => '', ...extra });
  const newAgent = () => { const a = new Agent(fakeBrowser(), () => null, () => ({ model: 'codex:default' })); a.reportUsage = () => null; return a; };
  const chat = (model, extra = {}) => { const m = [{ role: 'user', content: [{ type: 'text', text: 'Fill this application.' }] }]; m.settings = { model, projectInstructions: instructions, ...extra }; return m; };
  {
    const plan = newAgent().claudeCodePlan(chat('claudecode:default'), 'Fill this application.', 0, 0);
    check('Claude Code: the profile is in its system prompt', plan.spawn.systemPrompt.includes('<about_user>') && plan.spawn.systemPrompt.includes('Need visa sponsorship?: No'), '');
  }
  for (const [kind, method, sessionKey] of [['grokbuild', 'grokBuildTurn', 'gbSession'], ['antigravity', 'antigravityTurn', 'agySession'], ['codex', 'codexTurn', 'cxSession']]) {
    const calls = [];
    const agent = newAgent();
    const engine = { statusCache: null, run: async (o) => { calls.push(o); return { text: 'Filled.', sessionId: 's-1', usage: null }; } };
    agent.engines = { [kind]: engine };
    agent.engineFor = () => engine;
    agent.engineImages = () => [];
    agent.enginePictures = async () => [];
    agent.engineFiles = async () => [];
    const messages = chat(`${kind}:default`);
    await agent[method](messages, 'Fill this application.', [], new AbortController().signal, () => {});
    check(`${kind}: the first message's system prompt has the profile`, calls[0]?.systemPrompt?.includes('<about_user>') && calls[0].systemPrompt.includes('Authorized to work here?: Yes'), J(calls[0]?.systemPrompt?.slice(-300)));
    if (kind === 'grokbuild') continue; // (Grok Build gets the system prompt on every message)
    messages.settings[sessionKey] = 's-1';
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Filled.' }] }, { role: 'user', content: [{ type: 'text', text: 'go on' }] });
    await agent[method](messages, 'go on', [], new AbortController().signal, () => {});
    check(`${kind}: a follow-up with the same profile does not repeat it`, calls[1] && !calls[1].prompt.includes('<about_user>'), J(calls[1]?.prompt?.slice(0, 200)));
    const changed = A.block({ ...profile, fields: { ...profile.fields, startDate: 'January 2027' } });
    messages.settings.projectInstructions = `<project_instructions>\nCo-op search.\n</project_instructions>\n\n${changed}`;
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Asked.' }] }, { role: 'user', content: [{ type: 'text', text: 'saved it, go on' }] });
    await agent[method](messages, 'saved it, go on', [], new AbortController().signal, () => {});
    check(`${kind}: a profile changed since the thread began rides on the next message`, calls[2] && calls[2].prompt.startsWith('<about_user>') && calls[2].prompt.includes('January 2027'), J(calls[2]?.prompt?.slice(0, 300)));
    const legacy = chat(`${kind}:default`, { [sessionKey]: 'old' }); // (a thread from before this release: never given a hash)
    await agent[method](legacy, 'go on', [], new AbortController().signal, () => {});
    check(`${kind}: an older thread gets the profile once`, calls[3] && calls[3].prompt.startsWith('<about_user>'), J(calls[3]?.prompt?.slice(0, 120)));
  }
  {
    const r = A.refreshFor('no profile here', '', true);
    check('refreshFor: a project with no profile adds nothing', r.text === '' && r.seen === '');
  }

  // ---- the remember path: what the user typed, never the page
  {
    const saved = [];
    let prof = auto.normalizeProfile({ name: 'Co-op', fields: {} });
    const agent = newAgent();
    agent.browser.projects = { applications: () => ({ list: () => [], remember: (input) => { const r = A.remember(prof, input); if (r.ok) { prof = { ...prof, ...r.patch }; saved.push(r.said); } return r; } }) };
    const messages = chat('codex:default', { projectApplications: true });
    const scope = { chat: messages, gate: { emit: () => {} } };
    agent.recordTyped(messages, 'I am authorized, no sponsorship, male, not a veteran', () => {});
    check('recordTyped keeps the user\'s own recent words', (messages.saidLately || []).join(' ').includes('not a veteran'), J(messages.saidLately));
    const viaScope = async (note) => { try { return { ok: true, text: await agent.inScope(scope, () => agent.applicationsTool({ action: 'remember', note })) }; } catch (err) { return { ok: false, text: String(err.message) }; } };
    const w = await viaScope('workAuth: Yes');
    check('remember a work box: saved', w.ok && prof.fields.workAuth === 'Yes', J(w));
    const g = await viaScope('What is your gender? Male');
    check('remember a demographic answer the user gave: saved as a saved answer', g.ok && prof.answers.some((a) => /gender/.test(a.question) && a.answer === 'Male'), J(g));
    const guess = await viaScope('What is your race or ethnicity? Asian');
    check('…one the user never said: refused (never a guess)', !guess.ok && !prof.answers.some((a) => /race/.test(a.question)), J(guess));
    const secret = await viaScope('Social security number? 123-45-6789');
    check('…a secret: refused', !secret.ok, J(secret));
    const choice = await viaScope('demographics: decline');
    check('remember the demographics choice', choice.ok && prof.demographics === 'decline', J(choice));
  }

  // ---- automations follow the same choice
  {
    const opts = [{ value: '', text: 'Select', placeholder: true }, { value: 'm', text: 'Male' }, { value: 'f', text: 'Female' }, { value: 'd', text: 'I don\'t wish to answer' }];
    const field = { ref: 1, label: 'Gender', tag: 'select', required: true, options: opts };
    const saved = auto.normalizeProfile({ fields: {}, answers: [{ question: 'Gender', answer: 'Male' }] });
    check('automations, saved: the saved answer', auto.planFill([field], saved).fills[0]?.option === 'm');
    check('automations, decline: the form\'s decline option', auto.planFill([field], { ...saved, demographics: 'decline' }).fills[0]?.option === 'd');
    check('automations, ask: left for the user', auto.planFill([field], { ...saved, demographics: 'ask' }).unknown.length === 1);
    check('automations, decline with no such option: left for the user', auto.planFill([{ ...field, options: opts.slice(0, 3) }], { ...saved, demographics: 'decline' }).unknown.length === 1);
  }

  console.log(failures ? `\n${failures} about-engines check(s) failed.` : '\nAll about-engines checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
