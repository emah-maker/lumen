// [doc-edit] Pure logic for the `document` tool: export parsing, snapshots and verify, the destructive-action check, section
// planning, styles, markdown. Plain Node.
const d = require('../src/ai/doc-edit');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };

const HTML = `<html><head><style>h1{}</style></head><body>
<h1>Abstract</h1><p>We measured the <b>spring</b> constant.</p>
<h1>Methods</h1><p>A mass hung from a spring.</p><h2>Setup</h2><p>Clamp the stand.</p><img src="a.png"><table><tr><td>1</td></tr></table>
<h1>Results</h1><p>See the graph.</p><img src="g1.png"><img src="g2.png"><img src="https://www.google.com/chart?cht=tx&chl=x%5E2">
<h1>Discussion</h1><p>It worked &amp; agrees.</p></body></html>`;

const p = d.parseDocHtml(HTML);
check('headings parsed with levels', p.headings.map((h) => `${h.level}:${h.text}`).join('|') === '1:Abstract|1:Methods|2:Setup|1:Results|1:Discussion', JSON.stringify(p.headings));
check('image, table, equation counts', p.images === 3 && p.tables === 1 && p.equations === 1, JSON.stringify({ i: p.images, t: p.tables, e: p.equations }));
check('style tag text is not document text', !/h1\{/.test(p.text) && /agrees/.test(p.text) && /&/.test(p.text));
check('OMML equation count', d.countOmml('<m:oMathPara><m:oMath/></m:oMathPara><m:oMath/>') === 2);

// sections
const H = p.headings;
check('find heading exact / prefix / contains', d.findHeading(H, 'results').index === 3 && d.findHeading(H, 'Meth').index === 1 && d.findHeading(H, 'iscuss').index === 4);
check('find heading: missing and ambiguous', !!d.findHeading(H, 'nope').error && !!d.findHeading([{ level: 1, text: 'Part A' }, { level: 1, text: 'Part B' }], 'part').error);
check('section includes subsections', JSON.stringify(d.sectionSpan(H, 1)) === '{"from":1,"to":2}' && d.sectionSpan(H, 0).to === 0);
const mv = d.planMove(H, 'Methods', 'after', 'Results');
check('move section after another', JSON.stringify(mv.order) === '[0,3,1,2,4]', JSON.stringify(mv));
check('move section before another', JSON.stringify(d.planMove(H, 'Discussion', 'before', 'Methods').order) === '[0,4,1,2,3]');
check('moving into itself is refused', !!d.planMove(H, 'Methods', 'after', 'Setup').error);
check('bad where is refused', !!d.planMove(H, 'Methods', 'next to', 'Results').error);

// styles
check('parseStyle names', d.parseStyle('Heading 2').level === 2 && d.parseStyle('h3').level === 3 && d.parseStyle('Normal text').level === 0 && !!d.parseStyle('Comic').error);
check('style shortcuts per editor', d.styleShortcut('gdocs', 1) === 'Control+Alt+1' && d.styleShortcut('gdocs', 0) === 'Control+Alt+0' && d.styleShortcut('word', 5) === null && d.styleShortcut('notion', 1) === null);

// editor detection and export url
check('detect editors', d.detectEditor('https://docs.google.com/document/d/abc123/edit') === 'gdocs' && d.detectEditor('https://docs.google.com/spreadsheets/d/x') === null
  && d.detectEditor('https://www.notion.so/page-1') === 'notion' && d.detectEditor('https://example.com') === null);
check('export url', d.gdocsExportUrl('https://docs.google.com/document/d/abc-1_2/edit?tab=t.0', 'html') === 'https://docs.google.com/document/d/abc-1_2/export?format=html' && d.gdocsExportUrl('https://x.com/a') === null);

// snapshot + verify
const before = d.takeSnapshot({ html: HTML, rev: 'r7' });
const movedHtml = HTML.replace(/<h1>Methods[\s\S]*?(?=<h1>Results)/, '').replace('</body>', '<h1>Methods</h1><p>A mass hung from a spring.</p><h2>Setup</h2><p>Clamp the stand.</p><img src="a.png"><table><tr><td>1</td></tr></table></body>');
const afterMove = d.takeSnapshot({ html: movedHtml });
const okMove = d.compareSnapshots(before, afterMove, { headings: afterMove.headings });
const reordered = d.compareSnapshots(before, afterMove);
check('verify: a section move keeps words and object counts', okMove.ok, JSON.stringify(okMove));
check('verify: a changed heading order is reported unless it was planned', !reordered.ok && !reordered.headingsOk && /headings/.test(reordered.problems.join()), JSON.stringify(reordered));
check('verify message says unchanged only when ok', /same words/.test(d.verifyMessage(okMove, before)));

const droppedImg = d.takeSnapshot({ html: movedHtml.replace('<img src="g1.png">', '') });
const bad = d.compareSnapshots(before, droppedImg);
check('verify catches a dropped image', !bad.ok && bad.objects.images && bad.objects.images.change === -1, JSON.stringify(bad));
check('verify message names the loss and offers restore', /images: 3 before, 2 now/.test(d.verifyMessage(bad, before)) && /restore/.test(d.verifyMessage(bad, before)) && !/same words/.test(d.verifyMessage(bad, before)));

const retyped = d.takeSnapshot({ text: 'Abstract We measured the spring constant. Methods A mass hung from a spring.', html: '<h1>Abstract</h1><h1>Methods</h1>' });
const lost = d.compareSnapshots(before, retyped);
check('verify catches retyped, shortened text with lost tables and images', !lost.ok && lost.lostWords > 5 && lost.objects.tables && lost.objects.images && lost.objects.equations, JSON.stringify(lost));
check('expected removals are allowed', d.compareSnapshots(before, d.takeSnapshot({ html: HTML.replace('Discussion', '') }), { removedWords: 1, headings: 'any' }).ok);
check('reordered words alone are fine (it is a bag)', d.compareSnapshots(d.takeSnapshot({ text: 'a b c' }), d.takeSnapshot({ text: 'c a b' })).ok);

// destructive check
const snap = d.takeSnapshot({ text: 'word '.repeat(100), html: '<img src=a><img src=b><table></table>' });
check('select-all replace is refused', d.checkAction({ kind: 'type', selection: 'all', removedWords: 100 }, snap).refuse === true);
check('select-all paste is refused', d.checkAction({ kind: 'paste', selection: 'all' }, snap).refuse === true);
check('select-all replace is a confirm card when the user asked for it', d.checkAction({ kind: 'type', selection: 'all', removedWords: 100 }, snap, { userAsked: true }).confirm === true);
const img = d.checkAction({ kind: 'delete', selection: 'range', removedWords: 3, images: 2, tables: 1 }, snap);
check('removing an image or table triggers the card with the plain message', img.confirm === true && img.message === 'This removes 3% of the document (2 images, 1 table). Continue?', img.message);
check('more than 20% triggers the card', d.checkAction({ kind: 'cut', selection: 'range', removedWords: 30 }, snap).confirm === true);
check('a small plain edit passes', d.checkAction({ kind: 'replace', selection: 'range', removedWords: 2 }, snap).allow === true);
check('a section move (cut+paste of the same words) is not destructive', d.checkAction({ kind: 'move', selection: 'range', removedWords: 0 }, snap).allow === true);

// markdown
check('markdown to html', d.markdownToHtml('# Title\n\nSome **bold** and *it* [x](https://a.com)\n\n- one\n- two\n\n1. a') === '<h1>Title</h1><p>Some <b>bold</b> and <i>it</i> <a href="https://a.com">x</a></p><ul><li>one</li><li>two</li></ul><ol><li>a</li></ol>');
check('markdown escapes html', d.markdownToHtml('<script>x</script>') === '<p>&lt;script&gt;x&lt;/script&gt;</p>');

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
