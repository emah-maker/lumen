// A fake `claude` / `grok` / `agy` CLI for the chat acceptance suites (test/acceptance/chat-harness.js): no login, no model.
// Run as a Node script by the harness's spawn hook, with the exact argv, env and cwd the engine built.
//
// Role: Antigravity when the harness says so (FAKE_ROLE=agy: one -p message per process, stream-json events, its MCP token
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
//
// Everything goes to FAKE_CHAT_LOG (jsonl): { ev: 'start' | 'msg' | 'interrupt' | 'reply', role, pid, token, session, resume, marker, prompt, t }.
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const role = process.env.FAKE_ROLE === 'agy' ? 'agy' : argv.includes('--prompt-file') ? 'grok' : 'claude';
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
const token = tokenOf();
const log = (entry) => fs.appendFileSync(LOG, `${JSON.stringify({ role, pid: process.pid, token, session, resume, t: Date.now(), ...entry })}\n`);
log({ ev: 'start' });

let interrupted = null; // resolves the PARTIAL wait of the turn in progress (Claude's control_request interrupt)

async function answer(prompt) {
  // The LAST marker is this message's: earlier ones may be quoted in a handover (<earlier_conversation>) or in a
  // partial reply carried over, and their directives must not apply again.
  const all = [...prompt.matchAll(/RUN-[A-Za-z0-9]+/g)];
  const marker = all.length ? all[all.length - 1][0] : 'RUN-NONE';
  log({ ev: 'msg', marker, prompt });
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
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'fake failure', errors: ['fake failure'], session_id: session, total_cost_usd: 0, usage: {} });
    log({ ev: 'reply', marker, failed: true });
    if (role === 'grok') process.exit(1);
    process.exit(1); // a Claude CLI that errors out ends its process too
  }
  const text = `reply from ${marker}`;
  say(text);
  out({ type: 'assistant', message: { model: 'fake-model', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  log({ ev: 'reply', marker });
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
