// The Muse widget (Meta Model API), run from test/widget-units.js: config/key/question checking, the two
// request shapes (chat completions, and responses when web search is on), reading answers and sources
// (https only), readable 401/429 messages, and the connector end to end against a FAKE fetch: the key
// stays out of settings, the brief is fetched once, a typed question is answered without fetching the
// brief again and is not stored, and the rate limit and backoff apply. No network, no Electron.
const MV = require('../src/features/muse-view');
const WL = require('../src/features/widget-layout');
const { createWidgets, cleanWidget } = require('../src/features/widgets');

module.exports = async function museChecks(check) {
  // ---- config, key, question ----
  const dflt = MV.cleanConfig(undefined);
  check('muse: an empty config is the default model, the daily-brief prompt and no web search', dflt.model === 'muse-spark-1.3' && dflt.prompt === MV.DEFAULT_PROMPT && dflt.search === false, JSON.stringify(dflt));
  const cfg = MV.cleanConfig({ prompt: `  Hi\u0000 there\n${'x'.repeat(2000)}`, model: 'muse-spark-1.1', search: true });
  check('muse: the prompt is cleaned and capped, a valid model kept, search is a real boolean', cfg.prompt.startsWith('Hi there') && cfg.prompt.length === MV.MAX_PROMPT && cfg.model === 'muse-spark-1.1' && cfg.search === true, JSON.stringify(cfg).slice(0, 200));
  check('muse: a bad model name (spaces, slashes, script) falls back to the default', ['../x', 'muse spark', '<b>', '', 5, 'a'].every((m) => MV.cleanConfig({ model: m }).model === MV.DEFAULT_MODEL) && MV.cleanConfig({ search: 'yes' }).search === false, '');
  check('muse: an API key is printable, spaceless and long enough', MV.cleanKey(' abcdefghijklmnop1234 ') === 'abcdefghijklmnop1234' && !MV.cleanKey('short') && !MV.cleanKey('has space in the middle of it') && !MV.cleanKey(null) && !MV.cleanKey('a'.repeat(400)), '');
  check('muse: a question is one line, capped, and empty means none', MV.cleanQuestion('  what\nis  this\u0000? ') === 'what is this ?' && MV.cleanQuestion('q'.repeat(5000)).length === MV.MAX_QUESTION && MV.cleanQuestion('   ') === null && MV.cleanQuestion(42) === null, String(MV.cleanQuestion('  what\nis  this\u0000? ')));

  // ---- requests ----
  const brief = MV.buildRequest(MV.cleanConfig({ prompt: 'Brief me' }));
  check('muse: without search the brief is a chat completion, not streamed, with a token cap', brief.path === 'chat/completions' && brief.body.stream === false && brief.body.max_tokens === MV.MAX_TOKENS.brief && brief.body.model === 'muse-spark-1.3' && brief.body.messages.at(-1).content === 'Brief me' && !brief.body.tools, JSON.stringify(brief));
  const ask = MV.buildRequest(MV.cleanConfig({ prompt: 'Brief me' }), 'What is 2+2?');
  check('muse: a question replaces the saved prompt and has its own cap', ask.body.messages.at(-1).content === 'What is 2+2?' && ask.body.max_tokens === MV.MAX_TOKENS.ask && MV.MAX_TOKENS.ask <= 1000, JSON.stringify(ask.body).slice(0, 200));
  const grounded = MV.buildRequest(MV.cleanConfig({ prompt: 'News', search: true }));
  check('muse: with web search it uses /responses (Chat Completions has no search grounding) with the web_search tool', grounded.path === 'responses' && grounded.body.tools?.[0]?.type === 'web_search' && grounded.body.input.endsWith('News') && grounded.body.stream === false && grounded.body.max_output_tokens > 0, JSON.stringify(grounded).slice(0, 240));

  // ---- responses ----
  const chat = MV.parseResponse({ choices: [{ message: { content: '## Brief\n**One** thing\n\n\n\n- two\u0007 things' } }] });
  check('muse: a chat completion answer is read, markdown marks and control characters removed', chat && chat.answer === 'Brief\nOne thing\n\n• two things' && chat.sources.length === 0, JSON.stringify(chat));
  const grounded2 = MV.parseResponse({
    output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: 'It rained.', annotations: [
      { type: 'url_citation', url: 'https://example.com/a', title: 'Example A', start_index: 0, end_index: 4 },
      { type: 'url_citation', url: 'https://example.com/a', title: 'Dupe' },
      { type: 'url_citation', url: 'http://insecure.example/b', title: 'Plain http' },
      { type: 'url_citation', url: 'javascript:alert(1)', title: 'Script' },
      { type: 'url_citation', url: 'https://user:pw@example.com/c', title: 'Credentials' },
      { type: 'url_citation', url: 'https://www.example.org/d', title: '' },
    ] }] }],
  });
  check('muse: a grounded answer keeps only https sources, once each, with a host as the missing title', grounded2 && grounded2.answer === 'It rained.' && JSON.stringify(grounded2.sources) === JSON.stringify([{ url: 'https://example.com/a', title: 'Example A' }, { url: 'https://www.example.org/d', title: 'example.org' }]), JSON.stringify(grounded2));
  const many = MV.parseResponse({ output: [{ type: 'message', content: [{ text: 'x', annotations: Array.from({ length: 30 }, (_, i) => ({ type: 'url_citation', url: `https://e.com/${i}`, title: `t${i}` })) }] }] });
  check('muse: at most a handful of sources', many.sources.length === MV.MAX_SOURCES, many.sources.length);
  const long = MV.parseResponse({ choices: [{ message: { content: 'y'.repeat(50000) } }] });
  check('muse: an over-long answer is cut', long.answer.length === MV.MAX_ANSWER, long.answer.length);
  check('muse: nothing readable is null, never a throw', [null, 'x', {}, { choices: [] }, { choices: [{ message: { content: '' } }] }, { output: [{ type: 'message', content: 5 }] }].every((v) => MV.parseResponse(v) === null), '');
  check('muse: 401 and 429 read as sentences, and the server\'s message is bounded', /API key/.test(MV.errorMessage(401, '')) && /too many/i.test(MV.errorMessage(429, '')) && /rejected/.test(MV.errorMessage(400, JSON.stringify({ error: { message: 'bad param' } }))) && MV.errorMessage(400, JSON.stringify({ error: { message: 'z'.repeat(999) } })).length < 220 && !/<|undefined/.test(MV.errorMessage(500, '<html>')), MV.errorMessage(400, '{}'));

  // ---- layout ----
  check('muse: default size 4x4, and the widget config is cleaned on read', WL.DEFAULT_SIZE.muse.w === 4 && WL.DEFAULT_SIZE.muse.h === 4 && cleanWidget({ id: 'wmuse01', type: 'muse', muse: { model: 'x y' } }).muse.model === MV.DEFAULT_MODEL && cleanWidget({ id: 'wmuse01', type: 'muse' }).muse.prompt === MV.DEFAULT_PROMPT, '');

  // ---- the connector against a fake fetch ----
  const KEY = 'mk_test_0123456789abcdef';
  let clock = 1e12;
  let settings = { homeWidgets: [] };
  const secrets = {};
  const calls = [];
  let reply = () => ({ status: 200, json: { choices: [{ message: { content: 'Today: things happened.' } }] } });
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    const r = reply(url, opts);
    return new Response(typeof r.json === 'string' ? r.json : JSON.stringify(r.json), { status: r.status, headers: r.headers || {} });
  };
  const widgets = createWidgets({
    readSettings: () => settings, writeSettings: (s) => { settings = JSON.parse(JSON.stringify(s)); },
    fetch: fakeFetch, getSecret: (n) => secrets[n] || null, setSecret: (n, v) => { if (v) secrets[n] = v; else delete secrets[n]; },
    onUpdate() {}, endpoints: () => ({}), now: () => clock,
  });
  const idle = async () => { await widgets.refreshAll(); await new Promise((r) => setTimeout(r, 0)); await widgets.refreshAll(); };

  let threw = '';
  try { await widgets.save({ type: 'muse', token: 'short' }); } catch (e) { threw = e.message; }
  check('muse connector: a malformed key is refused before anything is stored', /Meta API key/.test(threw) && !secrets.muse && calls.length === 0, threw);
  threw = '';
  try { await widgets.save({ type: 'muse' }); } catch (e) { threw = e.message; }
  check('muse connector: no key at all is refused', /Paste your Meta API key/.test(threw), threw);

  const saved = await widgets.save({ type: 'muse', token: KEY, muse: { prompt: 'Brief me', search: false } });
  await idle();
  check('muse connector: the key is stored as a secret, never in settings.json or the widget list', secrets.muse === KEY && !JSON.stringify(settings).includes(KEY) && !JSON.stringify(widgets.forPage()).includes(KEY) && !JSON.stringify(widgets.state()).includes(KEY) && widgets.state().secrets.muse === true, JSON.stringify(settings).slice(0, 200));
  check('muse connector: saving asks nothing of Meta by itself except the one brief', calls.length === 1 && calls[0].url === 'https://api.meta.ai/v1/chat/completions' && calls[0].method === 'POST' && calls[0].headers.Authorization === `Bearer ${KEY}` && calls[0].body.stream === false && calls[0].body.max_tokens === MV.MAX_TOKENS.brief, JSON.stringify(calls.map((c) => [c.url, c.body?.max_tokens])));
  let card = widgets.forPage()[0];
  check('muse connector: the card gets {answer, sources} as plain data, 3x4 (side-area cap), titled Muse', card.type === 'muse' && card.title === 'Muse' && card.data.answer === 'Today: things happened.' && Array.isArray(card.data.sources) && card.layout.w === 3 && card.layout.h === 4, JSON.stringify(card).slice(0, 300));

  clock += 60e3;
  await widgets.forPage();
  await idle();
  check('muse connector: fresh data is not fetched again for hours (a call costs money)', calls.length === 1, calls.length);
  clock += 5 * 3600e3;
  widgets.forPage(); await idle();
  check('muse connector: still fresh at 5 hours', calls.length === 1, calls.length);
  clock += 2 * 3600e3;
  widgets.forPage(); await idle();
  check('muse connector: fetched again after the 6 hour ttl', calls.length === 2, calls.length);

  // a forced refresh respects MIN_REFRESH
  await widgets.act({ id: saved.widget.id, do: 'refresh' });
  check('muse connector: Refresh right after a fetch does nothing (MIN_REFRESH)', calls.length === 2, calls.length);
  clock += 20e3;
  await widgets.act({ id: saved.widget.id, do: 'refresh' });
  check('muse connector: Refresh a little later does fetch', calls.length === 3, calls.length);

  // ---- ask ----
  const id = saved.widget.id;
  const url = (q) => `https://lumen.test/newtab?widget=${id}&do=ask&text=${encodeURIComponent(q)}`;
  check('muse ask: the page action needs a question, and it is capped', widgets.actionFrom(`https://lumen.test/newtab?widget=${id}&do=ask`)?.invalid === true && widgets.actionFrom(url('   '))?.invalid === true && widgets.actionFrom(url('q'.repeat(3000))).text.length === MV.MAX_QUESTION && widgets.actionFrom(url('hi')).do === 'ask', '');
  reply = () => ({ status: 200, json: { choices: [{ message: { content: 'Four.' } }] } });
  clock += 20e3;
  const before = calls.length;
  const ok = await widgets.act(widgets.actionFrom(url('What is 2+2?')));
  card = widgets.forPage()[0];
  check('muse ask: one question is one call, answered on the card', ok === true && calls.length === before + 1 && calls.at(-1).body.messages.at(-1).content === 'What is 2+2?' && calls.at(-1).body.max_tokens === MV.MAX_TOKENS.ask && card.data.asked?.answer === 'Four.' && card.data.asked.question === 'What is 2+2?' && card.data.answer === 'Today: things happened.', JSON.stringify(card.data).slice(0, 300));
  await idle();
  check('muse ask: the brief is not fetched again after a question', calls.length === before + 1, calls.length - before);
  check('muse ask: no history is stored (settings hold only the widget list and the key stays out)', !JSON.stringify(settings).includes('2+2') && !JSON.stringify(settings).includes('Four'), JSON.stringify(settings).slice(0, 200));
  await widgets.act(widgets.actionFrom(url('again?')));
  card = widgets.forPage()[0];
  check('muse ask: a second question straight away is held back with a notice, no call', calls.length === before + 1 && /Wait/.test(card.data.notice || ''), card.data.notice);

  // ---- errors ----
  clock += 60e3;
  reply = () => ({ status: 401, json: { error: { message: 'Invalid key', type: 'invalid_request_error' } } });
  await widgets.act(widgets.actionFrom(url('hello?')));
  card = widgets.forPage()[0];
  check('muse ask: a refused key reads as a sentence on the card and drops the old asked answer', /API key/.test(card.data.notice || '') && !card.data.asked && !/Invalid key/.test(card.data.notice), card.data.notice);
  reply = () => ({ status: 200, json: { choices: [{ message: { content: 'ok' } }] } });
  clock += 60e3;
  const ok2 = await widgets.act(widgets.actionFrom(url('fine now?')));
  card = widgets.forPage()[0];
  check('muse ask: the next good answer clears the notice', ok2 === true && card.data.asked?.answer === 'ok' && !card.data.notice, JSON.stringify(card.data).slice(0, 200));

  // brief errors: 401 then 429 (backoff, no second request)
  const w2 = createWidgets({ readSettings: () => settings, writeSettings: (s) => { settings = JSON.parse(JSON.stringify(s)); }, fetch: fakeFetch, getSecret: (n) => secrets[n] || null, setSecret: () => {}, onUpdate() {}, endpoints: () => ({}), now: () => clock });
  reply = () => ({ status: 401, json: { error: { message: 'no' } } });
  w2.flush();
  clock += 8 * 3600e3;
  w2.forPage();
  await w2.refreshAll();
  let p = w2.forPage()[0];
  check('muse brief: a 401 is a readable error on the card', /API key/.test(p.error || p.warning || ''), JSON.stringify([p.error, p.warning]));
  reply = () => ({ status: 429, json: { error: { message: 'slow down' } }, headers: { 'retry-after': '30' } });
  clock += 10 * 60e3;
  await w2.act({ id, do: 'refresh' });
  p = w2.forPage()[0];
  const n429 = calls.length;
  check('muse brief: a 429 is a readable error', /too many|limit/i.test(p.error || p.warning || ''), JSON.stringify([p.error, p.warning]));
  clock += 20e3;
  await w2.act({ id, do: 'refresh' });
  check('muse brief: after a 429 no further request goes out until the backoff ends', calls.length === n429, calls.length - n429);

  // ---- web search on ----
  reply = () => ({ status: 200, json: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Sourced.', annotations: [{ type: 'url_citation', url: 'https://example.com/s', title: 'S' }] }] }] } });
  clock += 10 * 60e3;
  const g = await widgets.save({ type: 'muse', muse: { prompt: 'News', search: true } }, id); // no key typed: the stored one is kept
  await idle();
  const last = calls.at(-1);
  card = widgets.forPage().find((c) => c.id === g.widget.id);
  check('muse connector: web search goes to /responses with the tool and returns https sources', last.url === 'https://api.meta.ai/v1/responses' && last.body.tools?.[0]?.type === 'web_search' && card.data.answer === 'Sourced.' && card.data.sources[0].url === 'https://example.com/s' && secrets.muse === KEY, JSON.stringify([last.url, card.data]).slice(0, 300));

  // ---- removal ----
  widgets.remove(id);
  check('muse connector: removing the last Muse widget removes the key', !secrets.muse && widgets.list().length === 0, JSON.stringify(secrets));
};
