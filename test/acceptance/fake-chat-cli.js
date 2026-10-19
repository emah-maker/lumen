// A fake `claude` / `grok` / `agy` CLI for the chat acceptance suites (test/acceptance/chat-harness.js): no login, no model.
// Run as a Node script by the harness's spawn hook, with the exact argv, env and cwd the engine built.
//
// Role: Codex when the harness says so (FAKE_ROLE=codex: `codex exec --json … -`, prompt on stdin, JSONL events, MCP token in LUMEN_MCP_TOKEN,
// threads kept under $CODEX_HOME: see fake-codex-role.js); Antigravity when the harness says so (FAKE_ROLE=agy: one -p message per process, stream-json events, its MCP token
// read from $HOME/.gemini/config/mcp_config.json a moment after start the way a real CLI reads its config, and its
// conversations kept under $HOME like agy's: --conversation <id> fails unless $HOME has that conversation); Grok when the
// argv has --prompt-file (one message per process, then exit), else Claude Code (stream-json user messages on stdin, one
// turn per line, the process stays up between messages until stdin ends).
//
// Each message's text is looked at for a marker and directives:
//   RUN-<id>        the run's name: echoed back as "reply from RUN-<id>" and logged
//   HOLD-<name>     wait until <log dir>/release-<name> exists before answering
//   PARTIAL         say "partial output from RUN-<id>" and then never finish (until killed or interrupted)
//   FAIL            end the turn with an error result (Grok: and exit 1)
//   SENDFILE        (Claude, full access) the model calls the CLI's own SendUserFile tool, which never returns a tool_result, then says its text and ends
//                   its turn; the CLI then goes quiet: no `result` line, process kept (a turn that looks done and never closes)
//   HOOKTURN        the turn ends (end_turn), then a Stop hook adds a second turn (more text, end_turn again) and the CLI goes quiet with no `result`
//   NORESULT        the turn ends (end_turn) and the CLI says nothing more: no `result` line (a hung CLI, a result in a shape Lumen does not handle)
//   HANDOFFTEXT     the reply is the AI handing the work back (ai/handoff.js reads it as a give-up, so agent.js holds its reply_complete)
//   STUCKTOOL       the CLI starts its own tool and never finishes it (a long-running tool, or one whose result is lost): quiet, until interrupted or killed
//
// Everything goes to FAKE_CHAT_LOG (jsonl): { ev: 'start' | 'msg' | 'interrupt' | 'reply', role, pid, token, session, resume, marker, prompt, t }.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const role = process.env.FAKE_ROLE === 'agy' ? 'agy' : process.env.FAKE_ROLE === 'codex' ? 'codex' : argv.includes('--prompt-file') ? 'grok' : 'claude';
const LOG = process.env.FAKE_CHAT_LOG;
const DIR = path.dirname(LOG);
const session = flag('--session-id') || flag('--resume');
const resume = argv.includes('--resume');
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tokenOf() {
  if (role === 'grok') return process.env.LUMEN_MCP_TOKEN || null;
  try {
    const lumen = JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.lumen;
    if (lumen.headers?.Authorization) return lumen.headers.Authorization.replace(/^Bearer\s+/, '');
    return lumen.env?.LUMEN_ENGINE || null;
  } catch { return null; }
}
if (role === 'agy') { require('./fake-agy-role').run({ argv, flag, LOG, DIR }); return; } // (a module of its own: see there)
if (role === 'codex') { require('./fake-codex-role').run({ argv, flag, LOG, DIR }); return; } // (so is Codex)
const token = tokenOf();
const log = (entry) => fs.appendFileSync(LOG, `${JSON.stringify({ role, pid: process.pid, token, session, resume, t: Date.now(), ...entry })}\n`);
let current = flag('--model') || flag('-m') || null; // (Claude Code can be switched to another model by a set_model control request)
log({ ev: 'start', model: current }); // (the model the engine asked this process for: Auto's choice reaches the CLI as --model, or later as set_model)

let interrupted = null; // resolves the PARTIAL wait of the turn in progress (Claude's control_request interrupt)

