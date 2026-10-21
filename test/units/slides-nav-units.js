// The slide viewer's slide numbering (renderer/slides-nav.js), plain Node: the slide-number box, the #slide=N fragment, the navigation keys.
const N = require('../../src/renderer/slides-nav');
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = JSON.stringify;
const eq = (label, got, want) => check(label, J(got) === J(want), `${J(got)} != ${J(want)}`);

// the number box
eq('"3" is slide 3', N.parseSlideNumber('3', 24), 3);
eq('spaces around the number are ignored', N.parseSlideNumber('  7 ', 24), 7);
eq('"3 / 24" (what the box and its total read) is slide 3', N.parseSlideNumber('3 / 24', 24), 3);
eq('0 goes to the first slide', N.parseSlideNumber('0', 24), 1);
eq('a number past the end goes to the last slide', N.parseSlideNumber('999', 24), 24);
eq('a huge number is clamped, not an overflow', N.parseSlideNumber('99999999999999', 24), 24);
eq('empty is not a number', N.parseSlideNumber('', 24), null);
eq('words are not a number', N.parseSlideNumber('abc', 24), null);
eq('a negative number is not a slide', N.parseSlideNumber('-2', 24), null);
eq('a decimal is not a slide', N.parseSlideNumber('2.5', 24), null);
eq('null and undefined are not numbers', [N.parseSlideNumber(null, 24), N.parseSlideNumber(undefined, 24)], [null, null]);
eq('a deck with no slides has nothing to go to', N.parseSlideNumber('1', 0), null);
eq('a one-slide deck always goes to 1', N.parseSlideNumber('5', 1), 1);

// the fragment
eq('#slide=7 is index 6', N.slideFromHash('#slide=7'), 6);
eq('the fragment without # works', N.slideFromHash('slide=2'), 1);
eq('other parameters beside it are fine', N.slideFromHash('#foo=1&slide=4'), 3);
eq('slide=0 is no slide', N.slideFromHash('#slide=0'), null);
eq('slide=x is no slide', N.slideFromHash('#slide=x'), null);
eq('slide=-3 is no slide', N.slideFromHash('#slide=-3'), null);
eq('an empty fragment is no slide', N.slideFromHash(''), null);
const viewer = 'file:///C:/app/src/renderer/slides.html?u=' + encodeURIComponent('file:///C:/docs/deck.pptx');
eq('a viewer address with no fragment asks for nothing', N.slideFromUrl(viewer), null);
eq('a viewer address with #slide=5', N.slideFromUrl(viewer + '#slide=5'), 4);
eq('a deck address that carried #slide=9 (typed in the bar)', N.slideFromUrl('file:///C:/app/slides.html?u=' + encodeURIComponent('file:///C:/docs/deck.pptx#slide=9')), 8);
eq('the viewer fragment beats the deck one', N.slideFromUrl('file:///C:/app/slides.html?u=' + encodeURIComponent('file:///d.pptx#slide=9') + '#slide=2'), 1);
eq('not an address', N.slideFromUrl('nonsense'), null);
check('writing slide 5 puts #slide=5 on the address and keeps the rest', N.withSlide(viewer, 4) === viewer + '#slide=5', N.withSlide(viewer, 4));
check('writing slide 1 leaves no fragment', N.withSlide(viewer + '#slide=5', 0) === viewer, N.withSlide(viewer + '#slide=5', 0));
check('other fragment parameters stay', N.withSlide(viewer + '#foo=1&slide=3', 7) === viewer + '#foo=1&slide=8', N.withSlide(viewer + '#foo=1&slide=3', 7));
check('writing then reading gives the slide back', N.slideFromUrl(N.withSlide(viewer, 12)) === 12);

// keys
eq('PageDown goes on', N.slideForKey('PageDown', 3, 10, false), 4);
eq('PageUp goes back', N.slideForKey('PageUp', 3, 10, false), 2);
eq('ArrowRight and ArrowDown go on', [N.slideForKey('ArrowRight', 0, 10, false), N.slideForKey('ArrowDown', 0, 10, false)], [1, 1]);
eq('ArrowLeft and ArrowUp go back', [N.slideForKey('ArrowLeft', 5, 10, false), N.slideForKey('ArrowUp', 5, 10, false)], [4, 4]);
eq('Home is the first slide', N.slideForKey('Home', 6, 10, false), 0);
eq('End is the last slide', N.slideForKey('End', 2, 10, false), 9);
eq('going back stops at the first slide', N.slideForKey('PageUp', 0, 10, false), 0);
eq('going on stops at the last slide', N.slideForKey('PageDown', 9, 10, false), 9);
eq('Space goes on, Shift+Space goes back', [N.slideForKey(' ', 2, 10, false), N.slideForKey(' ', 2, 10, true)], [3, 1]);
eq('other keys are not navigation', [N.slideForKey('a', 2, 10, false), N.slideForKey('Enter', 2, 10, false), N.slideForKey('F4', 2, 10, false)], [null, null, null]);

// the page uses it (slides.html loads the module before slides.js, and slides.js no longer carries its own key table)
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'slides.html'), 'utf8');
check('slides.html loads slides-nav.js before slides.js', html.indexOf('slides-nav.js') > 0 && html.indexOf('slides-nav.js') < html.indexOf('slides.js"'));
check('the toolbar has the number box, the total, previous, next and the thumbnails button', ['id="slideNumber"', 'id="slideCount"', 'id="prev"', 'id="next"', 'id="thumbsBtn"', 'id="thumbs"'].every((s) => html.includes(s)));
check('the controls have accessible names', /id="slideNumber"[^>]*aria-label="Slide number"/.test(html) && /id="thumbsBtn"[^>]*aria-label=/.test(html) && /id="thumbs" aria-label=/.test(html));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
