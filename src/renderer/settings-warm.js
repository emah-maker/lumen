// lumen://settings: runs in the head, as soon as the stylesheet is in (a script waits for the sheets before it), while the big script is still
// loading. It lays out one line of text in each font weight the page uses: the first use of a weight of the variable system font takes about
// 7 ms, and the first screen would otherwise pay for all five at once, after the page's script has run. The line is removed after the first
// paint (settings.js). Nothing else here.
(() => {
  const d = document.createElement('div');
  d.id = 'warm';
  d.className = 'warm';
  d.setAttribute('aria-hidden', 'true');
  for (const w of ['w4', 'w45', 'w5', 'w6', 'w7']) { const s = document.createElement('span'); s.className = w; s.textContent = 'Aa'; d.append(s); }
  document.documentElement.append(d);
  void d.offsetWidth; // (the layout, now)
})();
