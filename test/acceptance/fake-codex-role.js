// The `codex` role of test/acceptance/fake-chat-cli.js: `codex exec --json [options] [resume <thread id>] -` with the prompt on stdin.
//
// Like the real CLI (src/ai/codex.js's header):
//  - its MCP connection comes from $CODEX_HOME/config.toml ([mcp_servers.lumen] url, bearer_token_env_var) and the token from
//    that environment variable, read a moment AFTER it starts (FAKE_CODEX_READ_MS, default 250 ms);
//  - its threads live under $CODEX_HOME (sessions/<id>.jsonl): `resume <id>` only works when that file is in this $CODEX_HOME;
//  - it prints JSONL events: thread.started, turn.started, item.completed (agent_message), turn.completed {usage} or turn.failed.
// Directives in the message (the LAST RUN-<id> marker is this message's): HOLD-<name>, PARTIAL, FAIL, SHELL, as in fake-chat-cli.js.
// Log entries: { role: 'codex', ev, pid, token, session, resume, home, model, argv, config, marker, prompt, t }.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main({ argv, LOG, DIR }) {
  if (argv[0] === 'app-server') { process.stderr.write('error: unrecognized subcommand app-server\n'); process.exit(2); } // (headless only: the kept process is tested in test/codex-warm-units.js)
  const home = process.env.CODEX_HOME;
  const sessions = path.join(home, 'sessions');
  const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const ri = argv.indexOf('resume');
  const asked = ri >= 0 ? argv[ri + 1] : null;
  const mi = argv.indexOf('-m');
  const model = mi >= 0 ? argv[mi + 1] : null;
  let config = '';
  try { config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { /* none */ }
  let token = null;
  let session = asked;
  const log = (entry) => fs.appendFileSync(LOG, `${JSON.stringify({ role: 'codex', pid: process.pid, token, session, resume: Boolean(asked), home, model, argv, t: Date.now(), ...entry })}\n`);
  log({ ev: 'spawned' });
  await sleep(Number(process.env.FAKE_CODEX_READ_MS) || 250);
  token = process.env.LUMEN_MCP_TOKEN || null;
  log({ ev: 'start', config });

  let prompt = '';
  process.stdin.setEncoding('utf8');
  await new Promise((resolve) => { process.stdin.on('data', (d) => { prompt += d; }); process.stdin.on('end', resolve); });
  const all = [...prompt.matchAll(/RUN-[A-Za-z0-9]+/g)];
  const marker = all.length ? all[all.length - 1][0] : 'RUN-NONE';
  if (asked && !fs.existsSync(path.join(sessions, `${asked}.jsonl`))) {
    log({ ev: 'msg', marker, prompt, missing: true });
    process.stderr.write(`Error: no saved session found with ID ${asked}\n`);
    process.exit(1);
  }
  if (!session) {
    session = crypto.randomUUID();
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `${session}.jsonl`), '');
  }
  fs.appendFileSync(path.join(sessions, `${session}.jsonl`), `${marker}\n`);
  log({ ev: 'msg', marker, prompt });
  prompt = all.length ? prompt.slice(all[all.length - 1].index) : prompt;
  out({ type: 'thread.started', thread_id: session });
  out({ type: 'turn.started' });
  const hold = /HOLD-([A-Za-z0-9]+)/.exec(prompt)?.[1];
  if (hold) { while (!fs.existsSync(path.join(DIR, `release-${hold}`))) await sleep(40); }
  const say = (text, id = 'item_0') => out({ type: 'item.completed', item: { id, type: 'agent_message', text } });
  if (/\bPARTIAL\b/.test(prompt)) {
    say(`partial output from ${marker}`);
    setInterval(() => {}, 1000); // until killed
    return;
  }
  if (/\bSHELL\b/.test(prompt)) { // a Codex that ran a shell command anyway: Lumen must stop it
    out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
    setInterval(() => {}, 1000);
    return;
  }
  if (/\bFAIL\b/.test(prompt)) {
    out({ type: 'error', message: 'Reconnecting... 1/5' });
    out({ type: 'turn.failed', error: { message: 'fake failure' } });
    log({ ev: 'reply', marker, failed: true });
    process.exit(1);
  }
  const text = `reply from ${marker}`;
  say(text);
  out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 0 } });
  log({ ev: 'reply', marker });
  process.exit(0);
}

module.exports = { run: (o) => { main(o).catch((err) => { process.stderr.write(String(err?.stack || err)); process.exit(1); }); } };
