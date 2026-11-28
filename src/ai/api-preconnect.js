// [api preconnect] The user focused or typed in the composer (IPC agent:prewarm): the chat's API model will be asked soon, so a
// connection to its provider is opened now (Chromium's session.preconnect: DNS, TCP and TLS, no request is sent). The first
// request after a quiet spell then skips that setup (~100-300 ms, more on a slow or far network). The AI SDKs fetch through
// Chromium's network stack (browser/net-fetch.js), so the socket opened here is the one they use. CLI engines have their own
// warm-ups (Claude Code's kept process, Codex, Grok Build, Antigravity); a model on this computer needs none.
const DEFAULT_ORIGINS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  xai: 'https://api.x.ai',
  gemini: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai',
};
const AGAIN_MS = 8000; // a pre-connected socket nobody uses is closed after ~10 s: a later poke opens it again, a sooner one is skipped
const CLI = /^(claudecode|grokbuild|antigravity|codex):/;

// The provider origin a chat's model is sent to, or null (a CLI engine, a local model, nothing picked).
// env: ANTHROPIC_BASE_URL / OPENAI_BASE_URL move those SDKs' requests, so the warm-up goes where they go.
function originFor(model, env = process.env) {
  const id = String(model || '');
  if (!id || CLI.test(id)) return null;
  const i = id.indexOf(':');
  const provider = i > 0 && (DEFAULT_ORIGINS[id.slice(0, i)] || id.slice(0, i) === 'local') ? id.slice(0, i) : 'anthropic'; // (no prefix, or "auto": Claude, as providers.splitModel)
  if (provider === 'local') return null;
  const override = provider === 'anthropic' ? env.ANTHROPIC_BASE_URL : provider === 'openai' ? env.OPENAI_BASE_URL : '';
  if (override) { try { return new URL(override).origin; } catch { return null; } }
  return DEFAULT_ORIGINS[provider];
}
const providerOf = (model) => { const id = String(model || ''); const i = id.indexOf(':'); return i > 0 && DEFAULT_ORIGINS[id.slice(0, i)] ? id.slice(0, i) : 'anthropic'; };

// session: an Electron session (its preconnect); hasKey(provider): a key is set (Claude may run on a sign-in, so it is not asked).
function createPreconnect({ session, hasKey = () => true, now = Date.now, env = process.env }) {
  const last = new Map();
  const stats = { opened: 0, skipped: 0 };
  function warm(model) {
    const origin = originFor(model, env);
    const provider = providerOf(model);
    if (!origin || !session?.preconnect || (provider !== 'anthropic' && !hasKey(provider))) { stats.skipped++; return false; }
    const t = now();
    if (last.has(origin) && t - last.get(origin) < AGAIN_MS) { stats.skipped++; return false; }
    last.set(origin, t);
    try { session.preconnect({ url: origin, numSockets: 1 }); } catch { return false; } // a warm-up never reports an error
    stats.opened++;
    return true;
  }
  return { warm, stats };
}

module.exports = { createPreconnect, originFor, DEFAULT_ORIGINS, AGAIN_MS };
