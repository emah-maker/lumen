// OpenRouter's whole catalog ("More models…"): every model it has, in the same themed picker (renderer/picker.js),
// opened under a model button. Shared by the sidebar (chat-core.js) and Settings (settings.js).
//
// Vendors are named as OpenRouter names them ("NVIDIA: …"), the best known first; each row has a readable name,
// its context size and price, and badges ("free", "chat only"); chips filter to free models, models that can act in
// tabs, or long context. The list is fetched once per page (main keeps it for a day, and serves the last copy when
// offline). A pick becomes the main picker's value and goes through its one change handler.
//
// lumenModelCatalog({ mainSelect, anchor, host, fetchModels, onBack, onFail }) -> { open(query) }
window.lumenModelCatalog = ({ mainSelect, anchor, host, fetchModels, onBack = null, onFail = null }) => {
  const tr = (key, fallback, vars) => {
    let s = window.t ? window.t(key, vars) : key;
    if (!s || s === key) s = fallback;
    return vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : s;
  };
  let select = null;
  let picker = null;
  let loading = false;
  const hasBadge = (o, b) => (o.dataset.badges || '').split(',').includes(b);
  function ensure() {
    if (select) return;
    select = Object.assign(document.createElement('select'), { hidden: true });
    select.setAttribute('aria-label', tr('models.search', 'Search OpenRouter models'));
    host.append(select);
    picker = window.lumenPicker(select, {
      recentKey: 'model', anchor, title: 'models.allOpenRouter', placeholder: tr('models.search', 'Search OpenRouter models'), headings: true, onBack, wide: true,
      filters: [
        { key: 'free', label: tr('models.filter.free', 'Free'), test: (o) => hasBadge(o, 'free') },
        { key: 'tools', label: tr('models.filter.tools', 'Can act in tabs'), test: (o) => !hasBadge(o, 'chat only') },
        { key: 'long', label: tr('models.filter.long', '128K+ context'), test: (o) => Number(o.dataset.context) >= 128000 },
      ],
    });
    select.addEventListener('change', () => {
      const picked = select.selectedOptions[0];
      if (!picked) return;
      if (![...mainSelect.options].some((o) => o.value === picked.value)) {
        const o = picked.cloneNode(true);
        o.dataset.provider = 'OpenRouter';
        (mainSelect.querySelector('optgroup[label="OpenRouter"]') || mainSelect).append(o);
      }
      mainSelect.value = picked.value;
      mainSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  const VENDORS = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', 'x-ai': 'xAI', 'meta-llama': 'Meta', mistralai: 'Mistral', deepseek: 'DeepSeek', qwen: 'Qwen', openrouter: 'OpenRouter' };
  const FIRST = ['anthropic', 'openai', 'google', 'x-ai', 'meta-llama', 'mistralai', 'deepseek', 'qwen'];
  const short = (n) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
  // A price per million input tokens: OpenRouter gives -1 for a price that varies (its router), shown as such.
  const priceText = (p) => (!Number.isFinite(p) ? '' : p < 0 ? tr('models.priceVaries', 'price varies') : p === 0 ? '' : p < 0.01 ? tr('models.priceTiny', '<$0.01/M input') : tr('models.price', '${n}/M input', { n: p < 1 ? p.toFixed(2) : String(Math.round(p * 10) / 10) }));
  function build(models) {
    // Vendors by the names OpenRouter itself gives them: the most common prefix of that vendor's model names.
    const prefixes = new Map();
    for (const m of models) {
      const v = String(m.id).split('/')[0];
      const p = String(m.name).includes(':') ? String(m.name).split(':')[0].trim() : '';
      if (!p) continue;
      const counts = prefixes.get(v) || new Map();
      counts.set(p, (counts.get(p) || 0) + 1);
      prefixes.set(v, counts);
    }
    const vendorName = (v) => VENDORS[v] || [...(prefixes.get(v) || new Map())].sort((a, b) => b[1] - a[1])[0]?.[0] || v.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const vendors = new Map();
    for (const m of models) {
      const vendor = String(m.id).split('/')[0];
      if (!vendors.has(vendor)) vendors.set(vendor, Object.assign(document.createElement('optgroup'), { label: vendorName(vendor) }));
      const o = Object.assign(document.createElement('option'), { value: `openrouter:${m.id}`, textContent: m.name, title: m.id });
      // The name without its vendor ("NVIDIA: ") and without "(free)", which the badge says once.
      const bare = String(m.name).includes(':') ? String(m.name).split(':').slice(1).join(':').trim() : String(m.name);
      o.dataset.name = bare.replace(/\s*\(free\)\s*$/i, '').trim() || bare;
      // (No provider tag here: every row is OpenRouter's, so it would match every search.)
      const bits = [m.context ? tr('models.context', '{n} context', { n: short(m.context) }) : '', priceText(m.pricePerM)].filter(Boolean);
      if (bits.length) o.dataset.detail = bits.join(' · ');
      if (m.context) o.dataset.context = String(m.context);
      o.dataset.badges = [m.free || m.pricePerM === 0 ? 'free' : '', m.tools ? '' : 'chat only'].filter(Boolean).join(',');
      vendors.get(vendor).append(o);
    }
    const rank = (v) => { const i = FIRST.indexOf(v); return i === -1 ? FIRST.length : i; };
    // Vendors with one or two models share an "Other vendors" section at the end (each row keeps its vendor's name
    // as its tag, so a search for it still finds them), instead of dozens of tiny headings.
    const other = Object.assign(document.createElement('optgroup'), { label: tr('models.otherVendors', 'Other vendors') });
    other.dataset.search = ''; // found by each row's vendor, not by the words "other vendors"
    const kept = [];
    for (const [v, g] of vendors) {
      if (FIRST.includes(v) || g.children.length > 2) { kept.push([v, g]); continue; }
      for (const o of [...g.children]) { o.dataset.provider = g.label; o.dataset.detail = [g.label, o.dataset.detail].filter(Boolean).join(' · '); other.append(o); }
    }
    const out = kept.sort((a, b) => rank(a[0]) - rank(b[0]) || a[1].label.localeCompare(b[1].label)).map(([, g]) => g);
    if (other.children.length) out.push(other);
    return out;
  }
  let shownKey = '';
  const catalogKey = (models) => (models?.length ? models.map((m) => `${m.id}:${m.pricePerM ?? ''}:${m.context || ''}`).join('|') : '');
  async function open(query = '') {
    ensure();
    select.value = mainSelect.value;
    if (select.options.length) {
      picker.open(query);
      // A fresher list than the one drawn (main refreshes a day-old copy behind the scenes): swapped in quietly.
      const models = await Promise.resolve().then(fetchModels).catch(() => null);
      const key = catalogKey(models);
      if (key && key !== shownKey && !picker.menu.hidden) { shownKey = key; select.replaceChildren(...build(models)); select.value = mainSelect.value; picker.refresh(); }
      return;
    }
    // First time: the list opens at once, saying it is loading, and fills in when the catalog arrives (one fetch,
    // however often it is asked for meanwhile).
    picker.setLoading(true);
    picker.open(query);
    if (loading) return;
    loading = true;
    const models = await Promise.resolve().then(fetchModels).catch(() => []);
    loading = false;
    picker.setLoading(false);
    if (!models?.length) { const open = !picker.menu.hidden; picker.close(open); if (open) onFail?.(tr('models.loadFailed', 'Couldn’t load the model list.')); return; }
    shownKey = catalogKey(models);
    select.replaceChildren(...build(models));
    select.value = mainSelect.value;
    picker.refresh();
  }
  // A fresher catalog arrived (models-updated) while this list is open: swapped in, where it stands.
  async function refreshOpen() {
    if (!picker || picker.menu.hidden || loading) return;
    const models = await Promise.resolve().then(fetchModels).catch(() => null);
    const key = catalogKey(models);
    if (key && key !== shownKey && !picker.menu.hidden) { shownKey = key; select.replaceChildren(...build(models)); select.value = mainSelect.value; picker.refresh(); }
  }
  return { open, refreshOpen };
};
