// CRX3 packages (a Chrome extension's signed zip), read with their signature checked: the extension's id comes from the key that signed it,
// so a package that claims another extension's id, or whose files were changed after signing, is refused.
// Format: "Cr24", version 3, a CrxFileHeader (protobuf), then the zip. The publisher's RSA proof signs
// "CRX3 SignedData\x00" + the signed header's length (uint32 LE) + the signed header (which holds the id) + the zip.
const crypto = require('crypto');

// The protobuf fields of a message: [fieldNumber, bytes] for length-delimited ones (the only kind these messages use for what we read).
function fields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('Truncated CRX header');
      const b = buf[i++];
      value += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return value;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const type = key & 7;
    if (type === 2) {
      const len = varint();
      if (i + len > buf.length) throw new Error('Truncated CRX header');
      out.push([field, buf.subarray(i, i + len)]);
      i += len;
    } else if (type === 0) varint();
    else if (type === 5) i += 4;
    else if (type === 1) i += 8;
    else throw new Error('Bad CRX header');
  }
  return out;
}

// An extension id: the first 16 bytes of the SHA-256 of its public key, each hex digit written as a-p.
const idFromBytes = (bytes) => [...bytes.subarray(0, 16).toString('hex')].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const idFromKey = (publicKey) => idFromBytes(crypto.createHash('sha256').update(publicKey).digest());

// { id, publicKey (DER, base64 as manifest.key wants), zip } for a CRX3 whose publisher signature checks out; throws otherwise.
function readCrx(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'Cr24') throw new Error('Not a Chrome extension package');
  if (buf.readUInt32LE(4) !== 3) throw new Error('Unsupported extension package version');
  const headerLen = buf.readUInt32LE(8);
  if (12 + headerLen > buf.length) throw new Error('Truncated extension package');
  const header = fields(buf.subarray(12, 12 + headerLen));
  const zip = buf.subarray(12 + headerLen);
  const signedData = header.find(([f]) => f === 10000)?.[1];
  const crxId = signedData && fields(signedData).find(([f]) => f === 1)?.[1];
  if (!crxId || crxId.length !== 16) throw new Error('Extension package has no id');
  const id = idFromBytes(crxId);
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), Buffer.alloc(4), signedData, zip]);
  message.writeUInt32LE(signedData.length, 16);
  for (const [f, proof] of header) {
    if (f !== 2) continue; // sha256_with_rsa
    const parts = fields(proof);
    const publicKey = parts.find(([p]) => p === 1)?.[1];
    const signature = parts.find(([p]) => p === 2)?.[1];
    if (!publicKey || !signature || idFromKey(publicKey) !== id) continue;
    const key = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
    if (!crypto.verify('sha256', message, key, signature)) throw new Error('Extension package signature is invalid');
    return { id, publicKey: publicKey.toString('base64'), zip };
  }
  throw new Error('Extension package is not signed by its publisher');
}

module.exports = { readCrx, idFromKey };
