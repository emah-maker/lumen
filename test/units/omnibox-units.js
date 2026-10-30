// The address bar's decisions, as in Chrome (src/browser/omnibox.js and src/renderer/chrome-helpers.js): what counts as a URL,
// when a site is completed in place, what Enter and Ctrl+Enter go to. Pure logic, no Electron.
const assert = require('assert');
const { classify, siteOf, inlineCompletion, ctrlEnterInput } = require('../../src/browser/omnibox');
const { mayInlineComplete, extendInline, enterAction, rowValue } = require('../../src/renderer/chrome-helpers');

// ---- what counts as a URL: everything else is searched exactly as typed with the default engine
for (const text of ['github.com', 'example.com/path?q=1', 'https://a.example/x', 'localhost:3000', 'localhost', '127.0.0.1:8080', '[::1]:5173', 'intranet:8080', 'sub.domain.co.uk', 'about:blank']) {
  assert.strictEqual(classify(text, 'google').kind, 'url', `${text} opens`);
}
for (const text of ['weather', 'teh weathr tomorow', 'node.js', 'notes.txt', 'what is 3.5', 'c++', 'Recieve', 'javascript:alert(1)', 'github', 'youtube music']) {
  const c = classify(text, 'google');
  assert.strictEqual(c.kind, 'search', `${text} is searched`);
  assert.strictEqual(c.url, 'https://www.google.com/search?q=' + encodeURIComponent(text.trim()), `${text} is searched exactly as typed (no "did you mean", nothing rewritten)`);
}
assert.strictEqual(classify('  spaced words  ', 'duckduckgo').url, 'https://duckduckgo.com/?q=spaced%20words', 'the default engine, the text only trimmed');
assert.strictEqual(classify('Teh Quick', 'bing').url, 'https://www.bing.com/search?q=Teh%20Quick', 'case and spelling are kept');

// ---- the site a visit counts for
assert.strictEqual(siteOf('https://www.GitHub.com/x'), 'github.com');
assert.strictEqual(siteOf('http://localhost:3000/a'), 'localhost:3000');
assert.strictEqual(siteOf('file:///c:/x.html'), '');
assert.strictEqual(siteOf('not a url'), '');

// ---- inline completion: only from a site typed before
const now = Date.now();
const entries = [
  { url: 'https://github.com/', title: 'GitHub', visits: 9, last: now, typed: 3 },
  { url: 'https://github.com/lumen/issues', title: 'Issues', visits: 4, last: now },
  { url: 'https://www.youtube.com/', title: 'YouTube', visits: 50, last: now }, // visited a lot, never typed (clicked, imported)
  { url: 'https://gitlab.com/', title: 'GitLab', visits: 1, last: now - 1000, typed: 1 },
  { url: 'http://localhost:3000/app', title: 'Dev', visits: 2, last: now, typed: 1 },
];
assert.deepStrictEqual(inlineCompletion('git', entries), { text: 'github.com', url: 'https://github.com/' }, 'the site typed most wins, its host completed');
assert.deepStrictEqual(inlineCompletion('gitl', entries), { text: 'gitlab.com', url: 'https://gitlab.com/' });
assert.strictEqual(inlineCompletion('you', entries), null, 'a site never typed is never completed in place, however often it was visited');
assert.strictEqual(inlineCompletion('y', [{ url: 'https://www.youtube.com/', title: 'YouTube', visits: 0, last: 0 }]), null, 'a built-in suggestion never fills the field');
assert.strictEqual(inlineCompletion('git', entries.map((e) => ({ ...e, typed: 0 }))), null, 'nothing typed, nothing completed');
assert.strictEqual(inlineCompletion('GIT', entries).text, 'GIThub.com', 'what was typed stays as typed; only the rest is added');
assert.deepStrictEqual(inlineCompletion('www.git', entries), { text: 'www.github.com', url: 'https://github.com/' }, 'a typed www. is kept');
assert.deepStrictEqual(inlineCompletion('https://git', entries), { text: 'https://github.com', url: 'https://github.com/' });
assert.deepStrictEqual(inlineCompletion('github.com/lu', entries), { text: 'github.com/lumen/issues', url: 'https://github.com/lumen/issues' }, 'with a / a page on a typed site is completed');
assert.deepStrictEqual(inlineCompletion('loc', entries), { text: 'localhost:3000', url: 'http://localhost:3000/' }, 'http stays http');
assert.strictEqual(inlineCompletion('github.com', entries), null, 'nothing left to add');
assert.strictEqual(inlineCompletion('git hub', entries), null, 'words with a space are a search');
assert.strictEqual(inlineCompletion('hub', entries), null, 'only a prefix of the site completes, never a match in the middle');
assert.strictEqual(inlineCompletion('', entries), null);
assert.strictEqual(inlineCompletion('www.', entries), null);
assert.strictEqual(inlineCompletion('git', null), null);
assert.deepStrictEqual(inlineCompletion('git', new Map(entries.map((e) => [e.url, e])).values()), { text: 'github.com', url: 'https://github.com/' }, 'History as main.js holds it (an iterator of its Map)');

