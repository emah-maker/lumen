// Lumen's website: the theme switch, the code tabs, and the latest release's version on the button.
'use strict';

(function theme() {
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem('lumen-site-theme'); } catch (err) { console.warn('theme: storage unavailable', err); }
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  const btn = document.querySelector('.theme-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('lumen-site-theme', root.dataset.theme); } catch (err) { console.warn('theme: not saved', err); }
  });
})();

(function codeTabs() {
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    tabs.forEach((tab) => tab.addEventListener('click', () => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      }
    }));
  }
})();

(async function latestVersion() {
  const slot = document.querySelector('[data-latest]');
  if (!slot) return;
  try {
    const res = await fetch('https://api.github.com/repos/emah-maker/lumen/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return; // rate-limited or offline: the button still links to the latest release
    const rel = await res.json();
    const tag = rel.tag_name;
    if (typeof tag === 'string' && /^v?\d+\.\d+\.\d+$/.test(tag)) slot.textContent = tag;
    // One obvious download: the file for this computer (Apple silicon assumed on a Mac; the Intel
    // dmg is linked next to the button). Anything unexpected keeps the releases page link.
    const os = /Mac/i.test(navigator.platform) ? 'mac' : /Win/i.test(navigator.platform) ? 'win' : '';
    const find = (re) => (rel.assets || []).find((x) => re.test(x.name) && /^https:\/\/github\.com\//.test(x.browser_download_url || ''));
    const pick = os === 'mac' ? find(/-mac-arm64\.dmg$/) : os === 'win' ? find(/-Setup-.*\.exe$/) : null;
    const btn = slot.closest('a');
    if (pick && btn) btn.href = pick.browser_download_url;
    const intel = find(/-mac-x64\.dmg$/);
    if (os === 'mac' && intel && btn) btn.insertAdjacentHTML('afterend', `<a class="btn ghost" href="${intel.browser_download_url}">Intel Mac</a>`);
  } catch (err) {
    console.warn('latest release: not shown', err);
  }
})();
