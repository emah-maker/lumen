// Marks the page it runs on, so test/extensions.js can see the content script ran (and, after the extension is removed, that it did not).
document.documentElement.setAttribute('data-lumen-fixture', 'ran');
