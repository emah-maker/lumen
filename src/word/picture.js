// [word] Pictures for the word tool's image action: what a picture file is (its type and size in pixels, from its own header bytes, never its name),
// and a picture from the web, fetched without cookies or credentials, only from a public address (no localhost, no private or link-local network,
// after every redirect too), at most 20 MB, and only when the bytes really are a PNG, JPEG, GIF or BMP. Plain Node; loaded on first use.
'use strict';

const net = require('net');
const { WordError } = require('./spec');

const MAX_BYTES = 20 * 1024 * 1024;
const TYPES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };

// -> { type: 'png'|'jpeg'|'gif'|'bmp', ext, mime, width, height } (pixels; 0 when the header does not say), or null for anything else.
function pictureInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  const out = (type, width, height) => ({ type, ext: type === 'jpeg' ? 'jpg' : type, mime: TYPES[type], width: width || 0, height: height || 0 });
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return out('png', buf.readUInt32BE(16), buf.readUInt32BE(20));
  if (buf.toString('latin1', 0, 4) === 'GIF8') return out('gif', buf.readUInt16LE(6), buf.readUInt16LE(8));
  if (buf[0] === 0x42 && buf[1] === 0x4d && buf.length >= 26) return out('bmp', Math.abs(buf.readInt32LE(18)), Math.abs(buf.readInt32LE(22)));
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return out('jpeg', buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
      i += 2 + len;
    }
    return out('jpeg', 0, 0);
  }
  return null;
}

// Is this IP address one of the computer's own or a private network's? (v4 and v6, v4-mapped v6 too)
function privateIp(ip) {
  let a = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q < 128) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q < 32) || (p === 192 && q === 168) || (p === 198 && (q === 18 || q === 19)) || p >= 224;
  }
  if (net.isIPv6(a)) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a);
  return true;
}

// url -> { buf, info } or a WordError with a plain sentence. deps: fetch (the global one), lookup (dns.promises.lookup), timeoutMs.
async function fetchPicture(url, { fetch = globalThis.fetch, lookup = require('dns').promises.lookup, timeoutMs = 20000 } = {}) {
  let at = String(url || '');
  for (let hop = 0; hop < 4; hop++) {
    let u;
    try { u = new URL(at); } catch { throw new WordError('That picture address is not a web address.'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new WordError('A picture comes from an http or https address, or a file on this computer.');
    if (u.username || u.password) throw new WordError('A picture address with a user name or password in it is not fetched.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new WordError('Pictures are fetched only from public web addresses, not from this computer or its network.');
    let addrs;
    if (net.isIP(host)) addrs = [{ address: host }];
    else { try { addrs = await lookup(host, { all: true }); } catch { throw new WordError(`${host} could not be found, so the picture was not fetched.`); } }
    if (!addrs.length || addrs.some((x) => privateIp(x.address))) throw new WordError('Pictures are fetched only from public web addresses, not from this computer or its network.');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try { res = await fetch(u.href, { redirect: 'manual', credentials: 'omit', signal: ctl.signal, headers: { accept: 'image/png,image/jpeg,image/gif,image/bmp;q=0.9,*/*;q=0.1' } }); } catch (err) { clearTimeout(timer); throw new WordError(`The picture could not be fetched (${String(err?.name === 'AbortError' ? 'it took too long' : err?.message || err).slice(0, 80)}).`); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { clearTimeout(timer); at = new URL(res.headers.get('location'), u).href; continue; }
    try {
      if (!res.ok) throw new WordError(`The picture could not be fetched (the site answered ${res.status}).`);
      if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) throw new WordError('That picture is larger than 20 MB, so it was not fetched.');
      const chunks = []; let size = 0;
      for await (const c of res.body) { size += c.length; if (size > MAX_BYTES) throw new WordError('That picture is larger than 20 MB, so it was not fetched.'); chunks.push(Buffer.from(c)); }
      const buf = Buffer.concat(chunks);
      const info = pictureInfo(buf);
      if (!info) throw new WordError('That address did not give a PNG, JPEG, GIF or BMP picture, so nothing was inserted.');
      return { buf, info };
    } finally { clearTimeout(timer); try { ctl.abort(); } catch { /* done */ } }
  }
  throw new WordError('That picture address redirects too many times.');
}

module.exports = { pictureInfo, fetchPicture, privateIp, MAX_BYTES };
