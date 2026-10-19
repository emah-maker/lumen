// Plain Node: inline SVG in the chat. The sanitizer (renderer/svg-view.js: an allowlist that writes a new SVG, never copies the input),
// raw <svg> in a reply lifted into a ```svg block (renderer/markdown.js, also for streaming and for Markdown export), and the wiring
// (the picture code is lazy: not in the startup bundle).
const fs = require('fs');
const path = require('path');
const { sanitize } = require('../src/renderer/svg-view');
const md = require('../src/renderer/markdown');
const { toMarkdown } = require('../src/features/chat-store');
const { DIAGRAM, EVIL } = require('./_svg-fixtures');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const FENCE = '```';

// ---- the diagram from the report survives
const good = sanitize(DIAGRAM);
check('the diagram sanitizes', !!good, JSON.stringify(good));
check('its natural size is 240 x 240', good?.width === 240 && good?.height === 240, JSON.stringify(good));
check('marker and its arrow path are kept', /<marker [^>]*id="arr"/.test(good?.svg) && /<path d="M0,0 L8,4 L0,8 z"/.test(good?.svg), good?.svg);
check('marker-end url(#arr) is kept', (good?.svg.match(/marker-end="url\(#arr\)"/g) || []).length === 2, good?.svg);
check('the unicode label is kept', good?.svg.includes('τ = 9000 psi'), good?.svg);
check('the output is a well-formed single svg with the namespace', /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(good?.svg) && good.svg.endsWith('</svg>'), good?.svg);
check('colours are not altered', good?.svg.includes('fill="#e8f0fe"') && good?.svg.includes('stroke="#111"'), good?.svg);

