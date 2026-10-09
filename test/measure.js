// Measures how many tokens (chars / 4) and tool calls four real browsing tasks cost, with the
// classic tools (read_page full) and with the efficient ones (compact read_page, find, batch).
// Needs internet. Usage: node test/measure.js [baseline|efficient|both]
const { _electron: electron } = require('playwright-core');
const path = require('path');

const which = process.argv[2] || 'both';

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  let calls = 0;
  let chars = 0;
  const run = async (name, input) => {
    const r = await app.evaluate(async (_e, [n, i]) => {
      try {
        const out = await global.__agent.execute(n, i);
        if (typeof out === 'string') return out;
        // Images: count the base64 payload as a vision cost estimate (w*h/750 tokens -> chars).
        return out.map((b) => (b.type === 'text' ? b.text : `[image ${b.source.data.length}b]`)).join('\n');
      } catch (err) { return `ERROR: ${err.message}`; }
    }, [name, input]);
    calls++;
    chars += r.length;
    if (process.env.MEASURE_VERBOSE) console.log(`--- ${name} ${JSON.stringify(input)}\n${r.slice(0, 1500)}`);
    return r;
  };
  const toolDefs = await app.evaluate(() => JSON.stringify(process.mainModule.require('./ai/agent').EXTERNAL_TOOLS || []).length).catch(() => 0);
  const idOf = (page, pred) => JSON.parse(page.split('\n')[1]).elements.find(pred)?.id;
  const ref = (text, re) => Number((re.exec(text) || [])[1]);

  const tasks = {
    'Wikipedia search + read': {
      async baseline() {
        await run('navigate', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
        const page = await run('read_page', { elements: true });
        const box = idOf(page, (e) => /search/i.test(e.label) && e.tag === 'input');
        await run('type_text', { element_id: box, text: 'Alan Turing', press_enter: true });
        return (await run('read_page', {})).includes('23 June 1912');
      },
      async efficient() {
        await run('navigate', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
        const found = await run('find', { query: 'Search Wikipedia', max: 3 });
        const box = ref(found, /\[(\d+)\] input/);
        await run('batch', { steps: [{ do: 'type', ref: box, text: 'Alan Turing', enter: true }] });
        return (await run('find', { query: 'Born', max: 2 })).includes('23 June 1912');
      },
    },
    'httpbin form': {
      async baseline() {
        await run('navigate', { url: 'https://httpbin.org/forms/post' });
        await run('read_page', {});
        await run('fill_form', {
          fields: [{ label: 'Customer name', value: 'Ada' }, { label: 'Telephone', value: '555' }, { label: 'E-mail address', value: 'a@b.co' },
            { label: 'Pizza Size', value: 'Medium' }, { label: 'Bacon', value: 'true' }, { label: 'Delivery instructions', value: 'Ring' }],
          submit: true,
        });
        return (await run('read_page', {})).includes('"custname": "Ada"');
      },
      async efficient() {
        await run('navigate', { url: 'https://httpbin.org/forms/post' });
        const page = await run('read_page', { mode: 'compact' });
        const r = (label) => ref(page, new RegExp(`\\[(\\d+)\\] [a-z]+ "${label}`, 'i'));
        const out = await run('batch', { steps: [
          { do: 'type', ref: r('Customer name'), text: 'Ada' }, { do: 'type', ref: r('Telephone'), text: '555' },
          { do: 'type', ref: r('E-mail'), text: 'a@b.co' }, { do: 'click', ref: r('Medium') }, { do: 'click', ref: r('Bacon') },
          { do: 'type', ref: r('Delivery instructions'), text: 'Ring' }, { do: 'click', ref: r('Submit order') },
        ] });
        return out.includes('"custname": "Ada"');
      },
    },
    'DuckDuckGo search': {
      async baseline() {
        await run('navigate', { url: 'https://duckduckgo.com/' });
        const page = await run('read_page', { elements: true });
        const box = idOf(page, (e) => /search/i.test(e.label) && (e.tag === 'input' || e.tag === 'textarea'));
        await run('type_text', { element_id: box, text: 'playwright connectOverCDP', press_enter: true });
        await run('wait_for', { text: 'playwright.dev', seconds: 8 });
        return /playwright\.dev/i.test(await run('read_page', {}));
      },
      async efficient() {
        await run('navigate', { url: 'https://duckduckgo.com/' });
        const found = await run('find', { query: 'search', max: 3 });
        const box = ref(found, /\[(\d+)\] (?:input|textarea)/);
        await run('batch', { steps: [{ do: 'type', ref: box, text: 'playwright connectOverCDP', enter: true }, { do: 'wait_for', text: 'playwright.dev' }] });
        return /playwright\.dev/i.test(await run('find', { query: 'playwright.dev', max: 5 }));
      },
    },
    'Long article fact': {
      async baseline() {
        await run('navigate', { url: 'https://en.wikipedia.org/wiki/History_of_the_United_States' });
        for (let offset = 0, i = 0; i < 20; i++) {
          const page = await run('read_page', { text_offset: offset });
          if (page.includes('Watergate')) return true;
          const meta = JSON.parse(page.split('\n')[1]);
          if (!meta.moreTextAvailable) return false;
          offset = meta.textRange[1];
        }
        return false;
      },
      async efficient() {
        await run('navigate', { url: 'https://en.wikipedia.org/wiki/History_of_the_United_States' });
        return (await run('find', { query: 'Watergate', max: 3 })).includes('Watergate');
      },
    },
  };

  const rows = [];
  for (const [task, modes] of Object.entries(tasks)) {
    for (const mode of ['baseline', 'efficient']) {
      if (which !== 'both' && which !== mode) continue;
      calls = 0; chars = 0;
      let ok = false;
      try { ok = await modes[mode](); } catch (err) { console.log(`${task} ${mode}: ${err.message}`); }
      rows.push({ task, mode, ok, calls, tokens: Math.round(chars / 4) });
      console.log(`${task.padEnd(26)} ${mode.padEnd(9)} ${ok ? 'done  ' : 'FAILED'} calls=${calls} tokens≈${Math.round(chars / 4)}`);
    }
  }
  console.log(`tool definitions sent per request: ≈${Math.round(toolDefs / 4)} tokens`);
  console.log(JSON.stringify(rows));
  await app.close();
})();
