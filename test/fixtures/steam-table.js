// Fixtures shared by test/ai-reads-sources-units.js and test/ai-reads-sources.js: a steam table as a PDF (cells written one text object each,
// the way Word does) and as an HTML page, served by a local http server (startServer -> { server, base }).
const http = require('http');
const zlib = require('zlib');

// A one-page PDF with a table the way Word writes it: every cell is its own text object (BT..ET) placed with Tm, rows at their own height.
function tablePdf(rows) {
  const ops = [];
  rows.forEach((row, r) => row.forEach((cell, c) => ops.push(`BT /F1 9 Tf 1 0 0 1 ${60 + c * 70} ${700 - r * 14} Tm (${cell}) Tj ET`)));
  const stream = zlib.deflateSync(Buffer.from(ops.join('\n')));
  const objs = [];
  const add = (dict, body) => objs.push(body ? Buffer.concat([Buffer.from(`${dict.replace('>>', `/Length ${body.length}>>`)}\nstream\n`), body, Buffer.from('\nendstream')]) : Buffer.from(dict));
  add('<</Type/Catalog/Pages 2 0 R>>');
  add('<</Type/Pages/Kids[3 0 R]/Count 1/Resources<</Font<</F1 5 0 R>>>>>>');
  add('<</Type/Page/Parent 2 0 R/Contents 4 0 R>>');
  add('<</Filter/FlateDecode>>', stream);
  add('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  const parts = [Buffer.from('%PDF-1.4\n')];
  objs.forEach((o, i) => parts.push(Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')));
  parts.push(Buffer.from('trailer\n<</Root 1 0 R>>\n%%EOF'));
  return Buffer.concat(parts);
}

const TABLE = [
  ['P (kPa)', 'Tsat (C)', 'vf', 'hf', 'hfg', 'hg'],
  ['7.5', '40.29', '0.001008', '168.75', '2406.0', '2574.8'],
  ['8', '41.51', '0.001008', '173.85', '2403.0', '2576.8'],
  ['10', '45.81', '0.001010', '191.81', '2392.1', '2583.9'],
];
const PDF = tablePdf(TABLE);
const HTML_TABLE = `<!doctype html><html><head><title>Saturated water table</title></head><body><h1>Saturated water: pressure table</h1>
<p>Properties of saturated water by pressure (kPa).</p><table><thead><tr><th>P (kPa)</th><th>Tsat (C)</th><th>hf</th><th>hfg</th></tr></thead>
<tbody><tr><td>7.5</td><td>40.29</td><td>168.75</td><td>2406.0</td></tr><tr><td>8</td><td>41.51</td><td>173.85</td><td>2403.0</td></tr><tr><td>10</td><td>45.81</td><td>191.81</td><td>2392.1</td></tr></tbody></table></body></html>`;

const makeServer = () => http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/steam/Table_A_3.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(PDF); }
  else if (u === '/steam/old-name.pdf') { res.writeHead(301, { location: '/steam/Table_A_3.pdf' }); res.end(); }
  else if (u === '/download') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(PDF); } // a PDF at an address that does not say so
  else if (u === '/steam/broken.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end('%PDF-1.4 not really'); }
  else if (u === '/steam/missing.pdf') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html><body>404 - File or directory not found.</body></html>'); }
  else if (u === '/steam/soft404.pdf') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>nothing here</body></html>'); }
  else if (u === '/steam/table.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML_TABLE); }
  else { res.writeHead(404); res.end('no'); }
});


async function startServer() {
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

module.exports = { tablePdf, TABLE, PDF, HTML_TABLE, startServer };
