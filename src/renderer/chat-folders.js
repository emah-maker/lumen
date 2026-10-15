// The folder the AI works in, in the composer of the sidebar and the full-page chat (loaded after chat-core.js on both).
//  - "Work in folder…" in the More menu: picks a folder for the open chat (it is remembered with the chat),
//  - a chip above the box that names the folder the AI works in now (shortened) and where it comes from: the chat's own pick, or its
//    project's folder. Its menu: Change folder…, Open folder, Clear (the chat's own pick; a project chat then uses its project's again).
// Main (main.js 'chats:work-folder') keeps it; chatView() carries `workFolder`, and chat-core's applySync calls refresh(view.workFolder).
// A drive root or the home folder is only used after an explicit confirm.
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.assistant?.chats;
  if (!api?.workFolder) return;
  const tr = (key, english, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    return text === key || !text ? (vars ? english.replace(/\{(\w+)\}/g, (w, n) => (n in vars ? String(vars[n]) : w)) : english) : text;
  };
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg>';

  let info = null; // { path, shown, source: 'chat' | 'project', missing }

  const chip = el('button', { type: 'button', className: 'work-folder-chip', id: 'work-folder' });
  chip.hidden = true;
  chip.setAttribute('aria-haspopup', 'menu');
  chip.innerHTML = `${FOLDER}<span class="wf-label"></span><span class="wf-path"></span>`;
  $('hands-off')?.after(chip);

  function render() {
    chip.hidden = !info;
    if (!info) return;
    const label = info.missing ? tr('workfolder.missing', 'Folder missing') : info.source === 'project' ? tr('workfolder.project', 'Project folder') : tr('workfolder.chat', 'Working in');
    chip.querySelector('.wf-label').textContent = label;
    chip.querySelector('.wf-path').textContent = info.shown || info.path;
    chip.classList.toggle('missing', Boolean(info.missing));
    chip.title = `${tr('workfolder.title', 'The AI works in this folder: {path}', { path: info.path })}${info.missing ? `\n${tr('workfolder.missingNote', 'It is not there now. The AI ignores it until it is back or you choose another.')}` : ''}`;
    chip.setAttribute('aria-label', `${label}: ${info.path}`);
  }
  const announce = (text) => { try { window.announce?.(text); } catch { /* no live region */ } };

  // The chat's folder as main has it now (also checks that it exists). Cheap: one IPC, one stat.
  async function pull() {
    try { const out = await api.workFolder('get'); info = out?.info || null; } catch { info = null; }
    render();
  }
  // chat-core's applySync hands over what chatView() carried (no existence check yet): draw it now, then look.
  function refresh(carried) {
    info = carried || null;
    render();
    if (info) pull();
  }

  // ---- a small popover next to the chip or the menu row (Escape and a click elsewhere close it)
  let pop = null;
  function closePop() { pop?.remove(); pop = null; document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', onKey, true); }
  const away = (e) => { if (pop && !pop.contains(e.target)) closePop(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); } };
  function openPop(anchor, nodes) {
    closePop();
    pop = el('div', { className: 'work-folder-pop' });
    pop.setAttribute('role', 'menu');
    pop.append(...nodes);
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${r.top - h - 6 < 8 ? r.bottom + 6 : r.top - h - 6}px`;
    setTimeout(() => document.addEventListener('pointerdown', away, true));
    document.addEventListener('keydown', onKey, true);
    pop.querySelector('button')?.focus();
  }
  const item = (label, run, className = '') => {
    const b = el('button', { type: 'button', className: `wf-item ${className}`.trim(), textContent: label });
    b.setAttribute('role', 'menuitem');
    b.onclick = async () => { closePop(); await run(); };
    return b;
  };

  async function apply(out, anchor) {
    if (out?.ok) { info = out.info || null; render(); announce(info ? tr('workfolder.set', 'The AI now works in {path}', { path: info.shown || info.path }) : tr('workfolder.cleared', 'No working folder')); return; }
    if (out?.reason === 'home' || out?.reason === 'root') {
      const what = out.reason === 'home' ? tr('workfolder.home', 'your home folder') : tr('workfolder.root', 'a whole drive');
      openPop(anchor, [
        el('p', { className: 'wf-note', textContent: tr('workfolder.confirm', 'Use {what} as the working folder? The AI could then read and write anything in it.', { what }) }),
        item(tr('workfolder.useAnyway', 'Use it anyway'), async () => apply(await api.workFolder('set', out.path, true), anchor)),
        item(tr('workfolder.cancel', 'Cancel'), async () => {}),
      ]);
      return;
    }
    if (out?.reason === 'missing' || out?.reason === 'not-folder' || out?.reason === 'invalid') announce(tr('workfolder.invalid', 'That folder cannot be used.'));
  }
  async function choose(anchor) {
    const out = await api.workFolder('pick').catch(() => null);
    if (out?.reason === 'canceled') return;
    await apply(out, anchor);
  }

  chip.onclick = () => {
    if (!info) return;
    const nodes = [
      item(tr('workfolder.change', 'Change folder…'), () => choose(chip)),
      item(tr('workfolder.open', 'Open folder'), async () => { await api.workFolder('open'); }),
    ];
    if (info.source === 'chat') nodes.push(item(tr('workfolder.clear', 'Clear'), async () => apply(await api.workFolder('clear'), chip)));
    else nodes.push(el('p', { className: 'wf-note', textContent: tr('workfolder.fromProject', 'From the chat’s project. Change folder… sets one for this chat only.') }));
    openPop(chip, nodes);
  };

  // ---- the More menu's row (the page's "⋯" menu, or the sidebar's)
  const pageMenu = $('cp-more-menu');
  const sideMenu = $('more-menu');
  const menu = pageMenu || sideMenu;
  if (menu) {
    const row = pageMenu
      ? el('button', { type: 'button', className: 'icon-btn', id: 'work-folder-menu' })
      : el('button', { type: 'button', className: 'icon-btn menu-item labeled', id: 'work-folder-menu' });
    row.setAttribute('role', 'menuitem');
    row.innerHTML = `${FOLDER}<span class="${pageMenu ? 'cp-menu-label' : 'menu-label'}"></span>`;
    row.querySelector('span').textContent = tr('workfolder.menu', 'Work in folder…');
    row.title = tr('workfolder.menuTitle', 'Choose a folder for the AI to work in, for this chat');
    row.onclick = () => { setTimeout(() => choose(chip.hidden ? (pageMenu ? $('cp-more') : $('more-actions')) || row : chip), 0); };
    menu.prepend(row);
  }

  window.chatFolders = { refresh, pull };
  window.addEventListener('focus', () => { if (info) pull(); });
  pull();
})();