// ---- hostile input
const bad = sanitize(EVIL);
check('a hostile svg still sanitizes (its safe parts remain)', !!bad && bad.svg.includes('safe label') && bad.svg.includes('<rect'), JSON.stringify(bad));
check('<script> and its code are gone', !/script|__svgPwned|svg-script-ran/i.test(bad?.svg), bad?.svg);
check('onload / onclick are stripped', !/\bon\w+\s*=/i.test(bad?.svg), bad?.svg);
check('foreignObject and what it held are removed', !/foreignObject|<body|<img|onerror/i.test(bad?.svg), bad?.svg);
check('an <image> with an external href is removed', !/<image|example\.invalid/i.test(bad?.svg), bad?.svg);
const s = (inner, attrs = '') => sanitize(`<svg width="10" height="10"${attrs}>${inner}</svg>`)?.svg || '';
check('javascript: href is dropped', !/javascript/i.test(s('<use href="javascript:alert(1)"/><use xlink:href=" JaVa\nscript:alert(1)"/>')), s('<use href="javascript:alert(1)"/>'));
check('an external <use> is removed, a local one is kept', !/evil/.test(s('<use href="https://evil.invalid/a.svg#x"/>')) && /<use href="#a"\/>/.test(s('<g id="a"/><use href="#a"/>')), s('<use href="#a"/>'));
check('external url() in a fill is dropped', !/evil/.test(s('<rect fill="url(https://evil.invalid/x)" width="1" height="1"/>')), s('<rect fill="url(https://evil.invalid/x)"/>'));
check('url(#gradient) is kept', /fill="url\(#g\)"/.test(s('<linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><rect fill="url(#g)" width="1" height="1"/>')), '');
check('data: URLs are dropped (except a safe local picture)', !/data:/.test(s('<rect style="fill:url(data:image/svg+xml;base64,AAAA)" width="1" height="1"/><use href="data:image/svg+xml;base64,AAAA"/>')), '');
check('@import and external url() in <style> remove the style', !/style|import|evil/i.test(s('<style>@import url(https://evil.invalid/a.css); rect{fill:red}</style>')) && !/evil/.test(s('<style>rect{fill:url(https://evil.invalid/x)}</style>')), '');
check('a harmless <style> is kept', /<style>rect\{fill:red\}<\/style>/.test(s('<style>rect{fill:red}</style>')), s('<style>rect{fill:red}</style>'));
check('style="" with an external url() is dropped, a plain one is kept', !/evil/.test(s('<rect style="background:url(//evil.invalid/x)" width="1" height="1"/>')) && /style="fill:#123"/.test(s('<rect style="fill:#123" width="1" height="1"/>')), '');
check('animation elements are removed (they can set an href)', !/animate|<set/i.test(s('<a><animate attributeName="href" values="javascript:alert(1)"/></a><set attributeName="onload" to="x"/>')), s('<set attributeName="onload" to="x"/>'));
check('an iframe, object and embed go with their content', !/iframe|object|embed|inner/i.test(s('<iframe src="x">inner</iframe><object data="x">inner</object><embed src="x"/>')), '');
check('an unknown element loses its tag but keeps its children', /<rect/.test(s('<weird><rect width="1" height="1"/></weird>')) && !/weird/.test(s('<weird><rect width="1" height="1"/></weird>')), s('<weird><rect/></weird>'));
check('an attribute outside the allowlist is dropped', !/data-x|formaction|srcdoc/i.test(s('<rect data-x="1" formaction="x" srcdoc="x" width="1" height="1"/>')), '');
check('attribute values are escaped (no breaking out of the quote)', !/"\s*onload/i.test(s('<text x="1" y="1" fill="red&quot; onload=&quot;alert(1)">t</text>')) && s('<text fill="a&quot;b">t</text>').includes('fill="a&quot;b"'), s('<text fill="a&quot;b">t</text>'));
check('text is escaped and entities decode (&amp; &lt; &tau; &#964;)', s('<text>a &amp; b &lt;i&gt; &tau; &#964;</text>').includes('a &amp; b &lt;i&gt; τ τ'), s('<text>a &amp; b &lt;i&gt; &tau; &#964;</text>'));
check('an unknown entity is kept as literal text, never as a raw &', !/&(?!amp;|lt;|gt;|quot;)/.test(s('<text>&nosuch; &</text>')), s('<text>&nosuch; &</text>'));
check('CDATA text is kept as escaped text', s('<text><![CDATA[1 < 2 & 3]]></text>').includes('1 &lt; 2 &amp; 3'), s('<text><![CDATA[1 < 2 & 3]]></text>'));
check('tspan and nested text keep their order', /<text[^>]*>A<tspan[^>]*>B<\/tspan>C<\/text>/.test(s('<text>A<tspan dy="2">B</tspan>C</text>')), s('<text>A<tspan dy="2">B</tspan>C</text>'));
check('title and desc are kept', /<title>T<\/title><desc>D<\/desc>/.test(s('<title>T</title><desc>D</desc>')), '');
check('the title is returned for the picture label', sanitize('<svg width="5" height="5"><title>Stress element</title></svg>')?.title === 'Stress element', '');
check('an <svg> with a mismatched close tag still comes out well-formed', /^<svg[^>]*><g><rect[^>]*(?:\/>|><\/rect>)<\/g><\/svg>$/.test(sanitize('<svg width="1" height="1"><g><rect width="1" height="1"></g></svg>')?.svg || ''), sanitize('<svg width="1" height="1"><g><rect width="1" height="1"></g></svg>')?.svg);
check('a comment, doctype and <?xml?> before the svg are ignored', !!sanitize('<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><!-- c --><svg width="3" height="3"/>'), '');
check('text before the svg and nothing else: not an svg', sanitize('hello') === null && sanitize('') === null && sanitize('<div>x</div>') === null, '');
check('an svg that never closes is not drawn (still streaming)', sanitize('<svg width="5" height="5"><rect/>') === null, '');
check('content after the closing </svg> is ignored', !/evil|<div/.test(sanitize('<svg width="5" height="5"/><script>evil()</script><div>x</div>')?.svg || ''), '');

// ---- size, dimensions
check('no width/height: the viewBox gives the size', (() => { const r = sanitize('<svg viewBox="0 0 200 100"><rect/></svg>'); return r.width === 200 && r.height === 100; })(), '');
check('only a width: the height follows the viewBox ratio', (() => { const r = sanitize('<svg width="300" viewBox="0 0 200 100"><rect/></svg>'); return r.width === 300 && r.height === 150; })(), '');
check('width="100%" falls back to the viewBox', (() => { const r = sanitize('<svg width="100%" height="100%" viewBox="0 0 50 40"><rect/></svg>'); return r.width === 50 && r.height === 40; })(), '');
check('no size at all still gets one', (() => { const r = sanitize('<svg><rect/></svg>'); return r.width > 0 && r.height > 0; })(), '');
check('a huge declared size is capped', sanitize('<svg width="99999" height="99999"/>').width <= 4000, '');
check('over 200 KB is refused', sanitize(`<svg width="1" height="1"><text>${'x'.repeat(210 * 1024)}</text></svg>`) === null, '');
check('too many elements is refused', sanitize(`<svg width="1" height="1">${'<rect/>'.repeat(3100)}</svg>`) === null, '');
check('too deep is refused', sanitize(`<svg width="1" height="1">${'<g>'.repeat(60)}${'</g>'.repeat(60)}</svg>`) === null, '');
check('too many <use> is refused', sanitize(`<svg width="1" height="1"><g id="a"/>${'<use href="#a"/>'.repeat(150)}</svg>`) === null, '');
check('a deeply nested hostile string finishes quickly', (() => { const t = Date.now(); sanitize('<svg width="1" height="1">' + '<a '.repeat(5000)); sanitize('<svg>' + '<!--'.repeat(5000)); return Date.now() - t < 1500; })(), '');

// ---- raw <svg> in a reply
const raw = `Here is the beam:\n${DIAGRAM}\nIt shows the stress.`;
const lifted = md.liftRawSvg(raw);
check('a raw <svg> block becomes a ```svg fence of its own', lifted.includes(`${FENCE}svg\n<svg`) && lifted.includes(`</svg>\n${FENCE}\nIt shows`), lifted);
const html = md.render(raw);
check('rendered, it is a code block with data-lang="svg" and the paragraphs around it', /<p>Here is the beam:<\/p><pre data-lang="svg"><code>&lt;svg/.test(html) && /<\/pre><p>It shows the stress\.<\/p>/.test(html), html);
check('a fenced ```svg block is untouched by the lift', md.liftRawSvg(`${FENCE}svg\n${DIAGRAM}\n${FENCE}`) === `${FENCE}svg\n${DIAGRAM}\n${FENCE}`, '');
check('a raw <svg> inside another code fence is left alone', md.liftRawSvg(`${FENCE}html\n<svg width="1" height="1"/>\n${FENCE}`) === `${FENCE}html\n<svg width="1" height="1"/>\n${FENCE}`, '');
check('an inline svg in a sentence is lifted when it closes', md.liftRawSvg('x <svg width="1" height="1"><rect/></svg> y').split('\n').length === 5, md.liftRawSvg('x <svg width="1" height="1"><rect/></svg> y'));
check('prose about the <svg> element is left alone', md.liftRawSvg('Use the <svg> element, or `<svg width="1">` inline.') === 'Use the <svg> element, or `<svg width="1">` inline.', '');
check('an unfinished raw <svg> at a line start streams as an open code block', /<pre data-lang="svg">/.test(md.render('Look:\n<svg width="10" height="10">\n<rect/>')) && !/<p>&lt;svg/.test(md.render('Look:\n<svg width="10" height="10">\n<rect/>')), md.render('Look:\n<svg width="10" height="10">\n<rect/>'));
check('blank lines inside a raw <svg> do not end a streaming block', (() => { const t = 'Look:\n\n<svg width="10" height="10">\n\n<rect/>\n\n'; return md.stableLength(t, {}) === 'Look:\n\n'.length; })(), md.stableLength('Look:\n\n<svg width="10" height="10">\n\n<rect/>\n\n', {}));
check('after the </svg> the next blank line is a block end again', (() => { const t = 'Look:\n\n<svg width="10" height="10">\n\n<rect/></svg>\n\nmore'; return md.stableLength(t, {}) === t.indexOf('more'); })(), '');
check('stableLength resumes through a raw <svg> the same as a full pass', (() => {
  const text = 'a\n\n<svg width="1" height="1">\n\n<g>\n\n</g></svg>\n\nb\n\n';
  const memo = {};
  let at = 0;
  for (let i = 0; i < text.length; i += 7) at = md.stableLength(text.slice(0, i + 7), memo);
  return at === md.stableLength(text, {}) && at === text.length;
})(), '');

// ---- Markdown export keeps the source as a ```svg block
const out = toMarkdown({ title: 'Beam' }, [{ role: 'assistant', text: raw }]);
check('export: a raw <svg> comes out as a ```svg block', out.includes(`${FENCE}svg\n<svg`) && out.includes(`</svg>\n${FENCE}`), out);
const out2 = toMarkdown({ title: 'Beam' }, [{ role: 'assistant', text: `${FENCE}svg\n${DIAGRAM}\n${FENCE}` }]);
check('export: a fenced ```svg block is exported as written', out2.includes(`${FENCE}svg\n${DIAGRAM}\n${FENCE}`), out2);

// ---- wiring
const bundle = read('src/renderer/ui.bundle.js');
check('svg-view.js is lazy: not in the startup bundle or the page lists', !/window\.svgView\s*=/.test(bundle) && !/svg-view\.js/.test(read('src/renderer/index.src.html')) && !/svg-view\.js/.test(read('src/renderer/chat-page.html')), '');
check('the chat code loads it on the first svg block', /svg-view\.js/.test(read('src/renderer/code-extras.js')), '');
check('the picture is an <img> with a data: URL, never inlined markup', /<img|createElement\('img'\)|el\('img'/.test(read('src/renderer/svg-view.js')) && !/innerHTML\s*=/.test(read('src/renderer/svg-view.js')), '');
const en = JSON.parse(read('src/locales/en.json'));
check('the Code / Picture / PNG labels are in en.json', ['chat.showCode', 'chat.showPicture', 'chat.svgSavePng', 'chat.svgAlt'].every((k) => en[k]), '');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
