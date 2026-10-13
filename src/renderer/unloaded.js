// The page an unloaded tab shows when Settings > Tabs > Page unloading says "Show a Reload button" (main.js wakeTab, placeholder):
// ?url=<the page it stands for>&title=<its title>&mb=<about how much memory unloading freed>. Reload asks for that address; main
// catches the request (will-navigate) and wakes the tab the usual way, so the page's own history, scroll and form state come back.
(() => {
  const q = new URLSearchParams(location.search);
  const url = q.get('url') || '';
  const title = q.get('title') || '';
  const mb = Math.round(Number(q.get('mb'))) || 0;
  let host = '';
  try { const u = new URL(url); if (u.protocol === 'http:' || u.protocol === 'https:') host = u.host; } catch { /* not an address */ }
  const $ = (id) => document.getElementById(id);
  document.title = title || host || document.title;
  if (title) $('heading').textContent = title;
  $('lead').textContent = window.t('unloaded.lead', { host: host || title });
  if (mb > 0) { $('freed').hidden = false; $('freed').textContent = window.t('unloaded.freed', { mb }); }
  const button = $('reload');
  if (!host) { button.hidden = true; return; }
  button.addEventListener('click', () => { location.href = url; });
  button.focus();
})();
