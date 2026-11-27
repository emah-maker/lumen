// [profiles] The Add / Edit profile window: a name, a colour and an avatar (features/profiles-ui.js saves them).
(async () => {
  const $ = (id) => document.getElementById(id);
  const state = await window.profileEditor.init();
  if (!state) return;
  const s = state.strings;
  const title = s[state.mode === 'edit' ? 'edit.title' : 'add.title'];
  document.title = title;
  $('title').textContent = title;
  $('name-label').textContent = s.name;
  $('color-label').textContent = s.color;
  $('avatar-label').textContent = s.avatar;
  $('cancel').textContent = s.cancel;
  $('save').textContent = state.mode === 'edit' ? s.save : s.create;
  const name = $('name');
  name.maxLength = state.maxName;
  name.placeholder = s['name.placeholder'];
  name.value = state.profile.name;

  const hexOf = (id) => (state.colors.find((c) => c.id === id) || state.colors[0]).hex;
  const picked = (group) => document.querySelector(`input[name="${group}"]:checked`)?.value ?? '';
  const letter = () => (Array.from(name.value.trim())[0] || '?').toUpperCase();

  for (const c of state.colors) {
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'color', value: c.id, id: `color-${c.id}`, checked: c.id === state.profile.color });
    input.setAttribute('aria-label', s[`color.${c.id}`] || c.id);
    const swatch = Object.assign(document.createElement('label'), { className: 'swatch', htmlFor: input.id, title: s[`color.${c.id}`] || c.id });
    swatch.style.setProperty('--c', c.hex);
    $('colors').append(input, swatch);
  }
  for (const [i, a] of state.avatars.entries()) {
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'avatar', value: a, id: `avatar-${i}`, checked: a === state.profile.avatar });
    input.setAttribute('aria-label', a || s['avatar.letter']);
    const tile = Object.assign(document.createElement('label'), { className: `avatar${a ? '' : ' letter'}`, htmlFor: input.id, title: a ? '' : s['avatar.letter'] });
    tile.textContent = a || letter();
    $('avatars').append(input, tile);
  }

  const paint = () => {
    $('preview').style.setProperty('--profile', hexOf(picked('color')));
    $('preview').textContent = picked('avatar') || letter();
    document.querySelector('.avatar.letter').textContent = letter();
    $('save').disabled = state.mode === 'edit' && !name.value.trim();
  };
  document.addEventListener('input', paint);
  document.addEventListener('change', paint);
  paint();
  name.focus();
  name.select();

  $('cancel').onclick = () => window.profileEditor.cancel();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.profileEditor.cancel(); });
  $('form').onsubmit = async (e) => {
    e.preventDefault();
    $('save').disabled = true;
    const out = await window.profileEditor.save({ name: name.value, color: picked('color'), avatar: picked('avatar') });
    if (!out || out.error) { $('error').textContent = out?.error || ''; $('save').disabled = false; }
  };
})();
