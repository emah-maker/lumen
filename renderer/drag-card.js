// The drag card (drag-card.html). main.js calls these through executeJavaScript with JSON data; this page
// has no preload and no access to anything. Only data: images, or https: favicons, are shown.
(() => {
  const $ = (id) => document.getElementById(id);
  const card = $('card');
  const imageOk = (src, https) => typeof src === 'string' && (src.startsWith('data:image/') || (https && src.startsWith('https:')));
  let hideTimer = 0;

  window.lumenCard = {
    // { title, favicon, dark, shotHeight }: a fresh card, grown in from the tab.
    show(data) {
      clearTimeout(hideTimer);
      document.documentElement.classList.toggle('dark', Boolean(data.dark));
      $('title').textContent = String(data.title || 'New Tab');
      const icon = $('icon');
      if (imageOk(data.favicon, true)) { icon.src = data.favicon; icon.classList.remove('blank'); } else { icon.removeAttribute('src'); icon.classList.add('blank'); }
      $('shot').classList.remove('loaded');
      $('shot').removeAttribute('src');
      card.style.setProperty('--shot-h', `${Math.max(60, Math.round(Number(data.shotHeight) || 180))}px`);
      card.className = 'card';
      void card.offsetWidth; // start the grow-in from the small state
      card.classList.add('on');
    },
    // The page snapshot, when capturePage has it.
    shot(src) {
      if (!imageOk(src, false)) return;
      const img = $('shot');
      img.onload = () => img.classList.add('loaded');
      img.src = src;
    },
    compact(on) { card.classList.toggle('compact', Boolean(on)); },
    // 'drop' | 'join' | 'cancel'
    hide(kind) {
      card.classList.add(['drop', 'join', 'cancel'].includes(kind) ? kind : 'cancel');
      card.classList.remove('on');
    },
  };
})();
