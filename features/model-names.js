// Model ids -> what the picker shows, and which of a provider's many ids are worth listing. Pure, no
// Electron: used by main.js (modelOptions), providers.js (listModels) and the unit tests.
//
//   prettyModel('gpt-5.6-mini')              'GPT-5.6 mini'
//   prettyModel('gemini-2.5-flash-lite')     'Gemini 2.5 Flash-Lite'
//   prettyModel('grok-4-1-fast-reasoning')   'Grok 4.1 Fast Reasoning'
//   prettyModel('o3-pro-2025-06-10')         'o3 pro'  (the snapshot date: snapshotOf)
//   rankModels(ids, 12)                      each family's newest kept (GPT and o-series alike), dated duplicates dropped
(function () {
'use strict';

// A trailing release stamp: -2025-06-10, -20250610, -09-2025, -06-17 (Gemini previews), -0613, -001 (a revision).
const DATE = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{2}-\d{4}|\d{2}-\d{2}|\d{4}|0\d\d)$/;
const snapshotOf = (id) => { const m = DATE.exec(String(id)); return m ? m[1] : null; };
const withoutDate = (id) => String(id).replace(DATE, '');

const WORDS = { oss: 'OSS', glm: 'GLM', chatgpt: 'ChatGPT', it: 'IT', er: 'ER', gpt: 'GPT', gemini: 'Gemini', grok: 'Grok', claude: 'Claude', llama: 'Llama', mistral: 'Mistral', qwen: 'Qwen', deepseek: 'DeepSeek', flash: 'Flash', pro: 'Pro', lite: 'Lite', ultra: 'Ultra', nano: 'Nano', exp: 'Experimental', preview: 'Preview', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', turbo: 'Turbo', vision: 'Vision', fast: 'Fast', reasoning: 'Reasoning', code: 'Code', beta: 'Beta', latest: 'Latest', mini: 'Mini' };
// OpenAI's own style keeps size words lower case ("GPT-5.6 mini", "o3 pro").
const LOWER_AFTER = new Set(['gpt', 'o']);
const SETTLEDNESS = /^(preview|exp|experimental|beta)$/i;

function nameFrom(s, { keepStatus = false } = {}) {
  if (/^o\d/.test(s)) return s.split('-').filter((p, i) => keepStatus || i === 0 || !SETTLEDNESS.test(p)).join(' '); // o3, o4-mini -> "o4 mini"
  const parts = s.split('-');
  // "4-1" after the family is a version written with a dash (grok-4-1-fast): 4.1.
  if (/^\d$/.test(parts[1] || '') && /^\d$/.test(parts[2] || '')) parts.splice(1, 2, `${parts[1]}.${parts[2]}`);
  const out = [];
  let family = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i > 0 && !keepStatus && SETTLEDNESS.test(p)) continue; // shown as a badge instead (badgesFor)
    if (p.toLowerCase() === 'non' && parts[i + 1]) { out.push(` Non-${WORDS[parts[i + 1].toLowerCase()] || parts[i + 1].charAt(0).toUpperCase() + parts[i + 1].slice(1)}`); i++; continue; } // "Non-Reasoning"
    if (family === 'gpt' && i === 1 && p.toLowerCase() === 'oss') { out.push('-OSS'); continue; } // "GPT-OSS"
    if (i === 0) { family = p.toLowerCase(); out.push(WORDS[family] || p.charAt(0).toUpperCase() + p.slice(1)); continue; }
    if (/^[a-z]?\d+[bkm]$/i.test(p)) { out.push(` ${p.toUpperCase()}`); continue; } // a size: "120B", "27B", "A22B"
    if (/^\d+(\.\d+)*[a-z]?$/.test(p)) { out.push(family === 'gpt' && out.length === 1 ? `-${p}` : ` ${p}`); continue; } // GPT-5.6, Gemini 2.5
    // Sizes read as sizes ("120B", "27B", "A22B"); OpenAI keeps its lower-case words.
    const sized = /^[a-z]?\d+[bkm]$/i.test(p) ? p.toUpperCase() : null;
    const word = sized || (LOWER_AFTER.has(family) && !WORDS[p.toLowerCase()]?.match(/^[A-Z]{2,}$/) ? p.toLowerCase() : WORDS[p.toLowerCase()] || p.charAt(0).toUpperCase() + p.slice(1));
    // "flash-lite" reads as one word in Google's names.
    if (family === 'gemini' && p.toLowerCase() === 'lite' && /Flash$/.test(out[out.length - 1] || '')) { out[out.length - 1] += `-${word}`; continue; }
    out.push(` ${word}`);
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}
// A readable name for a provider's model id. OpenRouter ids ("anthropic/claude-opus-5.5") drop the vendor.
function prettyModel(id) {
  const raw = String(id || '').split('/').pop();
  if (!raw) return '';
  const name = nameFrom(withoutDate(raw));
  // Nothing but the family left (gemini-exp-1206): the stamp and status are what tell it apart, so they stay.
  return name.split(' ').length > 1 || /\d/.test(name) ? name : nameFrom(raw, { keepStatus: true });
}

// Small labels for a row: what the model can't do, or how settled it is.
function badgesFor(id, { chatOnly = false } = {}) {
  const b = [];
  if (chatOnly) b.push('chat only');
  if (/(^|-)(preview|exp|experimental|beta)(-|$)/.test(String(id))) b.push('preview');
  return b;
}

// The version to sort by: the first number in the id ("gpt-5.6-mini" -> 5.6, "gemini-2.5-pro" -> 2.5, "o3" -> 3,
// "grok-4-1" -> 4.1).
function versionOf(id) {
  const s = withoutDate(String(id).split('/').pop()).replace(/^([a-z]+-)(\d)-(\d)(?=-|$)/, '$1$2.$3');
  // A version is small ("5.6", "2.5", "4"); a size like "120b" is not one.
  const m = /(?:^|[^\d.])(\d{1,2}(?:\.\d+)?)(?![\d]|[bkm](?:-|$))/i.exec(s);
  return m ? Number(m[1]) : 0;
}
// The family a model belongs to, for ranking: "gpt", "o" (o1, o3, o4-mini), "gemini", "grok", ...
const familyOf = (id) => { const s = String(id).split('/').pop().toLowerCase(); return /^o\d/.test(s) ? 'o' : (/^[a-z]+/.exec(s) || [''])[0]; };
// Within one version: the flagship tiers before the small ones (Pro before Flash, the base before mini).
const TIERS = [[/(^|-)(ultra|opus)(-|$)/, 0], [/(^|-)pro(-|$)/, 1], [/(^|-)(flash|fast|sonnet|turbo)(-|$)/, 3], [/(^|-)(mini|lite|haiku|small)(-|$)/, 4], [/(^|-)nano(-|$)/, 5]];
const tierOf = (id) => { const s = withoutDate(String(id)); for (const [re, t] of TIERS) if (re.test(s)) return t; return 2; };
const statusOf = (id) => (/(preview|exp|beta)/.test(id) ? 1 : 0);
const newestFirst = (a, b) => versionOf(b) - versionOf(a) || statusOf(a) - statusOf(b) || tierOf(a) - tierOf(b) || withoutDate(a).split('-').length - withoutDate(b).split('-').length || a.localeCompare(b);

// The ids worth listing, at most `max`: dated snapshots dropped when their alias is there, then each family's
// newest taken in turn (so a long o-series list can't crowd out GPT, nor GPT the o-series), listed family by
// family, newest family first.
function rankModels(ids, max = 12) {
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  const aliases = new Set(list.filter((id) => !snapshotOf(id)));
  // A dated snapshot goes when its alias is listed, as does a dated preview of it ("…-flash-preview-09-2025").
  const baseOf = (id) => withoutDate(id).replace(/-(preview|exp)$/, '');
  const kept = list.filter((id) => !snapshotOf(id) || (!aliases.has(withoutDate(id)) && !aliases.has(baseOf(id))));
  const families = new Map();
  for (const id of kept.sort(newestFirst)) { const f = familyOf(id); if (!families.has(f)) families.set(f, []); families.get(f).push(id); }
  const order = [...families.keys()]; // already newest family first (sorted above)
  const picked = new Set();
  for (let round = 0; picked.size < max && order.some((f) => families.get(f).length > round); round++) {
    for (const f of order) { const id = families.get(f)[round]; if (id && picked.size < max) picked.add(id); }
  }
  return order.flatMap((f) => families.get(f).filter((id) => picked.has(id)));
}

const api = { prettyModel, badgesFor, rankModels, snapshotOf, withoutDate, versionOf, familyOf };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.ModelNames = api;
})();
