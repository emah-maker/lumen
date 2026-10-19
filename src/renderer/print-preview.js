// The print preview sheet's page (features/print-preview.js). It holds the settings panel; the pages themselves are
// drawn by a second view the app places over #stage. It sends one settings object and a few button presses.
(() => {
  const PDF = '__pdf__';
  const $ = (id) => document.getElementById(id);
  const host = window.printHost;
  let table = {};
  const t = (key, vars) => {
    const text = typeof table[key] === 'string' ? table[key] : key;
    return vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) : text;
  };
  const state = { mode: 'page', mac: false, seq: 0, applied: 0, pages: null, total: null, busy: false, hideView: false, rangeError: '', sentKey: '', timer: 0, ready: false };

  // The settings that change what the preview shows (the rest only change what is printed).
  const PREVIEW_KEYS = ['landscape', 'pages', 'ranges', 'paper', 'margins', 'custom', 'scale', 'scalePercent', 'headerFooter', 'background'];

  function read() {
    return {
      destination: $('destination').value || PDF,
      landscape: $('layout').value === 'landscape',
      color: $('color').value !== 'bw',
      copies: Math.max(1, Math.min(999, Math.round(Number($('copies').value) || 1))),
      pages: $('pages').value,
      ranges: $('ranges').value,
      paper: $('paper').value,
      margins: $('margins').value,
      custom: { top: Number($('m-top').value), bottom: Number($('m-bottom').value), left: Number($('m-left').value), right: Number($('m-right').value) },
      scale: $('scale').value,
      scalePercent: Number($('scale-percent').value) || 100,
      headerFooter: $('headerFooter').checked,
      background: $('background').checked,
      duplex: $('duplex').checked ? $('duplex-edge').value : 'simplex',
    };
  }

  function write(s) {
    $('destination').value = s.destination;
    if ($('destination').value !== s.destination) $('destination').value = PDF;
    $('layout').value = s.landscape ? 'landscape' : 'portrait';
    $('color').value = s.color ? 'color' : 'bw';
    $('copies').value = s.copies;
    $('pages').value = s.pages;
    $('ranges').value = s.ranges;
    $('paper').value = s.paper;
    $('margins').value = s.margins;
    $('m-top').value = s.custom.top; $('m-bottom').value = s.custom.bottom; $('m-left').value = s.custom.left; $('m-right').value = s.custom.right;
    $('scale').value = s.scale;
    $('scale-percent').value = s.scalePercent;
    $('headerFooter').checked = s.headerFooter;
    $('background').checked = s.background;
    $('duplex').checked = s.duplex !== 'simplex';
    $('duplex-edge').value = s.duplex === 'shortEdge' ? 'shortEdge' : 'longEdge';
  }

  // "1-5, 8, 11-13": the same rules the app applies (a page 1 or higher, a range that doesn't run backwards).
  function rangesValid(text) {
    const parts = String(text).split(',');
    return parts.every((part) => {
      const m = /^\s*(\d{1,6})\s*(?:-\s*(\d{1,6})\s*)?$/.exec(part);
      return Boolean(m) && Number(m[1]) >= 1 && (m[2] === undefined || Number(m[2]) >= Number(m[1]));
    });
  }

  const isPdfDestination = () => $('destination').value === PDF;
  const customRangesBad = () => $('pages').value === 'custom' && (!rangesValid($('ranges').value) || Boolean(state.rangeError));

  function reportRect() {
    const r = $('stage').getBoundingClientRect();
    host.rect(state.hideView ? { x: r.left, y: r.top, width: 0, height: 0 } : { x: r.left, y: r.top, width: r.width, height: r.height });
  }

  function updateCount() {
    const el = $('count');
    if (state.pages == null) { el.textContent = ''; return; }
    if (isPdfDestination()) { el.textContent = t(state.pages === 1 ? 'print.pageCount.one' : 'print.pageCount', { n: state.pages }); return; }
    const duplex = $('duplex').checked;
    const sheets = duplex ? Math.ceil(state.pages / 2) : state.pages;
    el.textContent = t(sheets === 1 ? 'print.sheets.one' : 'print.sheets', { n: sheets });
  }

  function updateRangesError() {
    const err = $('ranges-error');
    const custom = $('pages').value === 'custom';
    let text = '';
    if (custom) {
      if (state.rangeError) text = state.rangeError;
      else if (state.touchedRanges && !rangesValid($('ranges').value)) text = t('print.rangeError');
    }
    err.hidden = !text;
    err.textContent = text;
    $('ranges').setAttribute('aria-invalid', text ? 'true' : 'false');
  }

  function updateVisibility() {
    const pdfDest = isPdfDestination();
    const pdfDoc = state.mode === 'pdf';
    const hide = (id, off) => { $(id).hidden = off; };
    hide('row-copies', pdfDest);
    hide('row-color', pdfDest);
    hide('check-duplex', pdfDest);
    hide('duplex-wrap', pdfDest || !$('duplex').checked);
    hide('row-layout', pdfDoc);
    hide('row-paper', pdfDoc);
    hide('row-margins', pdfDoc);
    hide('row-scale', pdfDoc);
    hide('check-hf', pdfDoc);
    hide('check-bg', pdfDoc);
    $('row-options').hidden = pdfDoc && pdfDest;
    $('more').hidden = pdfDoc && pdfDest;
    hide('ranges-wrap', $('pages').value !== 'custom');
    hide('custom-margins', $('margins').value !== 'custom');
    hide('scale-wrap', $('scale').value !== 'custom');
    $('go').textContent = pdfDest ? t('print.save') : t('print.print');
    $('go').disabled = state.busy || customRangesBad();
    updateRangesError();
    updateCount();
  }

  function render() {
    state.timer = 0;
    const s = read();
    if (s.pages === 'custom' && !rangesValid(s.ranges)) { updateVisibility(); return; }
    state.rangeError = '';
    state.sentKey = JSON.stringify(PREVIEW_KEYS.map((k) => s[k]));
    host.render({ ...s, seq: ++state.seq });
    updateVisibility();
  }

  // A change of a setting: render again shortly (a typed number shouldn't render per key).
  function changed(force = false) {
    const s = read();
    updateVisibility();
    if (!state.ready) return;
    if (!force && JSON.stringify(PREVIEW_KEYS.map((k) => s[k])) === state.sentKey) return;
    state.rangeError = '';
    clearTimeout(state.timer);
    state.timer = setTimeout(render, 250);
  }

  function go() {
    if ($('go').disabled) return;
    const s = read();
    $('message').textContent = '';
    if (s.destination === PDF) host.save(s); else host.print(s);
  }

  function fillPrinters(printers, current) {
    const sel = $('destination');
    sel.textContent = '';
    const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; sel.append(o); };
    add(PDF, t('print.savePdf'));
    for (const p of printers) add(p.name, p.isDefault ? t('print.defaultPrinter', { name: p.label }) : p.label);
    sel.value = current;
    if (sel.value !== current) sel.value = PDF;
  }

  function translate() {
    for (const el of document.querySelectorAll('[data-i18n]')) if (typeof table[el.dataset.i18n] === 'string') el.textContent = t(el.dataset.i18n);
    for (const attr of ['placeholder', 'aria-label']) {
      for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) { const k = el.getAttribute(`data-i18n-${attr}`); if (typeof table[k] === 'string') el.setAttribute(attr, t(k)); }
    }
  }

  host.on('print:init', (init) => {
    table = init.strings || {};
    state.mode = init.mode;
    state.mac = Boolean(init.mac);
    translate();
    for (const name of init.papers || []) { const o = document.createElement('option'); o.value = name; o.textContent = name; $('paper').append(o); }
    fillPrinters(init.printers || [], init.settings.destination);
    write(init.settings);
    $('system-key').textContent = state.mac ? '⇧⌘P' : 'Ctrl+Shift+P';
    document.title = t('print.title');
    state.ready = true;
    updateVisibility();
    reportRect();
    render();
    $('go').focus();
  });

  host.on('print:rendered', (r) => {
    if (typeof r.seq === 'number' && r.seq < state.applied) return;
    state.applied = r.seq || state.applied;
    if (r.error === 'range' || r.error === 'outOf') {
      state.rangeError = r.error === 'outOf' && r.total ? t('print.rangeOut', { total: r.total }) : t('print.rangeError');
      updateVisibility();
      return;
    }
    state.rangeError = '';
    if (r.error) {
      state.hideView = true;
      $('stage-note').hidden = false;
      $('stage-note').className = 'error';
      $('stage-note').textContent = t('print.renderFailed');
      reportRect();
      updateVisibility();
      return;
    }
    if (state.hideView) { state.hideView = false; reportRect(); }
    state.pages = Number.isFinite(r.pages) ? r.pages : null;
    state.total = r.total || null;
    updateVisibility();
  });
  host.on('print:pdf-shown', () => { $('stage-note').hidden = true; });
  host.on('print:error', (e) => { $('message').textContent = (e && e.message) || ''; state.busy = false; updateVisibility(); });
  host.on('print:busy', (e) => { state.busy = Boolean(e && e.busy); updateVisibility(); });

  for (const id of ['destination', 'pages', 'layout', 'color', 'paper', 'margins', 'scale', 'headerFooter', 'background', 'duplex', 'duplex-edge', 'copies', 'm-top', 'm-bottom', 'm-left', 'm-right', 'scale-percent']) {
    $(id).addEventListener('change', () => changed());
    if ($(id).tagName === 'INPUT' && $(id).type === 'number') $(id).addEventListener('input', () => changed());
  }
  $('ranges').addEventListener('input', () => { state.touchedRanges = true; changed(true); });
  $('ranges').addEventListener('blur', () => { state.touchedRanges = true; updateRangesError(); });
  $('pages').addEventListener('change', () => { if ($('pages').value === 'custom') $('ranges').focus(); });
  $('go').addEventListener('click', go);
  $('cancel').addEventListener('click', () => host.cancel());
  $('system').addEventListener('click', () => host.system());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); host.cancel(); return; }
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') { e.preventDefault(); go(); return; }
    const mod = state.mac ? e.metaKey : e.ctrlKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); host.system(); }
  });
  new ResizeObserver(reportRect).observe($('stage'));
  window.addEventListener('resize', reportRect);
})();
