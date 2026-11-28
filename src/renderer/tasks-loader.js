/* global loadLater */ // (app.js, earlier in the same bundle)
// The Tasks panel (tasks.js, with its Routines view, routines.js) and the Research board (research.js) are not in the startup bundle
// (test/e2e/perf-budget.js holds the browser UI to its size): they load in an idle moment after start, or sooner on first use. This
// file is what stands in for them until then, in tasks.js's old place in index.src.html (before slash.js, so /background and /watch
// are still caught before the "/" menu): the More menu's two buttons, the composer's background button, /background and /watch,
// main's tasks events (a finished task's toast, the badge, "open the panel", "run this in the background?"), research changes and
// the ```sources block in an answer. Each one loads the file and hands over; once a file is in, it handles these itself and this
// file stands aside (window.lumenTasks / window.researchUi are set). routines-loader.js does the same for /routine and "Save as routine".
(() => {
  const byId = (id) => document.getElementById(id);
  const later = (css, ...scripts) => (typeof loadLater === 'function' ? loadLater(css, ...scripts) : Promise.resolve(false)); // (app.js)
  const loadTasks = () => later('tasks.css', 'tasks.js').then((ok) => ok && later('routines.css', 'routines.js'));
  const loadResearch = () => later('research.css', 'research.js');
  window.lumenPanels = { loadTasks, loadResearch };

  const tasks = window.assistant?.tasks;
  if (tasks) {
    const ready = () => Boolean(window.lumenTasks);
    const then = (fn) => loadTasks().then((ok) => ok && window.lumenTasks && fn(window.lumenTasks));
    byId('tasks-btn').onclick = () => then((core) => core.openPanel()); // (tasks.js sets its own onclick when it loads)
    byId('send-bg').onclick = () => then((core) => core.openCreate({ prompt: byId('prompt').value.trim(), fromComposer: true }));
    // /background <request> and /watch <address> <what>: tasks.js's to handle; before it is loaded they are held back from the chat and
    // sent again once it is. (this listener stays the only one, so it keeps running ahead of slash.js's)
    const composer = byId('composer');
    composer.addEventListener('submit', (e) => {
      if (ready()) { window.lumenTasks.submit(e); return; }
      if (!/^\/(background\s+\S|watch(\s|$))/i.test(byId('prompt').value.trim())) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      loadTasks().then((ok) => ok && composer.requestSubmit());
    }, true);
    tasks.onState((s) => { if (!ready() && (s?.badge?.running || s?.badge?.waiting || s?.unseen)) loadTasks(); }); // the badge and the More dot
    tasks.onToast((t) => { if (!ready()) then((core) => core.toast(t)); });
    tasks.onOpen((p = {}) => { if (!ready()) then((core) => (p.routine && window.lumenRoutines ? window.lumenRoutines.fromMain(p) : core.openPanel(p.id || null))); });
    tasks.onPropose((spec) => { if (!ready()) then((core) => core.openCreate(spec || {})); });
  }

  const research = window.assistant?.research;
  const button = byId('research-btn');
  if (research && button) {
    const ready = () => Boolean(window.researchUi?.open);
    button.onclick = () => loadResearch().then((ok) => ok && window.researchUi.open());
    research.onChanged(() => { if (!ready()) loadResearch(); }); // (its badge)
    // chat-core.js hands each answer here: a ```sources block in it loads the board, which turns the block into the list.
    window.researchUi = {
      decorate: (root) => { if (root?.querySelector?.('pre[data-lang="sources"]')) loadResearch().then((ok) => ok && window.researchUi.decorate(root)); },
      refresh: () => {},
    };
  }

  // Otherwise both come in once the window has settled (the same moment the files picker does).
  const both = () => { loadTasks(); loadResearch(); };
  setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(both, { timeout: 3000 }) : both()), 2500);
})();
