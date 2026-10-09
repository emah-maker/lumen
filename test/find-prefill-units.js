// Ctrl+F starts from the page's selection (features/find-selection.js, the UI's openFind), plain Node.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pageSelection, clean, SCRIPT, MAX } = require('../src/features/find-selection');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);

(async () => {
  // ---- clean
  check('clean: one line, trimmed', clean('  two\n  lines\there ') === 'two lines here');
  check('clean: nothing worth searching for is empty', clean('  \n ') === '' && clean(undefined) === '' && clean(5) === '');
  check('clean: cut at the limit', clean('x'.repeat(MAX + 50)).length === MAX);

  // ---- the script the page runs, against stand-in documents
  const run = (doc, selection = '') => vm.runInNewContext(SCRIPT, { document: doc, getSelection: () => selection });
  check('script: the page selection', run({ activeElement: { tagName: 'BODY' } }, 'hello world') === 'hello world');
  check('script: no selection is empty', run({ activeElement: null }, '') === '');
  check('script: the selection inside a text field', run({ activeElement: { tagName: 'INPUT', type: 'text', value: 'find the needle here', selectionStart: 9, selectionEnd: 15 } }) === 'needle');
  check('script: inside a textarea too', run({ activeElement: { tagName: 'TEXTAREA', value: 'abc def', selectionStart: 4, selectionEnd: 7 } }) === 'def');
  check('script: a password field is never read', run({ activeElement: { tagName: 'INPUT', type: 'password', value: 'hunter2', selectionStart: 0, selectionEnd: 7 } }, '') === '');
  check('script: a huge selection is cut before it leaves the page', run({ activeElement: null }, 'y'.repeat(100000)).length <= MAX * 4);

  // ---- asking the page
  const wc = (fn) => ({ isDestroyed: () => false, executeJavaScript: fn });
  check('pageSelection: the cleaned selection', (await pageSelection(wc(async () => '  some\ntext '))) === 'some text');
  check('pageSelection: nothing selected', (await pageSelection(wc(async () => ''))) === '');
  check('pageSelection: a page that throws opens the bar empty', (await pageSelection(wc(async () => { throw new Error('gone'); }))) === '');
  const t0 = Date.now();
  check('pageSelection: a page that never answers is given up on', (await pageSelection(wc(() => new Promise(() => {})), { wait: 40 })) === '' && Date.now() - t0 < 1000);
  check('pageSelection: no page, or a destroyed one', (await pageSelection(null)) === '' && (await pageSelection({ isDestroyed: () => true, executeJavaScript: async () => 'x' })) === '');

  // ---- the UI's openFind (renderer/app.js) against stand-in elements
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const fn = /function openFind\(opts\) \{[\s\S]*?\n\}\n/.exec(app)?.[0];
  check('openFind is in app.js', Boolean(fn));
  const make = ({ open = false, focused = false, value = '' } = {}) => {
    const log = [];
    const findInput = { value, focus() { log.push('focus'); }, select() { log.push('select'); } };
    const findbar = { hidden: !open, classList: { contains: (c) => c === 'open' && open, add() {}, remove() {} } };
    const ctx = {
      findbar, findInput, findHideTimer: null, clearTimeout() {}, requestAnimationFrame() {}, Number, document: { activeElement: focused ? findInput : null },
      window: { browser: { find: (text, o) => log.push(['find', text, o.findNext]) } }, findStep: (fwd) => log.push(['step', fwd]),
    };
    vm.runInNewContext(`${fn}; this.openFind = openFind;`, ctx);
    return { ctx, findInput, log };
  };
  {
    const { ctx, findInput, log } = make({ value: 'old' });
    ctx.openFind({ text: 'selected words' });
    check('a selection fills the closed bar, selects it and searches for it', findInput.value === 'selected words' && J(log) === J(['focus', 'select', ['find', 'selected words', false]]), J(log));
  }
  {
    const { ctx, findInput, log } = make({ value: 'last search' });
    ctx.openFind();
    check('without a selection the bar keeps the last search', findInput.value === 'last search' && J(log) === J(['focus', 'select', ['find', 'last search', false]]), J(log));
  }
  {
    const { ctx, findInput } = make({ open: true, focused: true, value: 'typing' });
    ctx.openFind({ text: 'stale selection' });
    check('Ctrl+F while typing in the bar leaves what was typed', findInput.value === 'typing', findInput.value);
  }
  {
    const { ctx, findInput } = make({ open: true, focused: false, value: 'old' });
    ctx.openFind({ text: 'new pick' });
    check('an open bar the page has the focus over takes the new selection', findInput.value === 'new pick', findInput.value);
  }
  {
    const { ctx, findInput, log } = make({ open: true, value: 'abc' });
    ctx.openFind({ step: 1, text: 'ignored' });
    check('F3 steps to the next match and ignores any text', findInput.value === 'abc' && J(log) === J([['step', true]]), J(log));
  }

  // ---- main wires every Find entry to it
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  check('Ctrl+F, the Edit menu and the macOS View menu all go through openFindBar', (main.match(/openFindBar/g) || []).length >= 4 && !/send\('find:open'\); \}/.test(main), String((main.match(/openFindBar/g) || []).length));

  process.exit(failures ? 1 : 0);
})();
