// The Meeting Helper panel's code and styles (meeting.js, meeting.css) load the first time it is opened, from the ⋯ menu
// or Mod+Enter: they are not in the startup bundle (test/e2e/perf-budget.js holds the browser UI to 950 KB).
(() => {
  const api = window.assistant?.meeting;
  const button = document.getElementById('meeting-btn');
  if (!api || !button) return;
  let loading = null;
  const load = () => loading || (loading = new Promise((resolve, reject) => {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'meeting.css' });
    document.head.appendChild(css);
    const script = Object.assign(document.createElement('script'), { src: 'meeting.js' });
    script.onload = resolve;
    script.onerror = () => { loading = null; script.remove(); reject(new Error('meeting.js did not load')); };
    document.body.appendChild(script);
  }));
  // (meeting.js sets its own button.onclick and onToggle once loaded; until then these open it)
  const open = () => load().then(() => window.meetingUi?.open()).catch(() => {});
  button.onclick = open;
  api.onToggle?.(() => { if (!window.meetingUi) open(); });
})();
