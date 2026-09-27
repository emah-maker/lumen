// AI web panels: the sidebar can show claude.ai, ChatGPT, Gemini or Grok with the user's own
// account instead of Lumen's agent. main.js owns the native views; this file picks the mode,
// reports the box they dock into, and offers "Share page" (copy the tab for the user to paste).
(() => {
  const MODES = ['agent', 'claude', 'chatgpt', 'gemini', 'grok'];
  const BRAND = { claude: 'Claude', chatgpt: 'OpenAI', gemini: 'Gemini', grok: 'Grok' };
  const NAME = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', grok: 'Grok' };
  const host = document.getElementById('webai-host');
  const toast = document.getElementById('webai-toast');
  const share = document.getElementById('share-page');
  const buttons = [...document.querySelectorAll('#ai-switch [data-mode]')];
  let mode = 'agent';
  let lastKey = '';

  // The box the native view covers: the sidebar content area, or nothing when the sidebar is closed.
  function sendBounds() {
    const r = host.getBoundingClientRect();
    const open = mode !== 'agent' && !document.body.classList.contains('sidebar-hidden') && !host.hidden && r.width > 20 && r.height > 20;
    const rect = open ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
    const key = rect ? `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}` : 'none';
    if (key === lastKey) return;
    lastKey = key;
    window.browser.webAiBounds(rect);
  }
  new ResizeObserver(sendBounds).observe(host);
  new MutationObserver(sendBounds).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', sendBounds);

  async function setMode(next, { open = false } = {}) {
    mode = MODES.includes(next) ? next : 'agent';
    const web = mode !== 'agent';
    document.body.classList.toggle('webai-mode', web);
    host.hidden = !web;
    share.hidden = !web;
    for (const b of buttons) {
      const on = b.dataset.mode === mode;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    window.webAiBrand = web ? BRAND[mode] : null;
    if (web) setAssistantIdentity(BRAND[mode]);
    else loadModels(); // back to the agent's model and its mark
    await window.browser.webAiMode(mode);
    if (open && document.body.classList.contains('sidebar-hidden')) showSidebar(true);
    lastKey = '';
    requestAnimationFrame(sendBounds);
  }

  for (const b of buttons) b.addEventListener('click', () => setMode(b.dataset.mode));
  document.getElementById('ai-switch').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = (MODES.indexOf(mode) + (e.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length;
    setMode(MODES[i]).then(() => buttons[i].focus());
  });
  window.browser.onWebAiSwitch?.((i) => setMode(MODES[i], { open: true }));

  let toastTimer = 0;
  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    toast.classList.remove('leaving');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => { toast.hidden = true; }, 220);
    }, 2400);
  }
  share.addEventListener('click', async () => {
    const result = await window.browser.webAiShare();
    showToast(result ? `Page copied — paste it into ${NAME[mode] || 'the chat'}` : 'Nothing to copy from this tab');
  });

  window.browser.webAiState?.().then((s) => { if (s?.mode && s.mode !== 'agent') setMode(s.mode); });

  // ---- [approval over panel] renderer/extras.js switches to Agent for an approval card, then back.
  window.webAiSetMode = (next) => setMode(next);
  window.webAiCurrentMode = () => mode;
  // ---- [/approval over panel]

  // ---- [panel snapshot] During the sidebar spring the native panel is hidden (it can't move with
  // the animation); show main's capture of it in the host instead, until thaw.
  let panelShot = null;
  const freezeBase = window.freezePage;
  const thawBase = window.thawPage;
  window.freezePage = async (...args) => {
    await freezeBase(...args);
    if (mode === 'agent') return;
    const src = await window.lumenExtras?.webAiSnapshot?.();
    if (!src || mode === 'agent') return;
    const img = Object.assign(new Image(), { className: 'webai-snapshot', alt: '', src });
    panelShot?.remove();
    panelShot = img;
    host.append(img);
  };
  window.thawPage = (...args) => {
    thawBase(...args);
    const img = panelShot;
    panelShot = null;
    if (img) setTimeout(() => img.remove(), 160); // after the live panel is back (thaw waits two frames)
  };
  // ---- [/panel snapshot]
})();
