// The translate infobar and address bar button. main.js (features/translate.js) owns the state and
// sends it with every tab update (tab.translate); this file only draws it and sends back clicks.
// Nothing here starts a translation by itself: every send goes through a click.
(() => {
  const bar = document.getElementById('translate-bar');
  const end = document.querySelector('.omnibox-end');
  if (!bar || !end || !window.browser?.translateAct) return;
  const tr = (key, english, vars) => {
    const text = window.t ? window.t(key, vars) : key;
    return text === key ? english.replace(/\{(\w+)\}/g, (w, n) => (vars && n in vars ? String(vars[n]) : w)) : text;
  };
  const act = (action, arg) => window.browser.translateAct(action, arg);

  const btn = document.createElement('button');
  btn.className = 'omnibox-action translate-btn';
  btn.id = 'translate-btn';
  btn.type = 'button';
  btn.hidden = true;
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h7M5.5 2.5V4M3.5 4c.4 2.3 1.9 4 4 5M8 4c-.4 2.3-2 4.2-4.6 5.3M8.5 13.5l2.5-6 2.5 6M9.3 11.5h3.4"/></svg>';
  end.insertBefore(btn, document.getElementById('reader') || end.firstChild);
  btn.addEventListener('click', () => act('menu'));

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (label, onclick, cls) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', onclick); return b; };
  const ERRORS = {
    private: ['translate.error.private', 'Pages in private windows aren’t translated.'],
    unsupported: ['translate.error.unsupported', 'Only web pages can be translated.'],
    'no-engine': ['translate.error.noEngine', 'No AI is connected for translation. Connect one in Settings, or use Google Translate from the menu.'],
    'unsupported-pair': ['translate.error.unsupportedPair', 'There is no on-device language pack for this pair yet.'],
    'unknown-language': ['translate.error.unknownLanguage', 'Couldn’t tell what language this page is in.'],
    'same-language': ['translate.error.sameLanguage', 'This page is already in that language.'],
    'download-failed': ['translate.error.downloadFailed', 'Couldn’t download the language pack. Check your connection and try again.'],
    'pack-removed': ['translate.error.packRemoved', 'The language pack was deleted while it was downloading. Try again to download it.'],
    'registry-failed': ['translate.error.registryFailed', 'Couldn’t reach Mozilla’s list of language packs. Check your connection and try again.'],
  };
  let shown = '';

  function draw(st) {
    const tab = st && st.phase !== 'idle' ? st : null;
    btn.hidden = !tab;
    btn.setAttribute('aria-pressed', String(Boolean(tab?.translated)));
    const label = tr('translate.button', 'Translate page');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    let key = '';
    if (tab && !tab.dismissed) key = `${tab.phase}|${tab.provider}|${tab.error}|${tab.lang}|${tab.target}|${tab.progress}|${tab.via}|${tab.size}|${tab.pair}|${tab.detail}`;
    if (key === shown) return;
    shown = key;
    if (!key) { bar.hidden = true; bar.replaceChildren(); return; }
    const parts = [];
    const text = el('span', 'infobar-text');
    const vars = { language: tab.langName || tab.lang, target: tab.targetName, provider: tab.provider, pair: tab.pair, size: tab.size, percent: tab.progress };
    let close = 'dismiss';
    switch (tab.phase) {
      case 'offer':
        text.textContent = tab.langName ? tr('translate.offer', 'This page is in {language}. Translate to {target}?', vars) : tr('translate.offerNoLang', 'Translate this page to {target}?', vars);
        parts.push(button(tr('translate.offer.yes', 'Translate'), () => act('translate', tab.target), 'primary'),
          button(tr('translate.notNow', 'Not now'), () => act('not-now')),
          button(tr('translate.never', 'Never for this site'), () => act('never')));
        close = 'not-now';
        break;
      case 'consent': {
        const google = tab.provider === 'Google Translate';
        text.textContent = google
          ? tr('translate.consent.google', 'Sends this page’s address to Google Translate, which opens the translated page.')
          : tr('translate.consent.ai', 'Sends this page’s text to {provider} to translate it.', vars);
        parts.push(button(google ? tr('translate.consent.continue', 'Continue') : tr('translate.consent.allow', 'Allow and translate'), () => act('allow'), 'primary'),
          button(tr('translate.cancel', 'Cancel'), () => act('cancel')));
        close = 'cancel';
        break;
      }
      case 'download-consent':
        text.textContent = tr('translate.download.ask', 'Download the {pair} language pack ({size}) to translate on this device? It comes from Mozilla once; your pages never leave this computer.', vars);
        parts.push(button(tr('translate.download.yes', 'Download and translate'), () => act('download'), 'primary'),
          button(tr('translate.download.always', 'Always download'), () => act('download-always')),
          button(tr('translate.cancel', 'Cancel'), () => act('cancel')));
        close = 'cancel';
        break;
      case 'download': {
        close = 'original'; // the download and the translation go on after a plain dismiss, so × cancels like the button
        text.textContent = tr('translate.downloading', 'Downloading {pair} ({size})… {percent}%', vars);
        const meter = el('progress');
        meter.max = 100;
        meter.value = tab.progress;
        meter.setAttribute('aria-label', text.textContent);
        parts.push(meter, button(tr('translate.cancel', 'Cancel'), () => act('original')));
        break;
      }
      case 'working': {
        close = 'original';
        text.textContent = tr('translate.working', 'Translating… {percent}%', { percent: tab.progress });
        const meter = el('progress');
        meter.max = 100;
        meter.value = tab.progress;
        meter.setAttribute('aria-label', text.textContent);
        parts.push(meter, button(tr('translate.cancel', 'Cancel'), () => act('original')));
        break;
      }
      case 'done':
        text.textContent = tab.via === 'local' ? tr('translate.done.local', 'Translated to {target} on this device.', vars) : tr('translate.done', 'Translated to {target}.', vars);
        if (tab.error === 'capped') text.append(' ', el('span', 'infobar-note', tr('translate.capped', 'A long page: some of it was left as written.')));
        parts.push(button(tr('translate.showOriginal', 'Show original'), () => act('original'), 'primary'),
          button(tr('translate.again', 'Translate again'), () => act('again')));
        break;
      case 'error': {
        const known = ERRORS[tab.error];
        const network = tab.error === 'download-failed' || tab.error === 'registry-failed';
        const offline = network && (navigator.onLine === false || /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|no data for|timed out/i.test(tab.detail || ''));
        const noSpace = tab.error === 'download-failed' && /ENOSPC|free disk space|no space/i.test(tab.detail || '');
        if (noSpace) text.textContent = tr('translate.error.noSpace', 'Not enough free disk space for the language pack.');
        else if (offline) text.textContent = tab.error === 'registry-failed'
          ? tr('translate.error.registryOffline', 'You appear to be offline, so Lumen can’t get Mozilla’s list of language packs. Connect and try again.')
          : tr('translate.error.downloadOffline', 'You appear to be offline, so the language pack couldn’t download. Connect and try again.');
        else text.textContent = known ? tr(known[0], known[1]) : tr('translate.error', 'Couldn’t translate this page: {error}', { error: tab.error });
        if (tab.detail && network && !offline && !noSpace) text.append(' ', el('span', 'infobar-note', tab.detail));
        parts.push(button(tr('translate.tryAgain', 'Try again'), () => act('translate', tab.target)));
        break;
      }
      default: break;
    }
    const x = el('button', 'infobar-close', '×');
    x.type = 'button';
    x.setAttribute('aria-label', tr('translate.close', 'Close'));
    x.addEventListener('click', () => act(close));
    bar.replaceChildren(text, ...parts, x);
    bar.hidden = false;
    if (tab.phase === 'working' || tab.phase === 'download') bar.setAttribute('aria-busy', 'true'); else bar.removeAttribute('aria-busy');
  }

  window.browser.onTabs((state) => {
    const active = state?.tabs?.find((t) => t.id === state.activeId);
    draw(active?.translate || null);
  });
})();
