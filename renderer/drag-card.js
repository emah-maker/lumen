// The drag card (drag-card.html). main.js calls these through executeJavaScript with JSON data; this page
// has no preload and no access to anything. Only data: images, or https: favicons, are shown.
(() => {
  const $ = (id) => document.getElementById(id);
  const card = $('card');
  const imageOk = (src, https) => typeof src === 'string' && (src.startsWith('data:image/') || (https && src.startsWith('https:')));
  let hideTimer = 0;

  window.lumenCard = {
    // { title, favicon, dark, shotHeight, count }: a fresh card, grown in from the tab.
    show(data) {
      clearTimeout(hideTimer);
      document.documentElement.classList.toggle('dark', Boolean(data.dark));
      // Lumen's accent colour (a #rgb/#rrggbb value only), for the count badge and the like.
      if (typeof data.accent === 'string' && /^#[0-9a-f]{3,8}$/i.test(data.accent)) document.documentElement.style.setProperty('--accent', data.accent);
      else document.documentElement.style.removeProperty('--accent');
      $('title').textContent = String(data.title || 'New Tab');
      const count = Math.max(1, Math.min(999, Math.round(Number(data.count) || 1)));
      $('count').textContent = String(count);
      $('count').setAttribute('aria-label', `${count} tabs`);
      document.body.className = count > 1 ? `many${count > 2 ? ' three' : ''}` : '';
      document.documentElement.classList.toggle('still', Boolean(data.still)); // Lumen's Reduce motion
      const icon = $('icon');
      icon.onerror = () => { icon.removeAttribute('src'); icon.classList.add('blank'); };
      icon.className = 'icon';
      const colour = data.group && String(data.group.color || '').replace(/[^a-z]/g, '');
      if (colour) { icon.removeAttribute('src'); icon.classList.add('dot', `g-${colour}`); } // a group: its colour
      else if (imageOk(data.favicon, true)) icon.src = data.favicon;
      else { icon.removeAttribute('src'); icon.classList.add('blank'); }
      $('shot').classList.remove('loaded');
      $('shot').removeAttribute('src');
      if (imageOk(data.shot, false)) { $('shot').classList.add('loaded', 'instant'); $('shot').src = data.shot; } // taken before the drag: shown at once
      card.style.setProperty('--shot-h', `${Math.max(60, Math.round(Number(data.shotHeight) || 180))}px`);
      card.className = `${count > 1 ? 'card many' : 'card'}${data.compact ? ' compact' : ''}${data.bare ? ' bare' : ''}`;
      document.body.classList.toggle('compact', Boolean(data.compact));
      void card.offsetWidth; // start the grow-in from the small state
      card.classList.add('on');
      document.body.classList.add('on');
    },
    // The page snapshot, when capturePage has it.
    shot(src) {
      if (!imageOk(src, false)) return;
      const img = $('shot');
      img.classList.remove('instant');
      img.onload = () => img.classList.add('loaded');
      img.src = src;
    },
    bare() { if (!$('shot').classList.contains('loaded')) card.classList.add('bare'); },
    wait() { card.classList.remove('compact'); card.classList.add('wait'); },
    compact(on) { card.classList.toggle('compact', Boolean(on)); document.body.classList.toggle('compact', Boolean(on)); },
    // 'drop' | 'join' | 'cancel'
    hide(kind) {
      card.classList.remove('wait');
      card.classList.add(['drop', 'join', 'cancel'].includes(kind) ? kind : 'cancel');
      card.classList.remove('on');
      document.body.classList.add('leaving');
    },
  };
})();
