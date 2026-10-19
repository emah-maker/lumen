// Shared by test/chat-tab-speed.js and scripts/measure-chat-tabs.js: fills a throwaway profile with a realistic chat history
// (long messages, Markdown, code blocks, a mermaid diagram), written through the app's own chat store and OS-keychain encryption.
// Call seed(profile, opts) with no app running; it starts a hidden Electron on that profile, saves the chats and quits.
const { _electron: electron } = require('playwright-core');
const path = require('path');

const root = path.join(__dirname, '..');

// One reply of about `kb` KB, rotating through the kinds of content real chats hold.
function reply(n, kb) {
  const para = `Paragraph ${n}: the **trade-off** here is between latency and throughput, and it shows up in *every* layer of the stack. A cache helps when reads dominate, a queue helps when writes burst, and neither helps when the work itself is slow. See [the docs](https://example.com/docs/${n}) and \`config.limit\` for the knobs. `;
  const code = '```js\nasync function load(ids) {\n  const out = new Map();\n  for (const id of ids) {\n    const row = await db.get(`item:${id}`);\n    if (row && row.ttl > Date.now()) out.set(id, row.value);\n  }\n  return out; // O(n) round trips: batch them\n}\n```\n';
  const py = '```python\ndef fib(n: int) -> int:\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n```\n';
  const table = '| Option | Latency | Cost |\n|---|---|---|\n| Cache | 2 ms | low |\n| Queue | 40 ms | medium |\n| Batch | 15 ms | low |\n\n';
  const list = '- first point, with `inline code`\n- second point with **bold** text\n  - a nested item\n- third point\n\n1. step one\n2. step two\n3. step three\n\n';
  const mermaid = '```mermaid\ngraph TD\n  A[Client] --> B{Cache hit?}\n  B -- yes --> C[Return]\n  B -- no --> D[Database]\n  D --> E[Fill cache]\n  E --> C\n```\n\n';
  const math = 'The cost is $O(n \\log n)$ and the bound is $$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n\n';
  let text = `## Answer ${n}\n\n`;
  const parts = [para.repeat(3) + '\n\n', code, list, table, py, para.repeat(2) + '\n\n', math];
  if (n % 5 === 0) parts.splice(2, 0, mermaid);
  let i = 0;
  while (text.length < kb * 1024) text += parts[i++ % parts.length];
  return text;
}

// A saved chat of `exchanges` question/answer pairs.
function snapshot(c, exchanges, kb) {
  const messages = [];
  for (let n = 0; n < exchanges; n++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `Question ${c}.${n}: ${'can you walk me through how this works and why the second case behaves differently from the first? '.repeat(1 + (n % 4))}` }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: reply(c * 1000 + n, kb) }] });
  }
  return { settings: { model: 'claude-opus-5' }, messages };
}

// opts: { chats = 50, big = 60, kb = 3, scale = 1 } : `chats` saved chats of 2 to 12 exchanges (times `scale`), and the newest has `big` exchanges (the long chat).
// Returns { ids (newest first), bigId }.
async function seed(profile, { chats = 50, big = 60, kb = 3, scale = 1 } = {}) {
  const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    await (await app.firstWindow()).waitForSelector('.tab');
    const snaps = [];
    for (let c = 0; c < chats; c++) snaps.push(snapshot(c, c === 0 ? big : (2 + (c % 11)) * scale, kb));
    return await app.evaluate(({ app: electronApp, safeStorage }, { snaps: list, dir }) => {
      const { createChatStore } = process.mainModule.require(`${dir}/src/features/chat-store.js`);
      const path = process.mainModule.require('path');
      const store = createChatStore({
        dir: path.join(electronApp.getPath('userData'), 'chats'),
        encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
        decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
        available: () => safeStorage.isEncryptionAvailable(),
        limit: 500,
      });
      const ids = [];
      // oldest first, so the first snapshot (the big chat) ends up newest
      for (let i = list.length - 1; i >= 0; i--) { const id = store.newId(); store.save(id, list[i]); ids.unshift(id); }
      store.setCurrent(ids[0]);
      return { ids, bigId: ids[0] };
    }, { snaps, dir: root.split(path.sep).join('/') });
  } finally {
    await app.close().catch(() => {});
  }
}

module.exports = { seed };
