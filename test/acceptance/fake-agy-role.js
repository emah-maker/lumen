// The `agy` (Antigravity) role of test/acceptance/fake-chat-cli.js: one `-p` message per process, agy's stream-json events.
//
// Like the real CLI (src/ai/antigravity.js's header):
//  - its MCP connection (Lumen's token) is read from $HOME/.gemini/config/mcp_config.json shortly AFTER it starts
//    (FAKE_AGY_READ_MS, default 250 ms), so two runs that shared one config file would pick up each other's token;
//  - its conversations live under $HOME (.gemini/antigravity-cli/conversations/<id>.db): `--conversation <id>` resumes only
//    when that file is in this $HOME, else the run fails with "conversation not found".
// Directives in the message (the LAST RUN-<id> marker is this message's): HOLD-<name>, PARTIAL, FAIL, as in fake-chat-cli.js.
// Log entries: { role: 'agy', ev, pid, token, session, resume, home, marker, prompt, t }.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main({ argv, flag, LOG, DIR }) {
  const home = process.env.HOME || process.env.USERPROFILE;
  const gemini = path.join(home, '.gemini');
  const convDir = path.join(gemini, 'antigravity-cli', 'conversations');
  const asked = flag('--conversation') || null;
  const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  let token = null;
  let session = asked;
  const log = (entry) => fs.appendFileSync(LOG, `${JSON.stringify({ role: 'agy', pid: process.pid, token, session, resume: Boolean(asked), home, t: Date.now(), ...entry })}\n`);
  log({ ev: 'spawned' });
  await sleep(Number(process.env.FAKE_AGY_READ_MS) || 250);
  try {
    const lumen = JSON.parse(fs.readFileSync(path.join(gemini, 'config', 'mcp_config.json'), 'utf8')).mcpServers.lumen;
    token = lumen.headers?.Authorization ? lumen.headers.Authorization.replace(/^Bearer\s+/, '') : lumen.env?.LUMEN_ENGINE || null;
  } catch { token = null; }
  log({ ev: 'start' });

  let prompt = flag('-p') || '';
  const all = [...prompt.matchAll(/RUN-[A-Za-z0-9]+/g)];
  const marker = all.length ? all[all.length - 1][0] : 'RUN-NONE';
  if (asked && !fs.existsSync(path.join(convDir, `${asked}.db`))) {
    log({ ev: 'msg', marker, prompt, missing: true });
    out({ event: 'result', result: { status: 'ERROR', error: `conversation not found: ${asked}` } });
    process.exit(1);
  }
  if (!session) {
    session = `agyconv-${crypto.randomBytes(6).toString('hex')}`;
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(path.join(convDir, `${session}.db`), '');
  }
  fs.appendFileSync(path.join(convDir, `${session}.db`), `${marker}\n`); // the conversation's turns, kept in this home
  log({ ev: 'msg', marker, prompt });
  prompt = all.length ? prompt.slice(all[all.length - 1].index) : prompt;
  out({ event: 'init', conversation_id: session, init: { cwd: process.cwd(), model: 'fake-agy-model' } });
  const hold = /HOLD-([A-Za-z0-9]+)/.exec(prompt)?.[1];
  if (hold) { while (!fs.existsSync(path.join(DIR, `release-${hold}`))) await sleep(40); }
  const say = (text, i = 1) => out({ event: 'step_update', step_update: { step_index: i, state: 'ACTIVE', step_type: 'agent_response', text_delta: text } });
  if (/\bPARTIAL\b/.test(prompt)) {
    say(`partial output from ${marker}`);
    setInterval(() => {}, 1000); // until killed
    return;
  }
  if (/\bFAIL\b/.test(prompt)) {
    out({ event: 'result', result: { conversation_id: session, status: 'ERROR', error: 'fake failure' } });
    log({ ev: 'reply', marker, failed: true });
    process.exit(1);
  }
  const text = `reply from ${marker}`;
  say(text);
  out({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: text, usage: { input_tokens: 1, output_tokens: 1 } } });
  log({ ev: 'reply', marker });
  process.exit(0);
}

module.exports = { run: (o) => { main(o).catch((err) => { process.stderr.write(String(err?.stack || err)); process.exit(1); }); } };
