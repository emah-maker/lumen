// The picture viewer for the chat (the sidebar's and lumen://chat): click any picture in a reply, or one you sent, to open it
// over the conversation, fit to the panel, and zoom, pan, step through the chat's other pictures, save, copy or open it in a tab.
// It is not in the startup bundle: gen-images.js loads this file and chat-image-viewer.css on the first click (the way
// meeting-loader.js loads the Meeting helper), so test/e2e/perf-budget.js's UI ceiling is untouched.
//
//   window.chatImageViewer.open({ items: [{ url, alt, id? }], index, opener })
//     url: a data: URL of a PNG, JPEG, GIF or WebP (anything else is refused); id: the picture's id when main stored it
//     (Save and Copy then go through main's own save dialog / clipboard); opener: gets focus back on close.
//
// Zoom: wheel, Ctrl+wheel (a trackpad pinch), + / - / 0 (fit) / 1 (100%), double-click (fit <-> 100%, or 2x for a picture
// smaller than the panel); 0.1x to 10x, toward the pointer. Pan: drag, or the arrow keys when the picture is bigger than the
// panel (when it is not, Left / Right step to the previous / next picture). Esc, the backdrop or Close leaves.
(() => {
  const tr = (key, vars) => window.t(key, vars);
  const SAFE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  const MIN = 0.1;
  const MAX = 10;
  const STEP = 1.25;
  const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let current = null; // the open viewer's close(), so a second open replaces the first

  function open({ items, index = 0, opener = null }) {
    const list = (Array.isArray(items) ? items : []).filter((it) => it && typeof it.url === 'string' && SAFE.test(it.url));
    if (!list.length) return null;
    current?.(true);
    const root = document.querySelector('[data-chat-root]') || document.body;
    let at = clamp(index, 0, list.length - 1);
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let fitScale = 1;
    let fitted = true; // still at "fit": a resize refits
    let natural = { w: 0, h: 0 };

    const box = el('div', { className: 'civ' });
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const stage = el('div', { className: 'civ-stage' });
    const img = el('img', { className: 'civ-img', draggable: false });
    stage.append(img);
    const status = el('div', { className: 'civ-status' });
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const btn = (label, onclick, extra = '') => {
      const b = el('button', { type: 'button', className: `civ-btn ${extra}`.trim(), textContent: label });
      b.onclick = onclick;
      return b;
    };
    const iconBtn = (label, glyph, onclick, extra = '') => {
      const b = el('button', { type: 'button', className: `civ-btn civ-icon ${extra}`.trim(), textContent: glyph });
      b.setAttribute('aria-label', label);
      b.title = label;
      b.onclick = onclick;
      return b;
    };
    const prevBtn = iconBtn(tr('imgview.prev'), '‹', () => step(-1), 'civ-prev');
    const nextBtn = iconBtn(tr('imgview.next'), '›', () => step(1), 'civ-next');
    const count = el('span', { className: 'civ-count' });
    const zoomOut = iconBtn(tr('imgview.zoomOut'), '−', () => zoomAtCenter(1 / STEP, true), 'civ-zoom-out');
    const zoomIn = iconBtn(tr('imgview.zoomIn'), '+', () => zoomAtCenter(STEP, true), 'civ-zoom-in');
    const pct = el('span', { className: 'civ-pct' });
    pct.setAttribute('aria-live', 'off');
    const fitBtn = btn(tr('imgview.fit'), () => fit(true), 'civ-fit');
    const actualBtn = btn(tr('imgview.actual'), () => actual(true), 'civ-actual');
    const saveBtn = btn(tr('imgview.save'), () => doSave(), 'civ-save');
    const copyBtn = btn(tr('imgview.copy'), () => doCopy(), 'civ-copy');
    const tabBtn = btn(tr('imgview.openTab'), () => doOpenTab(), 'civ-tab');
    const closeBtn = btn(tr('imgview.close'), () => close(), 'civ-close');
    const nav = el('div', { className: 'civ-group civ-nav' }, prevBtn, count, nextBtn);
    const zoomGroup = el('div', { className: 'civ-group' }, zoomOut, pct, zoomIn, fitBtn, actualBtn);
    const actions = el('div', { className: 'civ-group' }, saveBtn, copyBtn, tabBtn, closeBtn);
    const bar = el('div', { className: 'civ-bar' }, nav, zoomGroup, actions);
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', tr('imgview.toolbar'));
    box.append(stage, bar, status);

    const say = (text) => { status.textContent = text; clearTimeout(say.t); say.t = setTimeout(() => { status.textContent = ''; }, 2400); };

    // ---- geometry
    const stageSize = () => ({ w: stage.clientWidth || 1, h: stage.clientHeight || 1 });
    const limits = () => ({ lo: Math.min(MIN, fitScale), hi: MAX });
    const clampPan = () => {
      const s = stageSize();
      const w = natural.w * scale;
      const h = natural.h * scale;
      tx = w <= s.w ? 0 : clamp(tx, -(w - s.w) / 2, (w - s.w) / 2);
      ty = h <= s.h ? 0 : clamp(ty, -(h - s.h) / 2, (h - s.h) / 2);
    };
    const paint = (animate = false) => {
      clampPan();
      img.style.transition = animate ? '' : 'none';
      img.style.transform = `translate(-50%, -50%) translate(${tx}px, ${ty}px) scale(${scale})`;
      const shown = Math.round(scale * 100);
      pct.textContent = `${shown}%`;
      box.dataset.scale = String(Math.round(scale * 1000) / 1000);
      box.dataset.tx = String(Math.round(tx));
      box.dataset.ty = String(Math.round(ty));
      const s = stageSize();
      const over = natural.w * scale > s.w + 1 || natural.h * scale > s.h + 1;
      stage.classList.toggle('civ-pannable', over);
      zoomIn.disabled = scale >= MAX - 1e-6;
      zoomOut.disabled = scale <= limits().lo + 1e-6;
      fitBtn.setAttribute('aria-pressed', String(Math.abs(scale - fitScale) < 1e-3));
      actualBtn.setAttribute('aria-pressed', String(Math.abs(scale - 1) < 1e-3));
    };
    const computeFit = () => {
      const s = stageSize();
      fitScale = natural.w ? Math.min(s.w / natural.w, s.h / natural.h, 1) : 1;
    };
    const setScale = (next, px, py, animate) => {
      const { lo, hi } = limits();
      next = clamp(next, lo, hi);
      const s = stageSize();
      // keep the point under (px, py) (relative to the panel's centre) where it is
      const cx = px === undefined ? 0 : px - s.w / 2;
      const cy = py === undefined ? 0 : py - s.h / 2;
      tx = cx - (cx - tx) * (next / scale);
      ty = cy - (cy - ty) * (next / scale);
      scale = next;
      fitted = Math.abs(scale - fitScale) < 1e-3;
      paint(animate);
    };
    const zoomAtCenter = (factor, animate) => setScale(scale * factor, undefined, undefined, animate);
    const fit = (animate) => { computeFit(); tx = 0; ty = 0; scale = fitScale; fitted = true; paint(animate); };
    const actual = (animate) => { tx = 0; ty = 0; setScale(1, undefined, undefined, animate); };
    const toggle = (px, py) => {
      if (Math.abs(scale - fitScale) < 1e-3) {
        const target = fitScale >= 0.999 ? 2 : 1; // fit is the natural size: the picture is smaller than the panel
        setScale(target, px, py, true);
      } else {
        tx = 0; ty = 0; scale = fitScale; fitted = true; paint(true);
      }
    };

    // ---- the picture shown
    const show = (i) => {
      at = (i + list.length) % list.length;
      const it = list[at];
      const alt = it.alt || tr('genimg.alt');
      box.setAttribute('aria-label', list.length > 1 ? `${alt} (${at + 1}/${list.length})` : alt);
      img.alt = alt;
      count.textContent = list.length > 1 ? `${at + 1} / ${list.length}` : '';
      prevBtn.hidden = nextBtn.hidden = list.length < 2;
      count.hidden = list.length < 2;
      natural = { w: 0, h: 0 };
      img.style.visibility = 'hidden';
      img.src = it.url;
      const ready = () => {
        natural = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
        img.style.width = `${natural.w}px`;
        img.style.height = `${natural.h}px`;
        img.style.visibility = '';
        fit(false);
        box.dataset.ready = '1';
      };
      box.dataset.ready = '';
      if (img.complete && img.naturalWidth) ready(); else { img.onload = ready; img.onerror = () => say(tr('genimg.error')); }
    };
    const step = (d) => { if (list.length > 1) show(at + d); };

    // ---- actions
    const api = () => window.assistant?.images;
    async function doSave() {
      const it = list[at];
      if (it.id && api()?.save) {
        const r = await Promise.resolve().then(() => api().save(it.id)).catch(() => null);
        if (r?.ok) say(tr('genimg.saved')); else if (r?.reason !== 'canceled') say(tr('genimg.saveFailed'));
        return;
      }
      try {
        const ext = /^data:image\/(png|jpeg|gif|webp)/.exec(it.url)[1].replace('jpeg', 'jpg');
        const a = el('a', { href: it.url, download: `lumen-picture.${ext}` });
        box.append(a);
        a.click();
        a.remove();
        say(tr('genimg.saved'));
      } catch { say(tr('genimg.saveFailed')); }
    }
    async function doCopy() {
      const it = list[at];
      let ok = false;
      if (it.id && api()?.copy) ok = await Promise.resolve().then(() => api().copy(it.id)).catch(() => false);
      else {
        try {
          const canvas = el('canvas', { width: natural.w, height: natural.h });
          canvas.getContext('2d').drawImage(img, 0, 0);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          ok = true;
        } catch { ok = false; }
      }
      say(ok ? tr('genimg.copied') : tr('genimg.copyFailed'));
    }
    async function doOpenTab() {
      // main writes the picture to a temp file and opens that (a data URL this long is not a usable tab address)
      const ok = await Promise.resolve().then(() => api()?.openTab(list[at].url)).catch(() => false);
      say(ok ? tr('imgview.openedTab') : tr('imgview.openTabFailed'));
    }

    // ---- pointer: wheel zoom, drag pan, double-click
    const point = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : 1;
      const dy = e.deltaY * unit;
      if (!dy) return;
      const [px, py] = point(e);
      setScale(scale * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)), px, py, false);
    }, { passive: false });
    let drag = null;
    let moved = false;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      moved = false;
      drag = { x: e.clientX, y: e.clientY, tx, ty, captured: false };
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      if (!drag.captured) { drag.captured = true; stage.setPointerCapture?.(e.pointerId); } // (only once it is a drag: a click must still land on the picture or the backdrop)
      tx = drag.tx + dx;
      ty = drag.ty + dy;
      stage.classList.add('civ-dragging');
      paint(false);
    });
    const endDrag = (e) => { drag = null; stage.classList.remove('civ-dragging'); try { stage.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ } };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('click', (e) => {
      if (moved) { moved = false; return; }
      if (e.target === stage) close(); // the backdrop (not the picture)
    });
    stage.addEventListener('dblclick', (e) => {
      if (e.target !== img) return;
      const [px, py] = point(e);
      toggle(px, py);
    });

    // ---- keys
    const panBy = (dx, dy) => { tx += dx; ty += dy; paint(false); };
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      const s = stageSize();
      const overX = natural.w * scale > s.w + 1;
      const overY = natural.h * scale > s.h + 1;
      const done = () => { e.preventDefault(); e.stopPropagation(); };
      if (k === 'Escape') { done(); close(); }
      else if (k === '+' || k === '=') { done(); zoomAtCenter(STEP, true); }
      else if (k === '-' || k === '_') { done(); zoomAtCenter(1 / STEP, true); }
      else if (k === '0') { done(); fit(true); }
      else if (k === '1') { done(); actual(true); }
      else if (k === 'ArrowLeft') { done(); if (overX) panBy(60, 0); else step(-1); }
      else if (k === 'ArrowRight') { done(); if (overX) panBy(-60, 0); else step(1); }
      else if (k === 'ArrowUp') { if (overY) { done(); panBy(0, 60); } }
      else if (k === 'ArrowDown') { if (overY) { done(); panBy(0, -60); } }
      else if (k === 'PageUp' || k === '[') { done(); step(-1); }
      else if (k === 'PageDown' || k === ']') { done(); step(1); }
      else if (k === 'Tab') {
        const stops = [...box.querySelectorAll('button:not([hidden]):not(:disabled)')];
        const i = stops.indexOf(document.activeElement);
        done();
        stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
      }
    };

    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (!natural.w) return; const was = fitted; computeFit(); if (was) fit(false); else paint(false); }) : null;
    function close(replaced) {
      resize?.disconnect();
      document.removeEventListener('keydown', onKey, true);
      box.remove();
      current = null;
      if (!replaced && opener?.isConnected) opener.focus?.();
    }
    current = close;

    root.append(box);
    document.addEventListener('keydown', onKey, true);
    resize?.observe(stage);
    show(at);
    closeBtn.focus();
    return { close, box, get scale() { return scale; } };
  }

  window.chatImageViewer = { open, closeAll: () => { current?.(true); } }; // (closeAll: leaving the chat the picture was opened in)
})();
