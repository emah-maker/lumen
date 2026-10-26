// A small zip writer (Node zlib only), for "Export project": a zip any tool opens. Names are UTF-8, content is deflated (stored when that is not smaller),
// no encryption, no zip64 (an export is far below 4 GB and 65,535 entries; create() throws past them).
//   create([{ name, data: Buffer, time?: ms }]) -> Buffer
//   list(buf) -> [{ name, size }], read(buf, name) -> Buffer | null   (enough to test it and to read an export back)
const zlib = require('zlib');

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function dosTime(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

function create(entries) {
  if (entries.length > 65000) throw new Error('Too many files for one zip.');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(String(e.name).replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    const packed = data.length ? zlib.deflateRawSync(data, { level: 6 }) : Buffer.alloc(0);
    const useDeflate = packed.length > 0 && packed.length < data.length;
    const body = useDeflate ? packed : data;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosTime(e.time);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
    if (offset > 0xfffffff0) throw new Error('This export is too large for one zip.');
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

function entriesOf(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Not a zip.');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('Bad zip.');
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    out.push({ name: buf.toString('utf8', at + 46, at + 46 + nameLen), size, csize, method, local });
    at += 46 + nameLen + extra;
  }
  return out;
}
const list = (buf) => entriesOf(buf).map((e) => ({ name: e.name, size: e.size }));
function read(buf, name) {
  const e = entriesOf(buf).find((x) => x.name === name);
  if (!e) return null;
  const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
  const body = buf.subarray(start, start + e.csize);
  return e.method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
}

module.exports = { create, list, read, crc32 };