async function answer(prompt) {
  // The LAST marker is this message's: earlier ones may be quoted in a handover (<earlier_conversation>) or in a
  // partial reply carried over, and their directives must not apply again.
  const all = [...prompt.matchAll(/RUN-[A-Za-z0-9]+/g)];
  const marker = all.length ? all[all.length - 1][0] : 'RUN-NONE';
  // What this session remembers, like a real CLI's session on disk: every RUN-<id> it was ever sent (kept per session id under the log
  // dir, so a --resume in another process finds it), plus the ones handed over in the prompt's <earlier_conversation>. 'known' is what it
  // knew BEFORE this message: the acceptance suites check that a chat's earlier messages are always among them.
  const memory = path.join(DIR, `session-${session}.txt`);
  if (role === 'claude' && resume && !fs.existsSync(memory)) { // (a session this machine never had, or lost: the real CLI says so and ends)
    log({ ev: 'expired', session });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${session}`, errors: [`No conversation found with session ID: ${session}`], session_id: session, total_cost_usd: 0, usage: {} });
    process.exit(1);
  }
  const sessionKnown = role === 'claude' && session && fs.existsSync(memory) ? fs.readFileSync(memory, 'utf8').split('\n').filter(Boolean) : [];
  const handed = [...(/<earlier_conversation>[\s\S]*?<\/earlier_conversation>/.exec(prompt)?.[0].matchAll(/RUN-[A-Za-z0-9]+/g) || [])].map((m) => m[0]);
  // NOREC (after the marker): the CLI fails before it records the message, so its session never holds it.
  const recorded = !/NOREC/.test(all.length ? prompt.slice(all[all.length - 1].index) : prompt);
  if (role === 'claude' && session && recorded) fs.appendFileSync(memory, `${[...new Set([...handed, marker])].join('\n')}\n`);
  log({ ev: 'msg', marker, prompt, model: current, known: [...new Set([...sessionKnown, ...handed])], resumedMissing: Boolean(resume && !sessionKnown.length) });
  const fullPrompt = prompt; // (the hidden browser_state block and the attached page come before the marker)
  prompt = all.length ? prompt.slice(all[all.length - 1].index) : prompt;
  out({ type: 'system', subtype: 'init', session_id: session, model: 'fake-model', mcp_servers: [{ name: 'lumen', status: 'connected' }] });
  const hold = /HOLD-([A-Za-z0-9]+)/.exec(prompt)?.[1];
  if (hold) { while (!fs.existsSync(path.join(DIR, `release-${hold}`))) await sleep(40); }
  const say = (text) => {
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  };
  if (/\bPARTIAL\b/.test(prompt)) {
    say(`partial output from ${marker}`);
    const keep = setInterval(() => {}, 1000); // (a pending promise alone would let Node exit)
    await new Promise((resolve) => { interrupted = resolve; }); // only an interrupt (Claude) or a kill ends this
    clearInterval(keep);
    log({ ev: 'interrupt', marker });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: session, total_cost_usd: 0, usage: {} });
    return;
  }
  if (/\bFAIL\b/.test(prompt)) {
    log({ ev: 'reply', marker, failed: true });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'fake failure', errors: ['fake failure'], session_id: session, total_cost_usd: 0, usage: {} });
    if (role === 'grok') process.exit(1);
    process.exit(1); // a Claude CLI that errors out ends its process too
  }
  // PICTOOL (Grok, full access): its own image_gen tool saves a picture in the session folder under GROK_HOME and answers with the path;
  // the reply names it only as "images/1.jpg", as the real one does.
  let text = `reply from ${marker}`;
  if (role === 'grok' && /\bPICTOOL\b/.test(prompt)) {
    const dir = path.join(process.env.GROK_HOME || DIR, 'sessions', 'fake-cwd', session || 'session', 'images');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '1.jpg');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF'), Buffer.alloc(40)]));
    out({ type: 'assistant', message: { model: 'fake-model', content: [{ type: 'tool_use', id: 'call-pic', name: 'image_gen', input: { prompt: 'a cat' } }] } });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-pic', content: JSON.stringify({ type: 'ImageGen', path: file, filename: '1.jpg', session_folder: 'images' }), is_error: false }] } });
    text = 'images/1.jpg';
  }
  if (role === 'claude' && /STUCKTOOL/.test(prompt)) {
    out({ type: 'assistant', message: { model: 'fake-model', content: [{ type: 'tool_use', id: 'call-stuck', name: 'Bash', input: { command: 'sleep 9999' } }] } });
    const keep = setInterval(() => {}, 1000);
    await new Promise((resolve) => { interrupted = resolve; });
    clearInterval(keep);
    log({ ev: 'interrupt', marker });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: session, total_cost_usd: 0, usage: {} });
    return;
  }
  // DIAGRAMS: the model follows Lumen's diagram instruction (ai/image-router.js DIAGRAM_NOTE): one inline svg per numbered problem found in the
  // attached page, or, finding none, asks once and names what it looked at.
  if (role === 'claude' && fullPrompt.includes('ONE inline ```svg block')) {
    const page = /<untrusted_page_content[\s\S]*?<\/untrusted_page_content>/.exec(fullPrompt)?.[0] || '';
    const items = [...page.matchAll(/^\s*(\d+)[.)]\s+(.+)$/gm)];
    const fence = '`'.repeat(3);
    const one = (n) => [
      `Problem ${n}`, `${fence}svg`,
      `<svg viewBox="0 0 400 240"><defs><marker id="a${n}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0L6 3L0 6z"/></marker></defs><path d="M40 120H360" stroke="black"/><line x1="200" y1="120" x2="200" y2="40" stroke="red" marker-end="url(#a${n})"/><text x="208" y="60">W (${n})</text><text x="10" y="20">Problem ${n}</text></svg>`,
      fence, '1. Draw the body alone. 2. Add each force. 3. Sum forces and moments.',
    ].join('\n');
    text = items.length ? `${marker}\n${items.map((m) => one(m[1])).join('\n\n')}` : `I looked at the current tab, your attachments and this chat and found no problems to draw. Paste them. ${marker}`;
  }
  if (role === 'claude' && /HANDOFFTEXT/.test(prompt)) text = "I couldn't open the document. Please paste the full text of your report here and I'll summarize it.";
  if (role === 'claude' && /SENDFILE/.test(prompt)) {
    text = `reply from ${marker}: the worked solution is in ${path.join(DIR, 'solution.html')}`;
    out({ type: 'assistant', message: { model: 'fake-model', content: [{ type: 'tool_use', id: 'call-file', name: 'SendUserFile', input: { file_path: path.join(DIR, 'solution.html') } }] } });
    fs.writeFileSync(path.join(DIR, 'solution.html'), '<!doctype html><title>solution</title><p>worked solution');
  }
  say(text);
  out({ type: 'assistant', message: { model: 'fake-model', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } });
  if (role === 'claude' && /(SENDFILE|HOOKTURN|NORESULT)/.test(prompt)) {
    out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
    if (/HOOKTURN/.test(prompt)) {
      await sleep(150);
      out({ type: 'stream_event', event: { type: 'message_start', message: {} } });
      say('Fixed: the hook asked for a second look, done.');
      out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
    }
    log({ ev: 'reply', marker, quiet: true });
    const keep = setInterval(() => {}, 1000); // (kept alive, silent: only a kill or an interrupt ends it)
    await new Promise((resolve) => { interrupted = resolve; });
    clearInterval(keep);
    log({ ev: 'interrupt', marker });
    out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, total_cost_usd: 0, usage: {} });
    return;
  }
  // Claude Code: the model call ends its turn here, and `result` follows a moment later (the real one takes 0.8-1.1 s): Lumen shows the reply as
  // complete at the end_turn (reply_complete) and finishes its run at the result. FAKE_RESULT_GAP_MS sets the moment (default 120).
  if (role === 'claude') {
    out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
    await sleep(Number(process.env.FAKE_RESULT_GAP_MS ?? 120));
  }
  // Logged BEFORE the result line: Lumen ends a Grok run at that line and kills the process, so a log written after it can be lost.
  log({ ev: 'reply', marker });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
}

if (role === 'grok') {
  let prompt = '';
  try { prompt = JSON.parse(fs.readFileSync(flag('--prompt-file'), 'utf8')).filter((b) => b.type === 'text').map((b) => b.text).join('\n'); } catch {}
  answer(prompt).then(() => process.exit(0));
} else {
  let buf = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'control_request' && msg.request?.subtype === 'set_model') {
        current = msg.request.model || current;
        log({ ev: 'set_model', model: current });
        out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
        continue;
      }
      if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
        out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
        if (interrupted) { const r = interrupted; interrupted = null; r(); }
        continue;
      }
      if (msg.type !== 'user') continue;
      const text = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      chain = chain.then(() => answer(text));
    }
  });
  process.stdin.on('end', () => { chain.then(() => process.exit(0)); });
}
