// Model ids -> what the picker shows, and which of a provider's many ids are worth listing. Pure, no
// Electron: used by main.js (modelOptions), providers.js (listModels) and the unit tests.
//
//   prettyModel('gpt-5.6-mini')              'GPT-5.6 mini'
//   prettyModel('gemini-2.5-flash-lite')     'Gemini 2.5 Flash-Lite'
//   prettyModel('o3-pro-2025-06-10')         'o3 pro'  (the snapshot date goes in snapshotOf)
//   rankModels(ids, 12)                      newest families first, dated snapshots dropped when their alias is listed
(function () {
'use strict';

// A trailing release date: -2025-06-10, -20250610, -0613, -06-17 (Gemini previews), -latest is kept as a word.
const DATE = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{2}-\d{2}|\d{4})$/;
const snapshotOf = (id) => { const m = DATE.exec(String(id)); return m ? m[1] : null; };
const withoutDate = (id) => String(id).replace(DATE, '');

const WORDS = { gpt: 'GPT', gemini: 'Gemini', grok: 'Grok', claude: 'Claude', llama: 'Llama', mistral: 'Mistral', qwen: 'Qwen', deepseek: 'DeepSeek', flash: 'Flash', pro: 'Pro', lite: 'Lite', ultra: 'Ultra', nano: 'Nano', exp: 'Exp', preview: 'Preview', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', turbo: 'Turbo', vision: 'Vision', fast: 'Fast', reasoning: 'Reasoning', code: 'Code', beta: 'Beta', latest: 'Latest' };
// OpenAI's own style keeps size words lower case ("GPT-5.6 mini", "o3 pro").
const LOWER_AFTER = new Set(['gpt', 'o']);

// A readable name for a provider's model id. OpenRouter ids ("anthropic/claude-opus-5.5") drop the vendor.
function prettyModel(id) {
  let s = withoutDate(String(id || '').split('/').pop());
  if (!s) return '';
  if (/^o\d/.test(s)) { const [head, ...rest] = s.split('-'); return [head, ...rest].join(' '); } // o3, o4-mini -> "o4 mini"
  const parts = s.split('-');
  const out = [];
  let family = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i > 0 && /^(preview|exp|experimental|beta)$/i.test(p)) continue; // shown as a badge instead (badgesFor)
    if (i === 0) { family = p.toLowerCase(); out.push(WORDS[family] || p.charAt(0).toUpperCase() + p.slice(1)); continue; }
    if (/^\d+(\.\d+)*[a-z]?$/.test(p)) { out.push(family === 'gpt' && out.length === 1 ? `-${p}` : ` ${p}`); continue; } // GPT-5.6, Gemini 2.5
    const word = LOWER_AFTER.has(family) ? p.toLowerCase() : WORDS[p.toLowerCase()] || p.charAt(0).toUpperCase() + p.slice(1);
    // "flash-lite" reads as one word in Google's names.
    if (family === 'gemini' && p.toLowerCase() === 'lite' && /Flash$/.test(out[out.length - 1] || '')) { out[out.length - 1] += `-${word}`; continue; }
    out.push(` ${word}`);
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

// Small labels for a row: what the model can't do, or how settled it is.
function badgesFor(id, { chatOnly = false } = {}) {
  const b = [];
  if (chatOnly) b.push('chat only');
  if (/(^|-)(preview|exp|experimental|beta)(-|$)/.test(String(id))) b.push('preview');
  return b;
}

// The version to sort by: the first number in the id ("gpt-5.6-mini" -> 5.6, "gemini-2.5-pro" -> 2.5, "o3" -> 3).
function versionOf(id) {
  const m = /(\d+(?:\.\d+)?)/.exec(withoutDate(String(id)));
  return m ? Number(m[1]) : 0;
}
// Newest first, flagship before its variants: sort by version (higher first), then the plain name before
// "-mini"/"-pro" variants, then previews last. Dated snapshots are dropped when their alias is also listed.
function rankModels(ids, max = 12) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  const aliases = new Set(list.filter((id) => !snapshotOf(id)));
  const kept = list.filter((id) => !snapshotOf(id) || !aliases.has(withoutDate(id)));
  const preview = (id) => (/(preview|exp|beta)/.test(id) ? 1 : 0);
  kept.sort((a, b) => versionOf(b) - versionOf(a) || preview(a) - preview(b) || withoutDate(a).split('-').length - withoutDate(b).split('-').length || (snapshotOf(a) ? 1 : 0) - (snapshotOf(b) ? 1 : 0) || a.localeCompare(b));
  return kept.slice(0, max);
}

const api = { prettyModel, badgesFor, rankModels, snapshotOf, withoutDate, versionOf };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.ModelNames = api;
})();
