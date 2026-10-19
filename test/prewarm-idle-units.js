// A Claude Code CLI pre-warmed speculatively (no message yet) is released after 3 minutes, like the Codex and Grok warm pools.
const cc = require('../src/ai/claude-code');
let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
check('PREWARM_IDLE_MS is 3 minutes', cc.PREWARM_IDLE_MS === 3 * 60 * 1000, cc.PREWARM_IDLE_MS);
check('normal idle stays 10 minutes', cc.IDLE_MS === 10 * 60 * 1000, cc.IDLE_MS);
const e = new cc.ClaudeCodeEngine({ userData: require('os').tmpdir(), mcpCommand: 'x', ensureServer: async () => {}, keepAlive: false });
check('engine defaults prewarmIdleMs to the constant', e.prewarmIdleMs === cc.PREWARM_IDLE_MS, e.prewarmIdleMs);
process.exit(failures ? 1 : 0);
