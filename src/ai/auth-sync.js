'use strict';
// Sign-in files shared between a CLI's own folder and Lumen's copies (Codex's auth.json per chat home, Grok's in Lumen's GROK_HOME).
// These CLIs ROTATE the refresh token on every refresh (the old one stops working), so the only safe rule is: the newest file
// (by modification time) is the live token, it goes to every other copy, and an older file never overwrites a newer one.
// Lumen never reads a sign-in file's contents: it only stats, copies and renames it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ms = (st) => Math.floor(Number(st.mtimeMs));
const statOrNull = async (p) => { try { return await fs.promises.stat(p); } catch { return null; } };

// One copy at a time per destination in this process: copy-backs from parallel chats never interleave.
const chains = new Map();
function serial(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

// Atomic copy (temp file + rename) that keeps the source's mtime, so "newest" stays comparable across copies.
async function copyAtomic(from, to, srcStat) {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  const tmp = `${to}.lumen-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.promises.copyFile(from, tmp);
    await fs.promises.chmod(tmp, 0o600).catch(() => {});
    await fs.promises.utimes(tmp, srcStat.atime, srcStat.mtime);
    await fs.promises.rename(tmp, to);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function copyAtomicSync(from, to, srcStat) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.lumen-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.copyFileSync(from, tmp);
    try { fs.chmodSync(tmp, 0o600); } catch { /* no modes here */ }
    fs.utimesSync(tmp, srcStat.atime, srcStat.mtime);
    fs.renameSync(tmp, to);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
    throw err;
  }
}

// Copies `from` to `to` when `from` is strictly newer (or `to` is missing). True when it copied.
async function copyIfNewer(from, to) {
  try {
    const src = await statOrNull(from);
    if (!src) return false;
    return await serial(path.resolve(to), async () => {
      const dst = await statOrNull(to);
      if (dst && ms(dst) >= ms(src)) return false;
      await copyAtomic(from, to, src);
      return true;
    });
  } catch { return false; }
}

// Makes every path hold the newest of them: the newest existing file is copied over each older (or missing) one. Returns how many
// were written. Paths that cannot be written are skipped (never throws).
async function syncNewest(paths) {
  const unique = [...new Set(paths.filter(Boolean).map((p) => path.resolve(p)))];
  const stats = await Promise.all(unique.map(statOrNull));
  let best = -1;
  for (let i = 0; i < unique.length; i++) if (stats[i] && (best < 0 || ms(stats[i]) > ms(stats[best]))) best = i;
  if (best < 0) return 0;
  let n = 0;
  for (let i = 0; i < unique.length; i++) {
    if (i === best) continue;
    if (stats[i] && ms(stats[i]) >= ms(stats[best])) continue;
    if (await copyIfNewer(unique[best], unique[i])) n++;
  }
  return n;
}

// Failure text that is a network, rate or server problem, not a sign-in one: "sign in again" would be the wrong advice (and Lumen would
// mark the engine signed out for good).
const TRANSIENT = /econn(reset|refused|aborted)|etimedout|enotfound|eai_again|epipe|socket hang up|fetch failed|network (error|is unreachable)|timed? ?out|dns|tls|ssl|certificate|proxy|connection (reset|closed|refused|error)|temporar(il)?y|try again|overloaded|service unavailable|bad gateway|gateway time-?out|\b(429|500|502|503|504|529)\b/i;
const isTransient = (text) => TRANSIENT.test(String(text || ''));

// Is `text` a real "signed out" report? `strong` patterns (the CLI says so outright) always count; `weak` ones (a word like oauth or
// authentication that network errors also contain) only when the text isn't a transient failure.
const isSignedOutText = (text, strong, weak) => { const t = String(text || ''); return strong.test(t) || (weak.test(t) && !isTransient(t)); };

module.exports = { isSignedOutText, copyIfNewer, copyAtomic, copyAtomicSync, syncNewest, serial, isTransient, ms };
