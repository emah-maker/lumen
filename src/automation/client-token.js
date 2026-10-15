// The token an outside app (Claude Desktop, Cursor, VS Code, Claude Code...) is given in Settings > AI > "Let other apps use Lumen".
// Shape: lmn_<12 hex: the public id>_<48 hex: the secret>. The bridge (mcp.js) never sends the token: it proves it knows it for the
// connection's nonce (HMAC), as it does for Lumen's own per-run token, so a process squatting on the channel learns nothing.
// Pure and Electron-free: the bridge process loads it too. Used by features/external-apps.js.
const crypto = require('crypto');

const PATTERN = /^lmn_([a-f0-9]{12})_([a-f0-9]{48})$/;

function make() {
  const id = crypto.randomBytes(6).toString('hex');
  return { id, token: `lmn_${id}_${crypto.randomBytes(24).toString('hex')}` };
}
const parse = (token) => { const m = PATTERN.exec(String(token || '').trim()); return m ? { id: m[1], token: m[0] } : null; };
const proofFor = (token, nonce) => crypto.createHmac('sha256', token).update(`client:${nonce}`).digest('hex');

// The fields the bridge adds to its first line when LUMEN_CLIENT_TOKEN is set (none when it is not: an unmanaged agent).
function hello(token, nonce) {
  if (!token) return {};
  const p = parse(token);
  return p ? { lumenClient: p.id, lumenClientProof: proofFor(p.token, nonce) } : { lumenClient: 'invalid', lumenClientProof: '' };
}

// Is `proof` the right proof of `token` for `nonce`? Constant-time.
function verify(token, nonce, proof) {
  const given = Buffer.from(String(proof || ''));
  const expected = Buffer.from(proofFor(token, nonce));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { make, parse, proofFor, hello, verify, PATTERN };
