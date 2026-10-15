// Pictures in the new-tab page's Ask AI box (the rules: features/newtab-images.js). The box takes them by paste, by drop and by the attach
// button (main opens the picker: window.lumenNewtab.pickImages, preload/newtab-preload.js); they show as small chips under the field, each
// with an x, and travel to the chat with the question (window.lumenNewtab.askAi), never in the page's address.
// window.NewtabImages.create({ form, input, strip, attach, dropNote, bridge, toAsk, say }) -> { count, take, clear, add, strings }
(function () {
'use strict';

// Words, translated when the page was given a table (window.lumenI18n.strings), else English (locales/en.json newtab.images.*).
const STRINGS = {
  'newtab.images.attach': 'Attach images',
  'newtab.images.attach.full': 'Attach images (the limit of {max} is reached)',
  'newtab.images.group': 'Attached images',
  'newtab.images.remove': 'Remove image',
  'newtab.images.drop': 'Drop images to add them',
  'newtab.images.goToAsk': 'Images go to Ask AI',
  'newtab.images.notImage': '{name} is not a picture the chat can take.',
  'newtab.images.empty': '{name} is empty.',
  'newtab.images.big': '{name} is over {mb} MB.',
  'newtab.images.unreadable': '{name} could not be read.',
  'newtab.images.limit': 'Up to {max} images: {n} left out.',
};
const text = (key, vars) => {
  const own = window.lumenI18n?.strings?.[key];
  const raw = typeof own === 'string' ? own : STRINGS[key];
  return raw.replace(/\{(\w+)\}/g, (whole, name) => (vars && name in vars ? String(vars[name]) : whole));
};

function create({ form, input, strip, attach, dropNote, bridge, toAsk, say }) {
  const R = window.NewtabImageRules;
  let items = []; // { id, type, name, blob, url (a data: URL for the thumbnail, once read) }
  let nextId = 1;

  const labels = () => {
    const full = items.length >= R.MAX_IMAGES;
    attach.setAttribute('aria-label', text('newtab.images.attach'));
    attach.title = full ? text('newtab.images.attach.full', { max: R.MAX_IMAGES }) : text('newtab.images.attach');
    strip.setAttribute('aria-label', text('newtab.images.group'));
    if (dropNote) dropNote.textContent = text('newtab.images.drop');
  };
  function render() {
    strip.hidden = items.length === 0;
    strip.replaceChildren(...items.map((item) => {
      const chip = document.createElement('span');
      chip.className = 'ni-chip';
      const img = document.createElement('img');
      img.alt = '';
      if (item.url) img.src = item.url;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', text('newtab.images.remove'));
      remove.title = text('newtab.images.remove');
      remove.addEventListener('click', () => { items = items.filter((i) => i !== item); render(); input.focus(); });
      chip.append(img, remove);
      return chip;
    }));
    labels();
  }

  const problemText = (p) => text(`newtab.images.${p.code === 'limit' ? 'limit' : ['notImage', 'empty', 'big'].includes(p.code) ? p.code : 'unreadable'}`, { name: p.name || '?', mb: Math.round(R.MAX_BYTES / 1048576), max: R.MAX_IMAGES, n: p.name });
  // Adds pictures: [{ name, type, size, blob }]. Anything that cannot be taken is said, never skipped silently.
  function add(list) {
    const { take, problems } = R.plan(items.length, list);
    let switched = false;
    if (take.length) {
      switched = toAsk(); // pictures go to Ask AI: the box switches to it (true when it was in Search)
      for (const { file, type } of take) {
        const item = { id: nextId++, type, name: file.name || '', blob: file.blob, url: '' };
        items.push(item);
        const reader = new FileReader();
        reader.onload = () => { item.url = String(reader.result); if (items.includes(item)) render(); };
        reader.readAsDataURL(file.blob);
      }
      render();
    }
    if (problems.length) say(problems.map(problemText).join(' '));
    else if (switched) say(text('newtab.images.goToAsk'), 4000);
    return take.length;
  }
  // File objects (paste, drop)
  const addFiles = (files) => add([...files].map((f) => ({ name: f.name || '', type: f.type, size: f.size, blob: f })));

  // ---- paste: a picture on the clipboard joins; text pastes as usual
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  // ---- drop (files, or a picture dragged from a page), with a clear drop state
  const hasFiles = (dt) => [...(dt?.types || [])].includes('Files');
  const setDrop = (on) => { form.classList.toggle('ni-drop', on); if (dropNote) dropNote.hidden = !on; };
  form.addEventListener('dragenter', (e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); setDrop(true); } });
  form.addEventListener('dragover', (e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDrop(true); } });
  form.addEventListener('dragleave', (e) => { if (!form.contains(e.relatedTarget)) setDrop(false); });
  form.addEventListener('drop', (e) => {
    setDrop(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  // ---- the attach button: main opens the OS picker and hands back what was chosen
  attach.addEventListener('click', async () => {
    if (!bridge?.pickImages) return;
    let got = null;
    try { got = await bridge.pickImages(); } catch { got = null; }
    if (!got) return;
    const list = (got.images || []).map((p) => ({ name: p.name || '', type: p.type, size: p.data?.byteLength || 0, blob: new Blob([p.data], { type: p.type }) }));
    const extra = (got.problems || []).map(problemText);
    const before = items.length;
    add(list);
    if (extra.length && items.length === before) say(extra.join(' '));
    input.focus();
  });

  // ---- Backspace in an empty field removes the last chip
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && items.length && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      items.pop();
      render();
    }
  });

  render();
  return {
    count: () => items.length,
    clear: () => { items = []; render(); },
    // what askAi takes: [{ type, name, data: ArrayBuffer }]
    take: () => Promise.all(items.map(async (i) => ({ type: i.type, name: i.name, data: await i.blob.arrayBuffer() }))),
    add, addFiles, text,
  };
}

window.NewtabImages = { create, STRINGS };
})();
