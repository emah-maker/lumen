// [profiles] The toolbar's profile button: this window's profile (its avatar, or its first letter, on its colour). Shown once
// there is more than one profile; the click opens the profile menu (features/profiles-ui.js: switch, Add, Edit, Delete).
(() => {
  const btn = document.getElementById('profile-btn');
  const avatar = document.getElementById('profile-avatar');
  if (!btn || !window.browser?.profileInfo) return;
  const show = (p) => {
    if (!p) return;
    btn.hidden = !(p.count > 1);
    avatar.textContent = p.avatar || p.initial;
    avatar.classList.toggle('emoji', Boolean(p.avatar));
    avatar.style.setProperty('--profile-color', p.color);
    const label = `${window.t ? window.t('profiles.button') : 'Profiles'}: ${p.name}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.dataset.profile = p.id;
  };
  window.browser.profileInfo().then(show).catch(() => {});
  window.browser.onProfileChanged?.(show);
  btn.onclick = () => {
    const r = btn.getBoundingClientRect();
    window.browser.openProfileMenu({ x: Math.round(r.left), y: Math.round(r.bottom) });
  };
})();
