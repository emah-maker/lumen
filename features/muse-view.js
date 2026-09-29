// The Muse widget's pure logic (Meta's Muse model through the Meta Model API): config checking, the
// request bodies, reading the answer and its sources out of a response, and readable error messages.
// No Electron, no network: features/widgets.js does the request, test/widget-units.js runs this.
//
// API facts (dev.meta.ai/docs, read 2026-09-29): base https://api.meta.ai/v1, bearer key, OpenAI-style
// POST /chat/completions; models muse-spark-1.3 (recommended), 1.2, 1.1; errors { error: { message,
// type, param, code } }; 401 = bad key, 429 = rate limit. Search grounding is NOT available on Chat
// Completions, only on POST /responses with tools: [{ type: 'web_search' }], whose answer carries
// output[].content[].annotations of type url_citation { url, title }. So: no web search -> chat
// completions, web search on -> responses. Unverified: the exact max-token parameter name on
// /responses (max_output_tokens is assumed) and the rate limits and terms of use.
'use strict';

const DEFAULT_MODEL = 'muse-spark-1.3';
const DEFAULT_PROMPT = 'Give me a short daily brief: three or four bullet points on what matters today in technology and world news, one line each.';
const MAX_PROMPT = 1000;
const MAX_QUESTION = 500;
const MAX_ANSWER = 6000;
const MAX_SOURCES = 8;
const MAX_TOKENS = { brief: 700, ask: 900 }; // output cap per call: the cost ceiling ($4.25 per million tokens out)
const MAX_BODY = 262144; // bytes read from a response
const SYSTEM = 'You are the Muse card on a browser\'s new-tab page. Answer briefly and plainly. Plain text only: no markdown, no headings, no tables.';

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/i;
const KEY_SHAPE = /^[\x21-\x7e]{16,300}$/; // printable, no spaces; Meta's key format is not documented

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, max) : '');

// Stored or typed config -> checked fields. Always returns something usable.
function cleanConfig(m) {
  const i = m && typeof m === 'object' ? m : {};
  const model = typeof i.model === 'string' && MODEL_ID.test(i.model.trim()) ? i.model.trim() : DEFAULT_MODEL;
  const prompt = clean(i.prompt, MAX_PROMPT) || DEFAULT_PROMPT;
  return { prompt, model, search: i.search === true };
}

// The API key as typed, or null when it can't be one.
function cleanKey(v) {
  const k = typeof v === 'string' ? v.trim() : '';
  return KEY_SHAPE.test(k) ? k : null;
}

// A question typed on the card: one line, limited, or null when empty.
function cleanQuestion(v) {
  const q = clean(typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ') : '', MAX_QUESTION);
  return q || null;
}

// The request for a brief (question omitted) or a typed question. { path, body }.
function buildRequest(cfg, question) {
  const kind = question ? 'ask' : 'brief';
  const user = question || cfg.prompt;
  if (cfg.search) {
    return { path: 'responses', body: { model: cfg.model, input: `${SYSTEM}\n\n${user}`, tools: [{ type: 'web_search' }], max_output_tokens: MAX_TOKENS[kind], stream: false } };
  }
  return { path: 'chat/completions', body: { model: cfg.model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], max_tokens: MAX_TOKENS[kind], stream: false } };
}

// Text for a card: control characters out, light markdown out, paragraphs kept, limited.
function cleanAnswer(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^[ \t]*[*-][ \t]+/gm, '• ')
    .replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_ANSWER);
}

// An https address without credentials, spaces or quotes, or null.
function httpsUrl(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!/^https:\/\//i.test(t) || t.length > 2000 || /[\s"'<>\\]/.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'https:' && u.hostname && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

function addSource(out, seen, url, title) {
  const href = httpsUrl(url);
  if (!href || seen.has(href) || out.length >= MAX_SOURCES) return;
  seen.add(href);
  let host = '';
  try { host = new URL(href).hostname.replace(/^www\./, ''); } catch { /* checked above */ }
  out.push({ url: href, title: clean(title, 120) || host });
}

// A response (either API) -> { answer, sources } or null when there is no text in it.
function parseResponse(json) {
  if (!json || typeof json !== 'object') return null;
  const texts = [];
  const sources = [];
  const seen = new Set();
  const take = (part) => {
    if (typeof part === 'string') { texts.push(part); return; }
    if (!part || typeof part !== 'object') return;
    if (typeof part.text === 'string') texts.push(part.text);
    for (const a of Array.isArray(part.annotations) ? part.annotations : []) {
      if (!a || typeof a !== 'object') continue;
      const c = a.url_citation && typeof a.url_citation === 'object' ? a.url_citation : a; // both shapes
      if (a.type === 'url_citation' || c.url) addSource(sources, seen, c.url, c.title);
    }
  };
  // Responses API: output[] -> message -> content[] (output_text with annotations).
  for (const item of Array.isArray(json.output) ? json.output : []) {
    if (!item || item.type !== 'message') continue;
    for (const part of Array.isArray(item.content) ? item.content : []) take(part);
  }
  if (!texts.length && typeof json.output_text === 'string') texts.push(json.output_text);
  // Chat Completions: choices[0].message.content (a string, or parts), with optional annotations.
  const msg = Array.isArray(json.choices) ? json.choices[0]?.message : null;
  if (!texts.length && msg && typeof msg === 'object') {
    if (Array.isArray(msg.content)) msg.content.forEach(take); else take(msg.content);
    take({ annotations: msg.annotations });
  }
  for (const c of Array.isArray(json.citations) ? json.citations : []) addSource(sources, seen, typeof c === 'string' ? c : c?.url, typeof c === 'string' ? '' : c?.title);
  const answer = cleanAnswer(texts.join('\n\n'));
  return answer ? { answer, sources } : null;
}

// A failed response -> a sentence for the card. `body` is the raw text; Meta uses { error: { message } }.
function errorMessage(status, body) {
  let detail = '';
  try {
    const e = JSON.parse(body)?.error;
    detail = clean(typeof e === 'string' ? e : e?.message, 140);
  } catch { /* not JSON */ }
  if (status === 401 || status === 403) return 'Meta refused the API key. Check or replace it in Settings (keys come from dev.meta.ai).';
  if (status === 429) return 'Meta says you have made too many requests, or hit your plan\'s limit. Lumen will try again later.';
  if (status === 402) return 'Meta says the account is out of credit. Check billing at dev.meta.ai.';
  if (status === 404) return 'Meta doesn\'t know that model. Check the model name in Settings.';
  if (status === 400 || status === 422) return `Meta rejected the request${detail ? `: ${detail}` : '.'}`;
  if (status >= 500) return `Meta's service had a problem (${status}). Try again later.`;
  return `Meta answered ${status}${detail ? `: ${detail}` : '.'}`;
}

module.exports = {
  DEFAULT_MODEL, DEFAULT_PROMPT, MAX_PROMPT, MAX_QUESTION, MAX_ANSWER, MAX_SOURCES, MAX_TOKENS, MAX_BODY,
  cleanConfig, cleanKey, cleanQuestion, cleanAnswer, buildRequest, parseResponse, errorMessage, httpsUrl,
};
