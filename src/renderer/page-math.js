// [page math] Math in a page the AI wrote ($$…$$, \[…\], \(…\), $…$), typeset before the page goes into its preview frame.
// The preview (chat-canvas.js frameDocument, ai-files.js) runs the page in a sandbox whose Content-Security-Policy allows no network,
// so the MathJax or KaTeX <script> the page loads from a CDN never arrives and the formulas showed as raw LaTeX. Worse, a raw "<" in a
// formula ("0<x<a" in a cases block) reads as the start of a tag to the browser, which then swallowed text up to the next heading.
// Here each formula is turned into MathML with Temml (renderer/vendor/temml.min.js, the same typesetter the chat uses): MathML needs no
// script and no network. Scripts, styles, <pre>, <code> and <textarea> are left alone, and so is a "formula" that holds real HTML tags
// (two $ signs far apart in a page are not math). A formula Temml can't read is left as it was. Pure: unit tested in Node.
(function (root) {
  const SKIP = /<(script|style|pre|code|textarea)\b[\s\S]*?<\/\1\s*>/gi;
  const TAG = /<\/?(?:p|div|span|br|hr|h[1-6]|li|ul|ol|dl|dt|dd|table|thead|tbody|tr|td|th|section|article|header|footer|main|nav|aside|strong|em|b|i|u|code|pre|a|img|body|html|head|button|input|label|figure|figcaption|blockquote|details|summary|svg|math)\b[^<>]*>/i;
  const DECODE = { lt: '<', gt: '>', amp: '&', nbsp: ' ', quot: '"', '#39': "'", apos: "'" };
  const decode = (s) => s.replace(/&(lt|gt|amp|nbsp|quot|#39|apos);/g, (_m, k) => DECODE[k]);
  // Display: $$…$$ and \[…\]; inline: \(…\) and a $…$ that reads as math (no space inside either end, not money such as "$5 and $10").
  const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?=[^\s$\d])([^$\n]{1,400}?)(?<=[^\s\\$])\$(?![\d$])/g;

  const hasMath = (html) => /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^\s$\d][^$\n]*\$/.test(String(html || ''));

  function typeset(temml, tex, display) {
    try {
      const src = decode(tex).replace(/\\label\{[^}]*\}/g, '').replace(/(?<!\\)((?:\\\\)*)%/g, '$1\\%');
      const out = temml.renderToString(src.trim(), { displayMode: display || /^\s*\\begin\{/.test(src), throwOnError: true, trust: false, maxSize: 20, maxExpand: 500 });
      return display ? `<div style="overflow-x:auto;overflow-y:hidden;margin:.6em 0;text-align:center">${out}</div>` : out;
    } catch { return null; }
  }

  // html -> the same page with its formulas as MathML. temml: the Temml object (window.temml); without it the page is returned as it is.
  // css: Temml's stylesheet (vendor/temml.css, read by ready()): its math font list ("Cambria Math", ...) is what makes brackets and the
  // cases brace stretch; put in a <style> once when anything was typeset.
  function mathify(html, temml = root.temml, css = cssText) {
    const text = String(html || '');
    if (!temml?.renderToString || !hasMath(text)) return text;
    const parts = [];
    let at = 0;
    let typeset1 = 0;
    for (const m of text.matchAll(SKIP)) { parts.push([text.slice(at, m.index), true], [m[0], false]); at = m.index + m[0].length; }
    parts.push([text.slice(at), true]);
    const out = parts.map(([chunk, open]) => (!open ? chunk : chunk.replace(MATH, (whole, dd, br, pa, dl) => {
      const tex = dd ?? br ?? pa ?? dl;
      if (!tex || TAG.test(tex)) return whole;
      const done = typeset(temml, tex, dd !== undefined || br !== undefined);
      if (done) typeset1++;
      return done ?? whole;
    }))).join('');
    return typeset1 && css ? `<style>${css}</style>${out}` : out;
  }
  // The part of vendor/temml.css that matters here: a math font, so brackets and braces stretch (Cambria Math ships with Windows, STIX Two
  // Math with macOS), upright text, and a little room in boxed formulas. setCss() can replace it (tests).
  let cssText = 'math{font-family:"Cambria Math","STIX Two Math","STIXTwoMath-Regular","NotoSansMath-Regular",math;font-style:normal;font-weight:normal;line-height:normal;font-size-adjust:none;text-indent:0;text-transform:none;letter-spacing:normal;word-spacing:normal;direction:ltr}math *{border-color:currentColor}menclose.tml-box,.tml-box{padding:.15em}';
  const setCss = (css) => { cssText = String(css || '').replace(/@font-face\s*\{[^}]*\}/g, '').replace(/<\/style/gi, ''); };

  // ready(html): resolves once Temml is here when the page has math (loaded the first time, as markdown.js does for the chat); never rejects.
  const here = typeof document !== 'undefined' ? document.currentScript?.src : '';
  let loading = null;
  function ready(html) {
    if (root.temml || !hasMath(html) || typeof document === 'undefined' || !here) return Promise.resolve();
    loading ||= Promise.all([
      root.temml ? null : new Promise((resolve) => {
        const js = Object.assign(document.createElement('script'), { src: new URL('vendor/temml.min.js', here).href, async: true });
        js.onload = () => resolve();
        js.onerror = () => { loading = null; resolve(); }; // (the page then shows as written; tried again next time)
        document.head.append(js);
      }),
    ]).then(() => {});
    return loading;
  }

  const api = { mathify, hasMath, ready, setCss };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.pageMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
