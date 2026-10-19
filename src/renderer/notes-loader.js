// The Notes panel's code and styles (notes.js, notes.css) load the first time it is opened, from the ⋯ menu: they are not in the startup
// bundle (test/perf-budget.js holds the browser UI to its size).
(() => {
  const api = window.assistant?.notes;
  const button = document.getElementById('notes-btn');
  if (!api || !button) return;
  let loading = null;
  const load = () => loading || (loading = new Promise((resolve, reject) => {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'notes.css' });
    document.head.appendChild(css);
    const script = Object.assign(document.createElement('script'), { src: 'notes.js' });
    script.onload = resolve;
    script.onerror = () => { loading = null; script.remove(); css.remove(); reject(new Error('notes.js did not load')); };
    document.body.appendChild(script);
  }));
  // (notes.js opens itself once loaded and then sets its own button.onclick; until then this loads it)
  button.onclick = () => load().catch(() => {});
})();
