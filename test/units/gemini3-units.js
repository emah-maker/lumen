// Gemini 3.x: every model Lumen lists has a price, and thought signatures round-trip (providers.js toChatMessages / streamTurn).
const fs = require('fs');
const path = require('path');
const { priceTurn } = require('../../src/features/chat-usage');
const providers = require('../../src/ai/providers');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const T = (input, output, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0 });

// ---- prices: each gemini-3 id in the defaults and the model-picking code has one
{
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8');
  const ids = new Set(providers.PROVIDERS.gemini.defaults.filter((m) => /^gemini-3/.test(m)));
  for (const f of ['ai/subagents.js']) /* (agent.js names gemini-3.8-pro only as input that subagents.js maps to Flash) */ for (const m of src(f).matchAll(/gemini:(gemini-3[\w.-]*)/g)) ids.add(m[1]);
  check('prices: found the listed gemini-3 ids', ids.size >= 2, [...ids].join());
  for (const id of ids) check(`price: gemini:${id}`, priceTurn(`gemini:${id}`, T(1e6, 1e6), Date.parse('2026-10-24')) > 0, id);
  const pro = 'gemini:gemini-3.1-pro-preview';
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  check('price: Pro prompt over 200k uses the higher tier (4 + 18)', near(priceTurn(pro, T(1e6, 1e6)), 22), priceTurn(pro, T(1e6, 1e6)));
  check('price: Pro small prompt uses the base tier', near(priceTurn(pro, T(100000, 100000)), 0.2 + 1.2), '');
  check('price: Pro cached input is $0.20 per 1M under 200k', near(priceTurn(pro, T(0, 0, 100000)), 0.02), '');
  const flash = 'gemini:gemini-3.8-flash';
  check('price: 3.8 Flash doubles on 2027-01-01', near(priceTurn(flash, T(1e6, 1e6), Date.parse('2026-12-31')), 4.5) && near(priceTurn(flash, T(1e6, 1e6), Date.parse('2027-01-01')), 9), '');
}

// ---- thought signatures: a recorded multi-turn tool exchange
const sigA = 'EjQKMgG-signatureA';
const history = [
  { role: 'user', content: 'Check flight AA100 and the weather.' },
  { role: 'assistant', content: [
    { type: 'text', text: 'Checking both.' },
    { type: 'tool_use', id: 'c1', name: 'check_flight', input: { flight: 'AA100' }, thought_signature: sigA },
    { type: 'tool_use', id: 'c2', name: 'check_weather', input: { city: 'BOS' } }, // parallel: only the first is signed
  ] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'delayed' }, { type: 'tool_result', tool_use_id: 'c2', content: 'rain' }] },
];
const callsOf = (msgs) => msgs.find((m) => m.role === 'assistant').tool_calls;
{
  const calls = callsOf(providers.toChatMessages('sys', history, { provider: 'gemini', model: 'gemini-3.8-flash' }));
  check('replay: the signed call keeps its signature unchanged', calls[0].extra_content?.google?.thought_signature === sigA, JSON.stringify(calls[0]));
  check('replay: the unsigned parallel call gets nothing', calls[1].extra_content === undefined, JSON.stringify(calls[1]));
  check('replay: arguments and ids intact', calls[0].id === 'c1' && calls[0].function.arguments === '{"flight":"AA100"}', '');
}
{
  const bare = [history[0], { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'x', input: {} }] }, history[2]];
  const gem3 = callsOf(providers.toChatMessages('s', bare, { provider: 'gemini', model: 'gemini-3.1-pro-preview' }));
  check('unsigned call to Gemini 3: first call gets the documented placeholder', gem3[0].extra_content?.google?.thought_signature === 'skip_thought_signature_validator', JSON.stringify(gem3[0]));
  const gem25 = callsOf(providers.toChatMessages('s', bare, { provider: 'gemini', model: 'gemini-2.5-pro' }));
  check('unsigned call to Gemini 2.5: untouched', gem25[0].extra_content === undefined, '');
  const oai = callsOf(providers.toChatMessages('s', history, { provider: 'openai', model: 'gpt-5.6' }));
  check('other providers never see the signature', oai.every((c) => c.extra_content === undefined), JSON.stringify(oai));
  const none = callsOf(providers.toChatMessages('s', history));
  check('no target: unchanged shape', none.every((c) => c.extra_content === undefined), '');
}

// ---- streaming: the signature on a streamed tool-call delta lands on the stored block
(async () => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'check_flight', arguments: '{"flight"' }, extra_content: { google: { thought_signature: sigA } } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"AA100"}' } }, { index: 1, id: 'call_2', function: { name: 'check_weather', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
  ];
  const client = { chat: { completions: { create: async () => (async function* () { yield* chunks; })() } } };
  const res = await providers.streamTurn({ provider: 'gemini', model: 'gemini-3.8-flash', system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'check_flight', description: 'd', input_schema: { type: 'object', properties: { flight: { type: 'string' } } } }], emit: () => {}, client });
  const uses = res.content.filter((b) => b.type === 'tool_use');
  check('stream: first call keeps the signature, second has none', uses.length === 2 && uses[0].thought_signature === sigA && uses[1].thought_signature === undefined, JSON.stringify(uses));
  check('stream: arguments assembled', uses[0].input.flight === 'AA100', JSON.stringify(uses[0]));
  if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
  console.log('\nall passed');
})();
