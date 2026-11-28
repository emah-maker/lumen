// [select boxes] src/ai/select-boxes.js without a page: the option matcher, the error's option list, the page scripts as scripts, and the
// steps fill_form takes on a custom dropdown (open, look, type, scroll, click, read back) against a fake agent and page.
// Their page behavior on every kind of box: test/e2e/select-boxes.js.
const SB = require('../../src/ai/select-boxes');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const opts = (...texts) => texts.map((text) => ({ text }));

(async () => {
  // ---- matchOption
  const m = SB.matchOption;
  check('exact text wins, whatever the case and spaces', m(opts('Green', 'green tea'), '  GREEN ') === 0);
  check('an option\'s value matches too', m([{ text: 'United States', value: 'US' }, { text: 'Uganda', value: 'UG' }], 'us') === 0);
  check('accents and punctuation aside', m(opts('Côte d’Ivoire', 'Cuba'), 'cote divoire') === 0 && m(opts('Chicago O’Hare (ORD)'), "chicago o'hare (ord)") === 0);
  check('a prefix: the shortest option', m(opts('Iraq', 'Iran', 'Ira Hayes Memorial'), 'ira') === 0);
  check('a word inside the option', m(opts('United States', 'United Kingdom'), 'kingdom') === 1);
  check('a word start beats a substring elsewhere', m(opts('Pineapple', 'Apple pie'), 'apple') === 1);
  check('"Uruguay" picks Uruguay, not Uruguay River before it', m(opts('Uruguay River', 'Uruguay'), 'Uruguay') === 1);
  check('nothing like it: -1', m(opts('Red', 'Green'), 'Purple') === -1 && m(opts('Red'), '') === -1 && m(opts('Red'), '!!!') === -1);
  check('exactOnly: no prefix or substring match', m(opts('Uruguay River'), 'Uruguay', true) === -1 && m(opts('Uruguay'), 'uruguay', true) === 0);
  check('self-contained (it runs inside page scripts)', (() => { try { return new Function(`const f = ${m.toString()}; return f([{ text: 'A b' }], 'a  B');`)() === 0; } catch (e) { return e.message; } })() === true);

  // ---- optionList
  check('the error\'s list quotes each option once', SB.optionList(['Red', 'Green', 'Red', ' ']) === '"Red", "Green"');
  check('a long list says how many more', /… and 70 more$/.test(SB.optionList(Array.from({ length: 100 }, (_, i) => `Place ${i}`))));
  check('an empty list says so', SB.optionList([]) === '(no options were shown)');

  // ---- the page scripts parse (ids and text are numbers or JSON)
  const parse = (code) => { try { new Function(code); return true; } catch (e) { return e.message; } };
  const evil = '"); alert(1); ("\'`${x}';
  for (const [name, code] of [['selectInfo', SB.selectInfo(3)], ['chooseNative', SB.chooseNative(3, evil)], ['nativeOptions', SB.nativeOptions(3)], ['scanList', SB.scanList(3, evil, 'top', true)],
    ['scanList (the open list)', SB.scanList(null, evil, 'next')], ['searchField', SB.searchField(3)], ['fieldShows', SB.fieldShows(3, evil)], ['findNativeOption', SB.findNativeOption(evil)], ['OPEN_BOX', SB.OPEN_BOX], ['scrollOpenList', SB.scrollOpenList(-1)]]) {
    check(`${name} is a valid script`, parse(code) === true, parse(code));
  }
  check('an id is a number in the script, never text', SB.selectInfo('1); alert(1') .includes('entryFor(NaN)'));

  // ---- fill_form on a custom box, against a fake agent: elementRun answers by which script it was given
  const fakeAgent = (page) => {
    const calls = [];
    const agent = {
      calls,
      pointAt: () => {},
      stopCheck: () => {},
      async elementRun(_wc, id, make) {
        const code = make(id);
        if (code.includes("kind: 'native'")) return page.info;
        if (code.includes("'no-option'")) return page.native?.();
        if (code.includes('whole: !scroller')) { const step = /const step = "(\w*)"/.exec(code)[1]; const want = /const want = ("(?:[^"\\]|\\.)*")/.exec(code); return page.scan(step, want ? JSON.parse(want[1]) : '', code.includes(', true) : -1')); }
        if (code.includes('register(field')) return page.field ?? null;
        if (code.includes('shows: current')) return page.shows();
        throw new Error(`unexpected script: ${code.slice(0, 80)}`);
      },
      async execute(name, input) { calls.push([name, input]); return page.onTool?.(name, input) ?? 'ok'; },
    };
    return agent;
  };
  // a list of 100 rows, 10 in view at a time; open after a click
  const longList = (rows, { field = null, filter = false } = {}) => {
    const page = { open: false, top: 0, typed: '', chosen: '', field, info: { kind: 'custom', editable: Boolean(field), freeText: false, expanded: false, current: '' } };
    const view = () => { const list = filter && page.typed ? rows.filter((r) => r.toLowerCase().includes(page.typed.toLowerCase())) : rows; return list.slice(page.top, page.top + 10); };
    page.scan = (step, want, exactOnly) => {
      if (!page.open) return { list: false, options: [], match: null, atEnd: true, loading: false };
      if (step === 'top') page.top = 0; else if (step === 'next') page.top += 10;
      const options = view();
      const k = want ? SB.matchOption(options.map((text) => ({ text })), want, exactOnly) : -1;
      return { list: true, options, match: k >= 0 ? { id: 500 + page.top + k, text: options[k] } : null, atEnd: page.top + 10 >= rows.length, loading: false, whole: rows.length <= 10 };
    };
    page.shows = () => ({ shows: Boolean(page.chosen), current: page.chosen });
    page.onTool = (name, input) => {
      if (name === 'click' && input.element_id === 7) page.open = true;
      if (name === 'click' && input.element_id >= 500) { page.chosen = page.lastMatch; page.open = false; }
      if (name === 'type_text') page.typed = input.text;
      if (name === 'press_key') page.open = false;
    };
    const scan = page.scan;
    page.scan = (...a) => { const r = scan(...a); if (r.match) page.lastMatch = r.match.text; return r; };
    return page;
  };
  const rows = Array.from({ length: 100 }, (_, i) => `Place ${String(i).padStart(3, '0')}`);
  rows[95] = 'Uruguay'; rows[60] = 'Uruguay River';

  let page = longList(rows);
  let agent = fakeAgent(page);
  let out = await SB.choose(agent, null, 7, 'Uruguay', '“Country”');
  check('a long list: opened with a click, scrolled to the option, clicked, read back', out === 'chose "Uruguay"' && agent.calls[0][0] === 'click' && agent.calls[0][1].element_id === 7 && agent.calls.at(-1)[0] === 'click' && agent.calls.at(-1)[1].element_id === 595, JSON.stringify({ out, calls: agent.calls }));

  page = longList(rows);
  agent = fakeAgent(page);
  out = await SB.choose(agent, null, 7, 'place 04', '“Country”');
  check('no exact match while scrolling: the best one of all the rows seen', out === 'chose "Place 040"', out);

  page = longList(rows);
  agent = fakeAgent(page);
  let err = await SB.choose(agent, null, 7, 'Atlantis', '“Country”').catch((e) => e.message);
  check('a value that is not there: an error naming the options, and the list closed', /“Country” has no option matching "Atlantis"\. Its options: "Place 000", "Place 001"/.test(err) && agent.calls.some(([n, i]) => n === 'press_key' && i.key === 'Escape'), err);
  check('…the options it names are the whole list, scrolled through (30 shown, then how many more)', /and 70 more/.test(err), err);

  page = longList(['Apple', 'Banana', 'Cherry'], { field: 9, filter: true });
  page.info.editable = true;
  agent = fakeAgent(page);
  err = await SB.choose(agent, null, 7, 'Durian', '“Fruit”').catch((e) => e.message);
  check('a box that filters as you type: the value is typed into its field', agent.calls.some(([n, i]) => n === 'type_text' && i.element_id === 9 && i.text === 'Durian'), JSON.stringify(agent.calls));
  check('…and when nothing is left, the error names the options it showed', /no option matching "Durian"\. Options it showed: "Apple", "Banana", "Cherry"/.test(err), err);

  page = longList(['1 Elm Street', '22 Oak Avenue'], { field: 9, filter: true });
  page.info = { ...page.info, editable: true, freeText: true };
  page.shows = () => ({ shows: true, current: '12 Main St' });
  agent = fakeAgent(page);
  out = await SB.choose(agent, null, 7, '12 Main St', '“Street”');
  check('a free-text field with suggestions: what was typed stays, no error', /^typed "12 Main St"/.test(out), out);

  page = longList(['Small', 'Large']);
  page.shows = () => ({ shows: false, current: 'Pick a size' });
  agent = fakeAgent(page);
  err = await SB.choose(agent, null, 7, 'Large', '“Size”').catch((e) => e.message);
  check('the field does not show the option after the click: said so, with what it shows', /does not show it \(it shows "Pick a size"\)/.test(err), err);

  page = { info: { kind: 'custom', editable: false, expanded: false }, scan: () => ({ list: false, options: [], match: null, atEnd: true }), shows: () => null };
  agent = fakeAgent(page);
  err = await SB.choose(agent, null, 7, 'x', '“Box”').catch((e) => e.message);
  check('a box that opens no list: said so, after a second click', /did not open a list/.test(err) && agent.calls.filter(([n]) => n === 'click').length === 2, err);

  page = { info: { kind: 'native', options: ['Red', 'Green'] }, native: () => ({ error: 'no-option', options: ['Red', 'Green'] }) };
  err = await SB.choose(fakeAgent(page), null, 3, 'Purple', '“Color”').catch((e) => e.message);
  check('a native select without the value: the error names its options', err === '“Color” has no option matching "Purple". Its options: "Red", "Green".', err);
  page = { info: { kind: 'native', options: ['Red', 'Green'] }, native: () => ({ shown: 'Green' }) };
  check('a native select: set directly', await SB.choose(fakeAgent(page), null, 3, 'green', '“Color”') === 'chose "Green"');
  check('not a dropdown: null (fill_form types into it)', await SB.choose(fakeAgent({ info: { kind: 'other' } }), null, 3, 'x', 'x') === null);

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
