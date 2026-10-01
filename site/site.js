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

// The download button: the file for this computer, labelled with what it is. On a Mac the chip
// matters (an Apple silicon build won't run on Intel and vice versa), so it is detected, and when it
// can't be known for sure the button says "Apple silicon" out loud with the Intel link beside it.
(async function download() {
  const slot = document.querySelector('[data-latest]');
  const btn = slot && slot.closest('a');
  if (!slot || !btn) return;
  const REL = 'https://github.com/emah-maker/lumen/releases';
  const tagOk = (t) => typeof t === 'string' && /^v?\d+\.\d+\.\d+$/.test(t);
  const plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const os = /Mac/i.test(plat) && !(navigator.maxTouchPoints > 1) ? 'mac' : /Win/i.test(plat) ? 'win' : ''; // not an iPad in desktop mode

  // The GPU name, a hint for the chip: Apple silicon says "Apple M1" (Chrome) or just "Apple GPU" (Safari, Intel Macs too).
  function gpuName() {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    } catch (err) {
      return '';
    }
  }
  // { arch: 'arm64' | 'x64', sure }. Client hints where the browser has them (Chromium), then the GPU
  // name, else Apple silicon as the likely answer (every Mac since late 2020), marked as a guess.
  async function macChip() {
    try {
      const hi = navigator.userAgentData && await navigator.userAgentData.getHighEntropyValues(['architecture']);
      if (hi && hi.architecture === 'arm') return { arch: 'arm64', sure: true };
      if (hi && hi.architecture === 'x86') return { arch: 'x64', sure: true };
    } catch (err) {
      console.warn('arch: client hints unavailable', err);
    }
    const gpu = gpuName();
    if (/Apple M\d/i.test(gpu)) return { arch: 'arm64', sure: true };
    if (/Intel|AMD|Radeon/i.test(gpu)) return { arch: 'x64', sure: true }; // Apple silicon never reports these
    return { arch: 'arm64', sure: false }; // "Apple GPU" (Safari hides the chip) or nothing: a guess
  }

  // Label first, before any network: the button says what it is even when the API can't be reached.
  const chip = os === 'mac' ? await macChip() : null;
  const name = os === 'mac' ? `Mac (${chip.arch === 'arm64' ? 'Apple silicon' : 'Intel'})` : os === 'win' ? 'Windows' : '';
  if (name && btn.firstChild && btn.firstChild.nodeType === 3) btn.firstChild.nodeValue = `Download for ${name}`;

  // The release files: from the API when it answers; else the last version this browser saw, with the
  // files named the way package.json names them; else the releases page stays as the link.
  const byName = (v) => ({
    win: `${REL}/download/v${v}/Lumen-Setup-${v}.exe`,
    winzip: `${REL}/download/v${v}/Lumen-${v}-win-x64.zip`,
    arm64: `${REL}/download/v${v}/Lumen-${v}-mac-arm64.dmg`,
    x64: `${REL}/download/v${v}/Lumen-${v}-mac-x64.dmg`,
  });
  let tag = '';
  let links = null;
  try {
    const res = await fetch('https://api.github.com/repos/emah-maker/lumen/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
    if (res.ok) {
      const rel = await res.json();
      if (tagOk(rel.tag_name)) {
        tag = rel.tag_name;
        const find = (re) => (rel.assets || []).find((x) => re.test(x.name) && /^https:\/\/github\.com\//.test(x.browser_download_url || ''));
        const fallback = byName(tag.replace(/^v/, ''));
        const url = (re, key) => { const a = find(re); return a ? a.browser_download_url : fallback[key]; };
        links = { win: url(/-Setup-.*\.exe$/, 'win'), winzip: url(/-win-x64\.zip$/, 'winzip'), arm64: url(/-mac-arm64\.dmg$/, 'arm64'), x64: url(/-mac-x64\.dmg$/, 'x64') };
        try { localStorage.setItem('lumen-site-latest', tag); } catch (err) { console.warn('latest release: not remembered', err); }
      }
    } // rate-limited or offline: handled below
  } catch (err) {
    console.warn('latest release: API unreachable', err);
  }
  if (!links) {
    try {
      const saved = localStorage.getItem('lumen-site-latest');
      if (tagOk(saved)) { tag = saved; links = byName(saved.replace(/^v/, '')); }
    } catch (err) {
      console.warn('latest release: nothing remembered', err);
    }
  }
  if (tag) slot.textContent = tag;
  if (!links) return; // the button keeps linking to the latest release page

  if (os === 'win') {
    btn.href = links.win;
    // the zip needs no installer: for PCs where Smart App Control blocks the setup
    btn.insertAdjacentHTML('afterend', `<a class="btn ghost" href="${links.winzip}" title="A plain zip: unzip it and run Lumen.exe, no installer (for PCs where Smart App Control blocks the setup)">Zip, no installer</a>`);
  }
  if (os === 'mac') {
    btn.href = links[chip.arch];
    const other = chip.arch === 'arm64' ? 'x64' : 'arm64';
    btn.insertAdjacentHTML('afterend', `<a class="btn ghost" href="${links[other]}">${other === 'x64' ? 'Intel Mac' : 'Apple silicon'}</a>`);
  }
})();
