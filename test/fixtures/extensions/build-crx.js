// Packs an unpacked extension folder into a signed CRX3 file (what the Chrome Web Store serves), with a throwaway key made on the
// spot, so test/e2e/extensions.js can serve a real-looking download from 127.0.0.1 instead of reaching the store. No dependencies beyond
// adm-zip (already installed for electron-chrome-web-store) and node:crypto.
//   const { id, crx } = buildCrx(dir);   // id: the 32-letter extension id the key gives; crx: a Buffer
const nodeCrypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); };
// A length-delimited protobuf field.
const field = (num, bytes) => Buffer.concat([varint(num * 8 + 2), varint(bytes.length), bytes]);
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

function buildCrx(dir) {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const crxId = nodeCrypto.createHash('sha256').update(der).digest().subarray(0, 16);
  // Chrome's extension id: the first 16 bytes of the key's hash, each hex digit written as a letter (0 -> a ... f -> p).
  const id = [...crxId.toString('hex')].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');

  const zip = new AdmZip();
  const add = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) add(next);
      else zip.addFile(next.split(path.sep).join('/'), fs.readFileSync(path.join(dir, next)));
    }
  };
  add('');
  const archive = zip.toBuffer();

  const signedData = field(1, crxId); // SignedData { crx_id }
  const signer = nodeCrypto.createSign('sha256');
  signer.update(Buffer.concat([Buffer.from('CRX3 SignedData\0'), le32(signedData.length), signedData, archive]));
  const signature = signer.sign(privateKey);
  const proof = Buffer.concat([field(1, der), field(2, signature)]); // AsymmetricKeyProof { public_key, signature }
  const header = Buffer.concat([field(2, proof), field(10000, signedData)]); // CrxFileHeader { sha256_with_rsa, signed_header_data }
  return { id, crx: Buffer.concat([Buffer.from('Cr24'), le32(3), le32(header.length), header, archive]) };
}

module.exports = { buildCrx };
