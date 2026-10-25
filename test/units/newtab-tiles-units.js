// The new-tab page's removed tiles (settings newTabHiddenTiles): the list is checked, deduped, lower-cased and bounded before it is saved.
const { cleanHiddenTiles, validate, DEFAULTS } = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check('default is empty', same(DEFAULTS.newTabHiddenTiles, { favorites: [], frequent: [] }));
check('non-objects are refused', cleanHiddenTiles(null) === null && cleanHiddenTiles('x') === null);
const c = cleanHiddenTiles({ favorites: ['https://a.test/', 'https://a.test/', 'javascript:alert(1)', 5, 'http://b.test/x'], frequent: ['Example.COM', 'bad host', 'example.com', 7] });
check('favorites: web URLs only, deduped', same(c.favorites, ['https://a.test/', 'http://b.test/x']), JSON.stringify(c));
check('frequent: hosts, lower-cased', same(c.frequent, ['example.com']), JSON.stringify(c));
check('a missing list is empty', same(cleanHiddenTiles({}), { favorites: [], frequent: [] }));
check('lists are capped', cleanHiddenTiles({ frequent: Array.from({ length: 900 }, (_, i) => `h${i}.test`) }).frequent.length === 500);
check('validate() uses it', same(validate('newTabHiddenTiles', { favorites: ['https://a.test/'] }), { favorites: ['https://a.test/'], frequent: [] }));
process.exit(failures ? 1 : 0);
