// Prints the size of the request the sidebar sends for a fixed fake conversation (no network, no
// Electron window): node scripts/measure-request.js
const { requestFor, DEFAULT_MODEL } = require('../src/ai/agent');

const page = 'Example page text. '.repeat(200);
const messages = [
  { role: 'user', content: 'Find the cheapest option on this page and add it to the cart.' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_page', input: { mode: 'compact' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: page }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Adding it.' }, { type: 'tool_use', id: 't2', name: 'click', input: { text: 'Add to cart' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Clicked element 4.' }] },
];
messages.settings = { model: DEFAULT_MODEL };
const params = requestFor(messages.settings, messages);
const size = (v) => JSON.stringify(v).length;
const rows = { system: size(params.system), tools: size(params.tools), messages: size(params.messages), total: size(params) };
const marks = JSON.stringify(params).match(/"cache_control"/g)?.length || 0;
console.log(JSON.stringify({ ...rows, estTokens: Math.round(rows.total / 4), stablePrefixTokens: Math.round((rows.system + rows.tools) / 4), cacheBreakpoints: marks, toolCount: params.tools.length, maxTokens: params.max_tokens }));
