// read_urls on a web PDF (a steam table, a datasheet, a paper): the page view cannot show one, so the bytes are fetched and their text read
// with features/pdf-text.js (the same reader read_pdf uses, rows kept as lines), page-numbered. Remote PDFs follow the site rules of
// read_urls (the host was approved before this runs; a redirect to another host asks first via onHop); the per-file prompt of read_pdf
// is for the user's own local files and open tabs, not for the public web.
// Pure: `fetch` is injected (the reader session's fetch in the app, Node's in tests).
const pdfText = require('../features/pdf-text');
const health = require('./page-health');

const MAX_HOPS = 5;
const PDF_EXT = /\.pdf$/i;
const looksLikePdfUrl = (url) => { try { return PDF_EXT.test(new URL(url).pathname); } catch { return false; } };

// Follows redirects by hand so every new host can be checked. -> { res, url } (the final response) or throws.
async function fetchFollowing(url, { fetch, onHop, signal }) {
  let at = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetch(at, { redirect: 'manual', signal, headers: { accept: 'application/pdf,*/*;q=0.5' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), at).href;
      if (!/^https?:/i.test(next)) throw new Error('The address redirected somewhere that is not a web page.');
      if (new URL(next).host !== new URL(at).host && onHop) await onHop(next);
      try { await res.body?.cancel(); } catch {}
      at = next;
      continue;
    }
    return { res, url: at };
  }
  throw new Error('The address kept redirecting. Check it and try again.');
}

async function bodyBytes(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body || []) {
    size += chunk.length;
    if (size > pdfText.MAX_BYTES) throw new Error('This PDF is too large to read (over 50 MB).');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// The PDF at `url` as a read_urls page { url, title, text }, or null when it is not a PDF (the caller reads it as a web page).
// `force`: the caller already thinks it is one (a .pdf address); otherwise only a PDF content type is taken.
async function readRemotePdf(url, { fetch, onHop = null, maxChars, offset = 0, timeoutMs = 30000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let got;
  try { got = await fetchFollowing(url, { fetch, onHop, signal }); } catch (err) { if (looksLikePdfUrl(url)) return { url, title: '', text: `Could not read this PDF: ${err.message}` }; return null; }
  const { res, url: finalUrl } = got;
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  const pdfType = /application\/(?:x-)?pdf|application\/octet-stream/.test(type);
  if (!res.ok || !(pdfType || looksLikePdfUrl(finalUrl))) { try { await res.body?.cancel(); } catch {} return null; }
  let buf;
  try { buf = await bodyBytes(res); } catch (err) { return { url: finalUrl, title: '', text: `Could not read this PDF: ${err.message}` }; }
  if (buf.subarray(0, 1024).indexOf('%PDF-') < 0) return null; // an HTML error page at a .pdf address, say
  const name = pdfText.pdfName(finalUrl);
  let texts;
  try { texts = pdfText.extractPages(buf); } catch (err) { return { url: finalUrl, title: name, text: `Could not read this PDF: ${err.message}` }; }
  const out = pdfText.formatPages(texts, { maxChars: Number.MAX_SAFE_INTEGER, noun: 'PDF' });
  const slice = health.slicePage(out.text, { maxChars, offset });
  const empty = !out.text.replace(/--- Page \d+ of \d+ ---|\(no text[^)]*\)/g, '').trim();
  const head = `PDF: ${name} (${out.numPages} page${out.numPages === 1 ? '' : 's'}; text read in the browser${empty ? '; this PDF has no text layer, it may be a scan: open it in a tab and use screenshot' : ''})`;
  return { url: finalUrl, title: name, text: [head, slice.text, slice.note].filter(Boolean).join('\n\n') };
}

module.exports = { readRemotePdf, looksLikePdfUrl };