// ---- when a completion may go into the field
const at = (value, extra = {}) => ({ value, typed: value, selectionStart: value.length, selectionEnd: value.length, inputType: 'insertText', ...extra });
assert.strictEqual(mayInlineComplete(at('git')), true, 'typing forward with the caret at the end');
assert.strictEqual(mayInlineComplete(at('git', { inputType: 'deleteContentBackward' })), false, 'Backspace removes the completion and does not bring it back');
assert.strictEqual(mayInlineComplete(at('git', { inputType: 'deleteContentForward' })), false, 'Delete too');
assert.strictEqual(mayInlineComplete(at('git', { inputType: 'insertFromPaste' })), false, 'a paste is opened as pasted');
assert.strictEqual(mayInlineComplete(at('git', { composing: true })), false, 'not mid-composition');
assert.strictEqual(mayInlineComplete(at('git', { selectionStart: 1, selectionEnd: 1 })), false, 'not with the caret in the middle');
assert.strictEqual(mayInlineComplete(at('gith', { typed: 'git' })), false, 'not when the field moved on since the list was asked for');
assert.strictEqual(mayInlineComplete(at('git hub')), false, 'not for words');
assert.strictEqual(mayInlineComplete(at('   ')), false);

// ---- typing the next letter of a completion keeps it
const inl = { text: 'github.com', url: 'https://github.com/' };
assert.deepStrictEqual(extendInline(inl, 'gith', 'insertText'), { text: 'github.com', url: 'https://github.com/' });
assert.deepStrictEqual(extendInline(inl, 'GITH', 'insertText'), { text: 'GITHub.com', url: 'https://github.com/' });
assert.strictEqual(extendInline(inl, 'gitx', 'insertText'), null, 'a letter that does not match drops it');
assert.strictEqual(extendInline(inl, 'gi', 'deleteContentBackward'), null, 'Backspace never keeps it');
assert.strictEqual(extendInline(inl, 'github.com', 'insertText'), null, 'all typed: nothing left to complete');
assert.strictEqual(extendInline(inl, 'gith', 'insertText', false), null);
assert.strictEqual(extendInline(null, 'g', 'insertText'), null);

// ---- Enter goes to exactly what the field shows
const items = [{ kind: 'search', title: 'page', go: 'https://s/?q=page' }, { kind: 'history', title: 'Page b', go: 'https://b.example/' }, { kind: 'tab', title: 'T', go: 'https://t.example/', tabId: 4 }];
assert.deepStrictEqual(enterAction({ value: 'page', inline: null, items, selected: 0 }), { go: 'page' }, 'plain words: searched, never a history page that matches them');
assert.deepStrictEqual(enterAction({ value: ' page ', inline: null, items: [], selected: 0 }), { go: 'page' });
assert.deepStrictEqual(enterAction({ value: 'https://b.example/', inline: null, items, selected: 1 }), { item: items[1] }, 'a row the arrow keys picked');
assert.deepStrictEqual(enterAction({ value: 'https://t.example/', inline: null, items, selected: 2 }), { item: items[2] }, 'a Switch to tab row');
assert.deepStrictEqual(enterAction({ value: 'pagex', inline: null, items, selected: 1 }), { go: 'pagex' }, 'a row from a list for older text is not used once the field changed');
assert.deepStrictEqual(enterAction({ value: 'github.com', inline: inl, items, selected: 0 }), { go: 'https://github.com/' }, 'the completion while it is showing');
assert.deepStrictEqual(enterAction({ value: 'git', inline: inl, items, selected: 0 }), { go: 'git' }, 'after Backspace took the completion away: what is left');
assert.deepStrictEqual(enterAction({ value: 'github.co', inline: inl, items: [], selected: 0 }), { go: 'github.co' });
assert.strictEqual(rowValue(items[0]), 'page');
assert.strictEqual(rowValue(items[1]), 'https://b.example/');

// ---- Ctrl+Enter: www. and .com
for (const [typed, want] of [['example', 'www.example.com'], ['Example', 'www.Example.com'], ['example/a?b=1', 'www.example.com/a?b=1'], ['example:8080/x', 'www.example.com:8080/x'], ['www.example', 'www.example.com'], ['example.com', 'www.example.com'], ['example.co.uk', 'www.example.co.uk'], ['node.js', 'www.node.js.com'], ['  example  ', 'www.example.com']]) {
  assert.strictEqual(ctrlEnterInput(typed), want, `Ctrl+Enter on ${typed}`);
}
for (const typed of ['two words', 'https://example', '']) assert.strictEqual(ctrlEnterInput(typed), typed.trim(), `Ctrl+Enter leaves ${typed || '(empty)'} alone`);
assert.strictEqual(classify(ctrlEnterInput('example'), 'google').url, 'https://www.example.com', 'and it opens as an address');

console.log('omnibox-units: ok');
