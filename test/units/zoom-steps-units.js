// Page zoom walks Chrome's stops (features/zoom-steps.js), plain Node.
const { STOPS, nextLevel, levelOf, percentOf, zoomKeyStep } = require('../../src/features/zoom-steps');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const pct = (level) => Math.round(percentOf(level));

check('stops are Chrome\'s list', STOPS.join() === '25,33,50,67,75,80,90,100,110,125,150,175,200,250,300,400,500');
check('100% is level 0', Math.abs(levelOf(100)) < 1e-9);

let level = 0;
const up = [];
for (let i = 0; i < 20; i++) { level = nextLevel(level, 1); up.push(pct(level)); }
check('zooming in from 100% visits each stop and stops at 500%', up.slice(0, 10).join() === '110,125,150,175,200,250,300,400,500,500' && up[19] === 500, up.join());

level = 0;
const down = [];
for (let i = 0; i < 20; i++) { level = nextLevel(level, -1); down.push(pct(level)); }
check('zooming out from 100% visits each stop and stops at 25%', down.slice(0, 8).join() === '90,80,75,67,50,33,25,25' && down[19] === 25, down.join());

check('in then out returns to 100%', pct(nextLevel(nextLevel(0, 1), -1)) === 100);
check('an odd level (106%, 120%) snaps to the next stop beyond it', pct(nextLevel(0.3, 1)) === 110 && pct(nextLevel(0.3, -1)) === 100 && pct(nextLevel(1, 1)) === 125 && pct(nextLevel(1, -1)) === 110, `${pct(nextLevel(0.3, 1))} ${pct(nextLevel(1, 1))}`);
check('a default zoom of 125% steps to 150% / 110%', pct(nextLevel(levelOf(125), 1)) === 150 && pct(nextLevel(levelOf(125), -1)) === 110);
check('rounding noise on a stop still counts as being on it', pct(nextLevel(levelOf(100) + 1e-6, 1)) === 110);
check('a bad level is treated as 100%', pct(nextLevel(NaN, 1)) === 110 && pct(nextLevel(undefined, -1)) === 90);
check('every stop fits the remembered-zoom range', STOPS.every((p) => levelOf(p) >= -8 && levelOf(p) <= 9));

// ---- main.js: every zoom path (keys, menus, Ctrl+wheel, the AI's zoom tools) goes through zoomPage, which walks the stops
const main = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
check('zoomPage takes the next stop, not a fixed level step', /zoomSteps\.nextLevel\(wc\.getZoomLevel\(\), step\)/.test(main) && !/getZoomLevel\(\) \+ step/.test(main));
check('the remembered level (per-site zoom) is the stop\'s level, and Ctrl+0 still resets', /noteUserZoom\(wc, level\)[\s\S]{0,150}wc\.setZoomLevel\(level\)/.test(main) && /if \(step === 0\) settingsBackend\.resetZoom\(wc\)/.test(main));
check('Ctrl+wheel (zoom-changed) goes through the same stops; pinch zoom (visual zoom limits) is left alone', /zoom-changed[\s\S]{0,80}zoomBy\(wc,/.test(main) && !/setVisualZoomLevelLimits/.test(main.slice(main.indexOf('function zoomPage'), main.indexOf('function zoomPage') + 800)));
{
  // The percentage the pill shows (Math.round(wc.getZoomFactor() * 100)) is a whole stop at every step.
  let level = 0;
  const shown = [];
  for (let i = 0; i < 8; i++) { level = nextLevel(level, 1); shown.push(Math.round(1.2 ** level * 100)); }
  check('the zoom pill shows exactly the stops', shown.join() === '110,125,150,175,200,250,300,400', shown.join());
}

// Which key presses are zoom keys (features/zoom-steps.js zoomKeyStep)
check('zoom keys: = and + zoom in, - zooms out, 0 resets', zoomKeyStep({ key: '=' }) === 0.5 && zoomKeyStep({ key: '+' }) === 0.5 && zoomKeyStep({ key: '-' }) === -0.5 && zoomKeyStep({ key: '0' }) === 0);
check('zoom keys: the numpad keys (key or code) work', zoomKeyStep({ key: '-', code: 'NumpadSubtract' }) === -0.5 && zoomKeyStep({ key: '+', code: 'NumpadAdd' }) === 0.5 && zoomKeyStep({ key: '', code: 'NumpadSubtract' }) === -0.5 && zoomKeyStep({ key: 'Subtract', code: 'NumpadSubtract' }) === -0.5 && zoomKeyStep({ key: '', code: 'Numpad0' }) === 0);
check('zoom keys: the physical Minus / Equal key counts when the layout reports another symbol', zoomKeyStep({ key: '–', code: 'Minus' }) === -0.5 && zoomKeyStep({ key: 'é', code: 'Equal' }) === 0.5);
check('zoom keys: letters and digits on those physical keys are not zoom keys', zoomKeyStep({ key: 'a', code: 'Minus' }) === null && zoomKeyStep({ key: '6', code: 'Equal' }) === null);
check('zoom keys: other keys and bad input give null', zoomKeyStep({ key: 'a', code: 'KeyA' }) === null && zoomKeyStep({}) === null && zoomKeyStep(null) === null && zoomKeyStep({ key: '__proto__' }) === null);

process.exit(failures ? 1 : 0);
