// The downloads panel (the toolbar button): rows from features/downloads.js (panelEntry), actions
// back by id; "Show all downloads" opens the Downloads page (downloads.html). A
// finished file can be dragged out (main.js starts a native file drag), opened with a click or
// Enter, or shown in its folder.
(() => {
  const api = window.downloadsPanel;
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const card = $('card');
  let items = [];
  let selected = -1;
  const seen = new Set(); // ids already drawn once: only new rows animate in

  const ICONS = {
    pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
    resume: '<path d="M5 3.2v9.6L12.5 8z"/>',
    cancel: '<path d="M4 4l8 8M12 4l-8 8"/>',
    retry: '<path d="M12.5 8a4.5 4.5 0 1 1-1.4-3.3M12.5 3v2.6H9.9"/>',
    show: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/>',
    file: '<path d="M4 1.8h5.2L13 5.6v8.1c0 .3-.2.5-.5.5h-8.5a.5.5 0 0 1-.5-.5V2.3c0-.3.2-.5.5-.5zM9 1.8v4h4"/>',
  };
  const LABELS = { pause: 'Pause', resume: 'Resume', cancel: 'Cancel', retry: 'Retry', show: 'Show in folder', remove: 'Remove from list' };
  const svg = (name, box = 16) => `<svg viewBox="0 0 ${box} ${box}" aria-hidden="true">${ICONS[name === 'remove' ? 'cancel' : name]}</svg>`;

  const size = (n) => {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const v = n / 1024 ** i;
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  };
  const duration = (s) => {
    if (!Number.isFinite(s) || s <= 0) return '';
    if (s < 60) return `${Math.ceil(s)} s left`;
    if (s < 3600) return `${Math.ceil(s / 60)} min left`;
    return `${Math.floor(s / 3600)} h ${Math.ceil((s % 3600) / 60)} min left`;
  };
  const when = (t) => {
    if (!t) return '';
    const d = new Date(t);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  function statusOf(d) {
    if (d.state === 'progressing') {
      if (d.awaitingOk) return 'Waiting for your OK';
      // "3.0 of 47.7 MB" when both sizes share a unit, so speed and time left still fit.
      const [got, all] = [size(d.received), size(d.total)];
      const unit = (t) => t.split(' ')[1];
      const of = !d.total ? got : unit(got) === unit(all) ? `${got.split(' ')[0]} of ${all}` : `${got} of ${all}`;
      if (d.paused) return `Paused · ${of}`;
      const eta = d.total && d.speed ? duration((d.total - d.received) / d.speed) : '';
      return [of, d.speed ? `${size(d.speed)}/s` : '', eta].filter(Boolean).join(' · ');
    }
    if (d.state === 'completed') return d.missing ? 'Deleted' : [size(d.total || d.received), d.host, when(d.endedAt)].filter(Boolean).join(' · ');
    if (d.state === 'cancelled') return ['Cancelled', d.host].filter(Boolean).join(' · ');
    return ['Failed', d.host].filter(Boolean).join(' · ');
  }
  function actionsOf(d) {
    if (d.state === 'progressing') return d.awaitingOk ? ['cancel'] : [d.paused ? 'resume' : 'pause', 'cancel'];
    if (d.state === 'completed') return d.missing ? ['remove'] : ['show', 'remove'];
    return [d.canResume ? 'resume' : 'retry', 'remove'];
  }
  const openable = (d) => d.state === 'completed' && !d.missing;

  function render() {
    list.textContent = '';
    items.forEach((d, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.index = String(i);
      li.className = [d.state, d.paused ? 'paused' : '', d.missing ? 'missing' : '', d.state === 'interrupted' ? 'failed' : '', openable(d) ? 'openable' : '', i === selected ? 'selected' : '', seen.has(d.id) ? '' : 'fresh'].filter(Boolean).join(' ');
      li.setAttribute('aria-selected', String(i === selected));
      li.draggable = openable(d);
      if (openable(d)) li.title = `${d.name} — click to open, or drag it into another app`;

      const icon = document.createElement('div');
      icon.className = 'icon';
      if (d.icon) { const img = document.createElement('img'); img.src = d.icon; img.alt = ''; icon.append(img); } else icon.innerHTML = svg('file');

      const text = document.createElement('div');
      text.className = 'text';
      const name = Object.assign(document.createElement('div'), { className: 'name', textContent: d.name });
      const status = Object.assign(document.createElement('div'), { className: 'status', textContent: statusOf(d) });
      text.append(name, status);
      if (d.state === 'progressing' && !d.awaitingOk) {
        const bar = document.createElement('div');
        bar.className = `bar${d.total ? '' : ' unknown'}`;
        const fill = document.createElement('i');
        if (d.total) fill.style.width = `${Math.min(100, (d.received / d.total) * 100).toFixed(1)}%`;
        bar.append(fill);
        text.append(bar);
      }

      const actions = document.createElement('div');
      actions.className = 'actions';
      for (const a of actionsOf(d)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'act';
        b.title = LABELS[a];
        b.setAttribute('aria-label', `${LABELS[a]}: ${d.name}`);
        b.innerHTML = svg(a);
        b.addEventListener('click', (e) => { e.stopPropagation(); api.act(a, d.id); });
        actions.append(b);
      }
      li.append(icon, text, actions);
      li.addEventListener('click', () => { if (openable(d)) { api.act('open', d.id); api.close(); } });
      li.addEventListener('dragstart', (e) => { e.preventDefault(); if (openable(d)) api.drag(d.id); });
      list.append(li);
    });
    for (const d of items) seen.add(d.id);
    $('empty').hidden = items.length > 0;
    $('hint').hidden = !items.some(openable);
    $('clear').hidden = !items.some((d) => d.state !== 'progressing');
    requestAnimationFrame(reportHeight);
  }

  // The view is sized to the card (main.js caps it to the window).
  function reportHeight() { api.setHeight(Math.ceil(card.getBoundingClientRect().height) + 6 + 24); }
  new ResizeObserver(reportHeight).observe(card);

  api.onList((next) => { items = Array.isArray(next) ? next : []; if (selected >= items.length) selected = items.length - 1; render(); });
  api.onOpen(() => {
    selected = -1;
    card.classList.remove('entering');
    void card.offsetWidth; // restart the animation
    card.classList.add('entering');
    list.scrollTop = 0;
    render();
  });
  $('folder').addEventListener('click', () => api.openFolder());
  $('show-all').addEventListener('click', () => api.showAll());
  $('clear').addEventListener('click', () => api.clear());

  // Keyboard: arrows move, Enter opens, Delete removes, Escape closes.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { api.close(); return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      selected = e.key === 'ArrowDown' ? Math.min(items.length - 1, selected + 1) : Math.max(0, selected - 1);
      render();
      list.children[selected]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && items[selected] && openable(items[selected])) {
      api.act('open', items[selected].id);
      api.close();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && items[selected] && items[selected].state !== 'progressing') {
      api.act('remove', items[selected].id);
    }
  });
})();
