// The colour a tab's view draws behind its page (browser/page-background.js): white for a web page, the theme's for Lumen's own pages, unchanged for
// anything else. (A site with no background of its own showed its dark text on Lumen's #1c1c1e in a tab that had started as the New Tab page.)
const assert = require('assert');
const { WEB_PAGE, backgroundFor } = require('../../src/browser/page-background');

const own = (u) => u.startsWith('file:///app/renderer/');
const dark = () => '#1c1c1e';
const opts = { internal: own, theme: dark };
assert.strictEqual(WEB_PAGE, '#ffffff');
assert.strictEqual(backgroundFor('https://www.thenorthface.com/en-us/mens', opts), '#ffffff', 'a web page: white, as in Chrome');
assert.strictEqual(backgroundFor('http://127.0.0.1:8080/', opts), '#ffffff');
assert.strictEqual(backgroundFor('file:///C:/Users/me/page.html', opts), '#ffffff', "a file the user opened is a web page, not one of Lumen's");
assert.strictEqual(backgroundFor('data:text/html,<p>x', opts), '#ffffff');
assert.strictEqual(backgroundFor('file:///app/renderer/newtab.html', opts), '#1c1c1e', "Lumen's own page: the theme's colour");
assert.strictEqual(backgroundFor('file:///app/renderer/error.html?u=x', opts), '#1c1c1e', "an error page is Lumen's");
assert.strictEqual(backgroundFor('chrome-extension://abc/popup.html', opts), null, 'an extension page: left as it is');
assert.strictEqual(backgroundFor('about:blank', opts), null);
assert.strictEqual(backgroundFor('', opts), null);
assert.strictEqual(backgroundFor(undefined, opts), null);
assert.strictEqual(backgroundFor('HTTPS://EXAMPLE.COM/'), '#ffffff', 'scheme case does not matter');
console.log('page-background units: all passed');
