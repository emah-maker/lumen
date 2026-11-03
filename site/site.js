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

// The download buttons: the file for this computer, labelled with what it is. On a Mac the chip
// matters (an Apple silicon build won't run on Intel and vice versa), so both Mac files get a button
// that says which Mac it is for. When the chip is detected, its button is the primary one and says
// "Recommended for your Mac"; when it can't be, the two are equal and a line says how to check.
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
  // name; else Apple silicon as the likely answer (every Mac since late 2020), marked as a guess.
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

  const MAC = {
    arm64: { name: 'Mac with Apple silicon', hint: 'M1, M2, M3, M4…' },
    x64: { name: 'Mac with Intel chip', hint: 'Intel Core i5, i7, i9…' },
  };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fileOf = (url) => { try { return decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { return ''; } };

  // Label first, before any network: the buttons say what they are even when the API can't be reached.
  const chip = os === 'mac' ? await macChip() : null;
  if (os === 'win' && btn.firstChild && btn.firstChild.nodeType === 3) btn.firstChild.nodeValue = 'Download for Windows';
  let macBtns = null;
  if (os === 'mac') {
    const first = chip.arch;
    const second = first === 'arm64' ? 'x64' : 'arm64';
    const inner = (arch, lead) => `<span class="dl-l">${lead && chip.sure ? '<small class="dl-rec">Recommended for your Mac</small>' : ''}<span class="dl-t">${lead ? 'Download for ' : ''}${MAC[arch].name}${lead ? '<span class="ver" data-latest></span>' : ''}</span><small class="dl-f">${MAC[arch].hint}</small></span>`;
    btn.classList.add('dl-mac');
    if (!chip.sure) btn.classList.replace('primary', 'choice');
    btn.innerHTML = inner(first, true);
    btn.insertAdjacentHTML('afterend', `<a class="btn ${chip.sure ? 'ghost' : 'choice'} dl-mac" href="${REL}/latest">${inner(second, false)}</a>`);
    macBtns = { [first]: btn, [second]: btn.nextElementSibling };
    const cta = btn.closest('.cta');
    if (cta) {
      cta.insertAdjacentHTML('afterend', chip.sure
        ? `<p class="dl-help">To check: Apple menu → <b>About This Mac</b> shows a <b>Chip</b> (Apple M…) on Apple silicon, or a <b>Processor</b> (Intel…) on an Intel Mac.</p>`
        : `<p class="dl-help"><b>Which Mac do you have?</b> Apple menu → <b>About This Mac</b>. If it lists a <b>Chip</b> (Apple M1, M2, M3, M4…), get Apple silicon. If it lists a <b>Processor</b> (Intel Core…), get Intel.</p>`);
    }
  }
  const slotNow = () => btn.querySelector('[data-latest]');

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
  if (tag && slotNow()) slotNow().textContent = tag;
  if (!links) return; // the button keeps linking to the latest release page

  if (os === 'win') {
    btn.href = links.win;
    // the zip needs no installer: for PCs where Smart App Control blocks the setup
    btn.insertAdjacentHTML('afterend', `<a class="btn ghost" href="${links.winzip}" title="A plain zip: unzip it and run Lumen.exe, no installer (for PCs where Smart App Control blocks the setup)">Zip, no installer</a>`);
  }
  if (macBtns) {
    for (const arch of ['arm64', 'x64']) {
      const a = macBtns[arch];
      a.href = links[arch];
      const file = fileOf(links[arch]);
      if (file) a.querySelector('.dl-f').textContent = `${MAC[arch].hint} · ${file}`;
    }
  }

  // The install table: the real file names, linked.
  for (const el of document.querySelectorAll('[data-file]')) {
    const url = links[el.dataset.file];
    if (url) el.innerHTML = `<a href="${esc(url)}"><code>${esc(fileOf(url))}</code></a>`;
  }
})();
