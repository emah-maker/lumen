// The slide viewer (features/slides-viewer.js): the main process calls lumenSlides once with a deck parsed by
// features/pptx.js: plain JSON, positions in EMU, colors as #rrggbb, text as plain strings, pictures as data:
// URLs. Everything is drawn with createElement / textContent and style properties, never HTML, and a
// picture is used only if it is a data:image/ URL (the page's CSP allows nothing else either).
// Slides are drawn when they come near the view, so a long deck opens quickly.
(() => {
  const EMU_PER_PT = 12700;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
  const pt = (emu) => (Number(emu) || 0) / EMU_PER_PT;
  const HEX = /^#[0-9a-f]{6}$/i;
  const rgba = (color, alpha = 1) => {
    if (!HEX.test(color || '')) return null;
    const n = parseInt(color.slice(1), 16);
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    return a >= 1 ? color : `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };
  const FONT = /^[\p{L}\p{N} ._-]{1,64}$/u;
  const fontStack = (name) => (name && FONT.test(name) ? `"${name}", Calibri, Carlito, "Segoe UI", Arial, sans-serif` : '');

  let deck = null;
  let media = {};
  let mediaInfo = {};
  let alias = {};
  let expected = new Set(); // pictures that are, or are on their way (the main process sends them after the structure, slice by slice)
  const complete = new Set(); // ...and the ones whole
  const arrivals = new Map(); // picture part -> { promise, resolve }
  const arrival = (key) => { if (!arrivals.has(key)) { let resolve; const promise = new Promise((r) => { resolve = r; }); arrivals.set(key, { promise, resolve }); } return arrivals.get(key); };
  let frames = [];
  let current = 0;
  const canon = (key) => (typeof key === 'string' && typeof alias[key] === 'string' ? alias[key] : key);
  const imageUrl = (key) => { const k = canon(key); return typeof k === 'string' && expected.has(k) ? k : null; }; // (truthy when that picture is there or coming)
  const dataOf = (key) => { const v = media[canon(key)]; return typeof v === 'string' && v.startsWith('data:image/') ? v : null; };

  // ---- pictures
  // Each distinct picture becomes one blob: URL (made when first needed; a very large one is shrunk first), shared by every use of it.
  // A picture is an <img> (loading=lazy, decoding=async) in a layer that holds the crop, the stretch, the effects or a tile.
  const SHRINK_SIDE = 3600; // a picture longer than this, or with more than SHRINK_PIXELS, is shrunk to FIT_SIDE on its long side
  const SHRINK_PIXELS = 12e6;
  const FIT_SIDE = 2560;
  const SVG = 'http://www.w3.org/2000/svg';
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function blobOf(dataUrl) {
    const type = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const STEP = 1 << 20; // (a multiple of 4: each slice is whole base64 groups)
    const parts = [];
    for (let i = 0, n = 0; i < b64.length; i += STEP, n++) {
      const slice = b64.slice(i, i + STEP);
      if (typeof Uint8Array.fromBase64 === 'function') parts.push(Uint8Array.fromBase64(slice));
      else { const bin = atob(slice); const u = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k); parts.push(u); }
      if (n % 3 === 2) await tick(); // (a big picture never holds the page for long)
    }
    return new Blob(parts, { type });
  }
  const shown = new Map(); // picture part -> Promise<blob: URL | null>
  const shrunk = new Set();
  function displayUrl(key) {
    const k = canon(key);
    if (shown.has(k)) return shown.get(k);
    const job = (async () => {
      if (!imageUrl(k)) return null;
      if (!complete.has(k)) await arrival(k).promise;
      const data = dataOf(k);
      if (!data) return null;
      let blob = await blobOf(data);
      const info = mediaInfo[k];
      if (info && info.w && info.h && blob.type !== 'image/svg+xml' && blob.type !== 'image/gif' && (Math.max(info.w, info.h) > SHRINK_SIDE || info.w * info.h > SHRINK_PIXELS)) {
        try {
          const scale = FIT_SIDE / Math.max(info.w, info.h);
          const bitmap = await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(info.w * scale)), resizeHeight: Math.max(1, Math.round(info.h * scale)), resizeQuality: 'high' });
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          bitmap.close();
          blob = await canvas.convertToBlob(blob.type === 'image/jpeg' ? { type: 'image/jpeg', quality: 0.92 } : { type: 'image/png' });
          shrunk.add(k);
        } catch { /* shown at full size */ }
      }
      return URL.createObjectURL(blob);
    })().catch(() => null);
    shown.set(k, job);
    return job;
  }
  // The SVG twin when there is one (sharp at any size), the picture itself if the SVG will not draw.
  function loadInto(img, key, svgKey) {
    const first = svgKey && imageUrl(svgKey) ? svgKey : key;
    img.addEventListener('error', () => { if (first !== key && imageUrl(key)) displayUrl(key).then((u) => { if (u) img.src = u; }); }, { once: true });
    displayUrl(first).then((u) => { if (u) img.src = u; });
  }
  let filterHost = null;
  let filterCount = 0;
  // a:duotone: the picture's gray level mapped between two colors (an SVG filter per use)
  function duotoneFilter(colors) {
    const id = `duo${++filterCount}`;
    if (!filterHost) { filterHost = document.createElementNS(SVG, 'svg'); filterHost.setAttribute('width', '0'); filterHost.setAttribute('height', '0'); filterHost.style.position = 'absolute'; document.body.append(filterHost); }
    const f = document.createElementNS(SVG, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('color-interpolation-filters', 'sRGB');
    const gray = document.createElementNS(SVG, 'feColorMatrix');
    gray.setAttribute('type', 'saturate'); gray.setAttribute('values', '0');
    const table = document.createElementNS(SVG, 'feComponentTransfer');
    const [a, b] = colors.map((c) => [1, 3, 5].map((i) => (parseInt(c.slice(i, i + 2), 16) / 255).toFixed(4)));
    ['R', 'G', 'B'].forEach((ch, i) => { const fn = document.createElementNS(SVG, `feFunc${ch}`); fn.setAttribute('type', 'table'); fn.setAttribute('tableValues', `${a[i]} ${b[i]}`); table.append(fn); });
    f.append(gray, table);
    filterHost.append(f);
    return id;
  }
  function effectsOf(fx) {
    const out = {};
    if (!fx) return out;
    if (typeof fx.alpha === 'number' && fx.alpha < 1) out.opacity = String(Math.max(0, fx.alpha));
    const f = [];
    if (Array.isArray(fx.duotone) && fx.duotone.every((c) => HEX.test(c))) f.push(`url(#${duotoneFilter(fx.duotone)})`);
    else if (fx.bw) f.push('grayscale(1) contrast(1000%)');
    else if (fx.gray) f.push('grayscale(1)');
    if (fx.bright) f.push(`brightness(${Math.max(0, 1 + Number(fx.bright))})`);
    if (fx.contrast) f.push(`contrast(${Math.max(0, 1 + Number(fx.contrast))})`);
    if (f.length) out.filter = f.join(' ');
    return out;
  }
  const PX_PER_PT = 0.75; // a tiled picture's own size: its pixels at 96 dpi, in points (the stage's unit)
  // A picture (a pic, or a fill: { image, svg, crop, fillRect, tile, fx }) filling its box: cropped, stretched into the fill rectangle, or tiled.
  function imageLayer(f, { alt = '', flip = '' } = {}) {
    const layer = el('div', 'imglayer');
    Object.assign(layer.style, effectsOf(f.fx));
    if (f.tile) {
      const info = mediaInfo[canon(f.image)] || {};
      layer.classList.add('tiled');
      layer.style.backgroundRepeat = 'repeat';
      if (info.w && info.h) layer.style.backgroundSize = `${info.w * PX_PER_PT * f.tile.sx}px ${info.h * PX_PER_PT * f.tile.sy}px`;
      layer.style.backgroundPosition = `${pt(f.tile.tx)}px ${pt(f.tile.ty)}px`;
      displayUrl(f.image).then((u) => { if (u) layer.style.backgroundImage = `url("${u}")`; });
      return layer;
    }
    const fit = el('div', 'imgfit'); // the stretch target; the flip is here, so a crop mirrors with the picture
    const [fl, ft, fr, fb] = Array.isArray(f.fillRect) ? f.fillRect.map((v) => Number(v) || 0) : [0, 0, 0, 0];
    fit.style.left = `${fl * 100}%`;
    fit.style.top = `${ft * 100}%`;
    fit.style.width = `${(1 - fl - fr) * 100}%`;
    fit.style.height = `${(1 - ft - fb) * 100}%`;
    if (flip) fit.style.transform = flip;
    const img = el('img');
    img.alt = String(alt);
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    const [cl, ct, cr, cb] = Array.isArray(f.crop) ? f.crop.map((v) => Number(v) || 0) : [0, 0, 0, 0];
    const wFrac = Math.max(0.01, 1 - cl - cr);
    const hFrac = Math.max(0.01, 1 - ct - cb);
    img.style.width = `${100 / wFrac}%`;
    img.style.height = `${100 / hFrac}%`;
    img.style.left = `${(-cl / wFrac) * 100}%`;
    img.style.top = `${(-ct / hFrac) * 100}%`;
    fit.append(img);
    layer.append(fit);
    loadInto(img, f.image, f.svg);
    return layer;
  }
  const hasPicture = (f) => Boolean(f && (imageUrl(f.image) || imageUrl(f.svg)));

  function fillCss(fill) {
    if (!fill) return null;
    if (fill.type === 'solid') return { backgroundColor: rgba(fill.color, fill.alpha) };
    if (fill.type === 'gradient' && Array.isArray(fill.stops)) {
      const stops = fill.stops.map((s) => `${rgba(s.color, s.alpha) || 'transparent'} ${Math.max(0, Math.min(100, Number(s.pos) || 0))}%`).join(', ');
      return { backgroundImage: fill.radial ? `radial-gradient(circle, ${stops})` : `linear-gradient(${(Number(fill.angle) || 0) + 90}deg, ${stops})` };
    }
    return null; // (a picture fill is a layer: imageLayer)
  }
  function applyFill(node, fill) {
    if (fill && fill.type === 'image') { if (hasPicture(fill)) node.prepend(imageLayer(fill)); return; }
    const css = fillCss(fill);
    if (css) Object.assign(node.style, css);
  }

  function placeBox(node, s) {
    node.style.left = `${pt(s.x)}px`;
    node.style.top = `${pt(s.y)}px`;
    node.style.width = `${pt(s.w)}px`;
    node.style.height = `${pt(s.h)}px`;
    if (s.rot) node.style.transform = `rotate(${Number(s.rot) || 0}deg)`;
  }
  const flipOf = (s) => (s.flipH || s.flipV ? `scale(${s.flipH ? -1 : 1}, ${s.flipV ? -1 : 1})` : '');

  // ---- text
  function spacingPx(sp, size) {
    if (!sp) return 0;
    if (sp.pt !== undefined) return Number(sp.pt) || 0;
    return (Number(sp.pct) || 0) * size * 1.2;
  }
  function drawParagraphs(container, paragraphs) {
    for (const p of paragraphs || []) {
      const node = el('p');
      const size = (p.runs || []).find((r) => r.size)?.size || p.emptySize || 18;
      node.style.textAlign = ['left', 'center', 'right', 'justify'].includes(p.align) ? p.align : 'left';
      if (p.marL) node.style.paddingLeft = `${Math.max(0, Number(p.marL) || 0)}px`;
      if (p.indent) node.style.textIndent = `${Number(p.indent) || 0}px`;
      if (p.spaceBefore) node.style.marginTop = `${spacingPx(p.spaceBefore, size)}px`;
      if (p.spaceAfter) node.style.marginBottom = `${spacingPx(p.spaceAfter, size)}px`;
      if (p.lineSpacing?.pct) node.style.lineHeight = String(1.2 * Math.max(0.5, Number(p.lineSpacing.pct) || 1));
      else if (p.lineSpacing?.pt) node.style.lineHeight = `${Number(p.lineSpacing.pt) || 0}px`;
      const runs = (p.runs || []).filter((r) => r.text);
      if (p.bullet && runs.length) {
        const b = el('span', 'bullet');
        b.textContent = `${String(p.bullet.text || '').slice(0, 4)}\u00a0`;
        if (p.marL) { b.style.minWidth = `${Math.max(0, -(Number(p.indent) || 0))}px`; b.style.textIndent = '0'; }
        b.style.fontSize = `${size}px`;
        const c = rgba(p.bullet.color) || rgba(runs[0].color, runs[0].alpha);
        if (c) b.style.color = c;
        node.append(b);
      }
      if (!runs.length) {
        node.style.fontSize = `${Number(p.emptySize) || 18}px`;
        node.append(el('br'));
      }
      for (const r of runs) {
        if (r.text === '\n') { node.append(el('br')); continue; }
        const span = el('span');
        span.textContent = String(r.text);
        let fontSize = Math.max(1, Number(r.size) || 18);
        if (r.baseline) { span.style.verticalAlign = r.baseline === 'super' ? 'super' : 'sub'; fontSize *= 0.7; }
        span.style.fontSize = `${fontSize}px`;
        if (r.bold) span.style.fontWeight = '700';
        if (r.italic) span.style.fontStyle = 'italic';
        const deco = [r.underline && 'underline', r.strike && 'line-through'].filter(Boolean).join(' ');
        if (deco) span.style.textDecoration = deco;
        if (r.caps) span.style.textTransform = 'uppercase';
        const c = rgba(r.color, r.alpha ?? 1);
        if (c) span.style.color = c;
        const f = fontStack(r.font);
        if (f) span.style.fontFamily = f;
        node.append(span);
      }
      container.append(node);
    }
  }
  function drawText(box, text) {
    const t = el('div', `text${text.wrap === false ? ' nowrap' : ''}`);
    const [l, top, r, b] = (text.insets || [7.2, 3.6, 7.2, 3.6]).map((v) => Math.max(0, Number(v) || 0));
    t.style.padding = `${top}px ${r}px ${b}px ${l}px`;
    t.style.justifyContent = { middle: 'center', bottom: 'flex-end' }[text.anchor] || 'flex-start';
    if (text.vert) { t.style.writingMode = 'vertical-rl'; if (text.vert === 'vert270') t.style.transform = 'rotate(180deg)'; }
    drawParagraphs(t, text.paragraphs);
    box.append(t);
  }

  // ---- shapes
  function shapeGeometry(node, s) {
    if (s.geom === 'ellipse') node.style.borderRadius = '50%';
    else if (s.geom === 'roundRect') node.style.borderRadius = `${Math.min(pt(s.w), pt(s.h)) * Math.max(0, Math.min(0.5, Number(s.radius) || 0.1667))}px`;
    else if (s.geom === 'polygon' && /^[\d.% ,]+$/.test(s.points || '')) node.style.clipPath = `polygon(${s.points})`;
  }
  function drawShape(s) {
    const box = el('div', 'shape');
    placeBox(box, s);
    const bg = el('div', 'bg');
    applyFill(bg, s.fill);
    if (s.line && HEX.test(s.line.color || '')) {
      bg.style.border = `${Math.max(0.25, Number(s.line.width) || 0.75)}px ${s.line.dash ? 'dashed' : 'solid'} ${rgba(s.line.color, s.line.alpha ?? 1)}`;
    }
    shapeGeometry(bg, s);
    const flip = flipOf(s);
    if (flip) bg.style.transform = flip;
    box.append(bg);
    if (s.text) drawText(box, s.text);
    return box;
  }
  function drawPicture(s) {
    const link = typeof s.link === 'string' && /^(https?:|mailto:)/i.test(s.link) ? s.link : null;
    const box = el(link ? 'a' : 'div', 'pic');
    if (link) { box.href = link; box.target = '_blank'; box.rel = 'noopener noreferrer'; box.title = link; }
    placeBox(box, s);
    shapeGeometry(box, s);
    if (!hasPicture(s)) {
      const info = mediaInfo[canon(s.image)] || {};
      box.classList.add('missing');
      const why = s.format === 'linked' ? 'linked picture' : info.missing ? `${String(info.missing).replace(/[^a-z0-9]/gi, '').slice(0, 5).toUpperCase()} picture` : '';
      box.textContent = `Picture not shown${why ? ` (${why})` : ''}${s.alt ? `: ${s.alt}` : ''}`;
      return box;
    }
    box.append(imageLayer(s, { alt: s.alt, flip: flipOf(s) }));
    if (s.line && HEX.test(s.line.color || '')) box.style.border = `${Math.max(0.25, Number(s.line.width) || 0.75)}px solid ${rgba(s.line.color, s.line.alpha ?? 1)}`;
    return box;
  }
  function drawLine(s) {
    const w = pt(s.w); const h = pt(s.h);
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'line');
    svg.style.left = `${pt(s.x)}px`;
    svg.style.top = `${pt(s.y)}px`;
    svg.setAttribute('width', String(Math.max(1, w)));
    svg.setAttribute('height', String(Math.max(1, h)));
    if (s.rot) { svg.style.transform = `rotate(${Number(s.rot) || 0}deg)`; svg.style.transformOrigin = `${w / 2}px ${h / 2}px`; }
    const line = document.createElementNS(SVG, 'line');
    const [x1, x2] = s.flipH ? [w, 0] : [0, w];
    const [y1, y2] = s.flipV ? [h, 0] : [0, h];
    line.setAttribute('x1', String(x1)); line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2)); line.setAttribute('y2', String(y2));
    line.setAttribute('stroke', rgba(s.color, s.alpha ?? 1) || '#000');
    line.setAttribute('stroke-width', String(Math.max(0.25, Number(s.width) || 0.75)));
    if (s.dash) line.setAttribute('stroke-dasharray', '4 3');
    svg.append(line);
    // Arrow heads as small triangles at the ends that have one.
    const arrow = (fromX, fromY, toX, toY) => {
      const len = Math.max(4, (Number(s.width) || 0.75) * 4);
      const ang = Math.atan2(toY - fromY, toX - fromX);
      const pts = [[toX, toY], [toX - len * Math.cos(ang - 0.45), toY - len * Math.sin(ang - 0.45)], [toX - len * Math.cos(ang + 0.45), toY - len * Math.sin(ang + 0.45)]];
      const poly = document.createElementNS(SVG, 'polygon');
      poly.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
      poly.setAttribute('fill', rgba(s.color, s.alpha ?? 1) || '#000');
      svg.append(poly);
    };
    if (s.tail && s.tail !== 'none') arrow(x1, y1, x2, y2);
    if (s.head && s.head !== 'none') arrow(x2, y2, x1, y1);
    return svg;
  }
  function drawTable(s) {
    const box = el('div', 'tbl');
    placeBox(box, s);
    const table = el('table');
    const total = (s.cols || []).reduce((a, b) => a + (Number(b) || 0), 0) || 1;
    const colgroup = el('colgroup');
    for (const w of s.cols || []) { const col = el('col'); col.style.width = `${((Number(w) || 0) / total) * 100}%`; colgroup.append(col); }
    table.append(colgroup);
    for (const row of s.rows || []) {
      const tr = el('tr');
      if (row.h) tr.style.height = `${pt(row.h)}px`;
      for (const cell of row.cells || []) {
        if (!cell) continue;
        const td = el('td');
        if (cell.colSpan > 1) td.colSpan = Math.min(100, cell.colSpan);
        if (cell.rowSpan > 1) td.rowSpan = Math.min(500, cell.rowSpan);
        td.style.verticalAlign = cell.anchor === 'middle' ? 'middle' : cell.anchor === 'bottom' ? 'bottom' : 'top';
        applyFill(td, cell.fill);
        drawParagraphs(td, cell.paragraphs);
        tr.append(td);
      }
      table.append(tr);
    }
    box.append(table);
    return box;
  }
  function drawPlaceholder(s) {
    const box = el('div', 'ph');
    placeBox(box, s);
    box.textContent = `${String(s.label || 'Object').slice(0, 80)} (not shown)`;
    return box;
  }

  // A chart: inline SVG (slides-chart.js) in the frame's box. A kind it can't draw keeps the labelled box.
  function drawChartBox(s) {
    const chart = s.chart || {};
    if (!window.lumenChart || !(chart.plots || []).some((p) => p.kind)) {
      const other = (chart.plots || []).find((p) => p.type);
      return drawPlaceholder({ ...s, label: `Chart${other ? ` (${other.type})` : ''}${s.name ? `: ${s.name}` : ''}` });
    }
    const box = el('div', 'chartbox');
    placeBox(box, s);
    box.append(window.lumenChart.drawChart(document, chart, Math.max(1, pt(s.w)), Math.max(1, pt(s.h))));
    return box;
  }
  // SmartArt: its saved drawing's shapes (already in stage coordinates), or the data model's text as a boxed list.
  function drawDiagram(s, stage) {
    if (Array.isArray(s.shapes) && s.shapes.length) { for (const inner of s.shapes) drawInto(stage, inner); return; }
    const box = el('div', 'dialist');
    placeBox(box, s);
    const ul = el('ul');
    for (const item of (s.items || []).slice(0, 500)) {
      const li = el('li');
      li.style.marginLeft = `${Math.max(0, Math.min(8, Number(item.level) || 0)) * 14}px`;
      li.textContent = String(item.text || '');
      ul.append(li);
    }
    box.append(ul);
    stage.append(box);
  }
  function drawInto(stage, s) {
    try {
      if (s.type === 'diagram') { drawDiagram(s, stage); return; }
      const node = s.type === 'pic' ? drawPicture(s) : s.type === 'line' ? drawLine(s) : s.type === 'table' ? drawTable(s) : s.type === 'placeholder' ? drawPlaceholder(s) : s.type === 'chart' ? drawChartBox(s) : drawShape(s);
      stage.append(node);
    } catch (err) { console.error('[slides] a shape could not be drawn:', err); }
  }
  function drawStage(slide) {
    const stage = el('div', 'stage');
    stage.style.width = `${pt(deck.width)}px`;
    stage.style.height = `${pt(deck.height)}px`;
    applyFill(stage, slide.background);
    for (const s of slide.shapes || []) drawInto(stage, s);
    return stage;
  }

  // ---- layout: each stage is scaled to its frame
  const stageWidth = () => pt(deck.width) || 960;
  function fit(slideEl) {
    const stage = slideEl.firstChild;
    if (stage) stage.style.transform = `scale(${slideEl.clientWidth / stageWidth()})`;
  }
  const resize = new ResizeObserver((entries) => { for (const e of entries) fit(e.target); });
  const near = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const i = Number(e.target.dataset.index);
      if (!e.target.firstChild) { e.target.append(drawStage(deck.slides[i])); fit(e.target); }
      near.unobserve(e.target);
    }
  }, { rootMargin: '1200px 0px' });

  function setCurrent(i, { scroll = false } = {}) {
    if (!frames.length) return;
    current = Math.max(0, Math.min(frames.length - 1, i));
    frames.forEach((f, k) => f.classList.toggle('current', k === current));
    $('counter').textContent = `Slide ${current + 1} of ${frames.length}`;
    $('prev').disabled = current === 0;
    $('next').disabled = current === frames.length - 1;
    if (scroll) {
      const top = frames[current].getBoundingClientRect().top + window.scrollY - document.querySelector('header').offsetHeight - 14;
      window.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      scrollLockUntil = Date.now() + 600;
    }
    if (presenting) showPresented();
  }
  let scrollLockUntil = 0;
  function trackScroll() {
    if (Date.now() < scrollLockUntil || presenting) return;
    const line = window.innerHeight * 0.35;
    let best = 0;
    for (let k = 0; k < frames.length; k++) { if (frames[k].getBoundingClientRect().top <= line) best = k; else break; }
    if (best !== current) setCurrent(best);
  }

  // ---- present
  let presenting = false;
  function showPresented() {
    const host = $('present');
    host.querySelector('.slide')?.remove();
    const slideEl = el('div', 'slide');
    const vw = window.innerWidth; const vh = window.innerHeight;
    const ratio = (deck.height || 1) / (deck.width || 1);
    const w = Math.min(vw, vh / ratio);
    const h = w * ratio;
    slideEl.style.width = `${w}px`;
    slideEl.style.height = `${h}px`;
    slideEl.style.left = `${(vw - w) / 2}px`;
    slideEl.style.top = `${(vh - h) / 2}px`;
    const stage = drawStage(deck.slides[current]);
    stage.style.transform = `scale(${w / stageWidth()})`;
    slideEl.append(stage);
    host.prepend(slideEl);
    $('presentHint').textContent = `${current + 1} / ${frames.length}`;
  }
  function present() {
    if (!deck || !frames.length || presenting) return;
    presenting = true;
    $('present').classList.add('on');
    document.documentElement.classList.add('presenting');
    showPresented();
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
  function stopPresenting() {
    if (!presenting) return;
    presenting = false;
    $('present').classList.remove('on');
    document.documentElement.classList.remove('presenting');
    $('present').querySelector('.slide')?.remove();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setCurrent(current, { scroll: true });
  }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) stopPresenting(); });
  window.addEventListener('resize', () => { if (presenting) showPresented(); });
  $('present').addEventListener('click', (e) => setCurrent(current + (e.clientX < window.innerWidth / 4 ? -1 : 1)));
  window.lumenPresent = present;
  // A slice of a picture's data: URL (see slides-viewer.js): the picture is complete when its last slice arrives.
  window.lumenSlidesMedia = (key, at, total, part) => {
    if (typeof key !== 'string' || !expected.has(key) || typeof part !== 'string' || !(total > 0)) return;
    const so_far = typeof media[key] === 'string' && at > 0 ? media[key] : '';
    if (so_far.length !== at) return;
    media[key] = so_far + part;
    if (media[key].length >= total) { complete.add(key); arrival(key).resolve(); }
  };
  // For tests: what the pictures are doing.
  window.lumenSlidesInfo = () => ({ blobs: shown.size, shrunk: [...shrunk], images: document.querySelectorAll('.stage img').length });

  // ---- keys
  document.addEventListener('keydown', (e) => {
    if (!deck || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let to = null;
    if (k === 'PageDown' || k === 'ArrowDown' || k === 'ArrowRight' || (k === ' ' && !e.shiftKey) || (presenting && (k === 'Enter' || k === 'n'))) to = current + 1;
    else if (k === 'PageUp' || k === 'ArrowUp' || k === 'ArrowLeft' || (k === ' ' && e.shiftKey) || (presenting && (k === 'Backspace' || k === 'p'))) to = current - 1;
    else if (k === 'Home') to = 0;
    else if (k === 'End') to = frames.length - 1;
    else if (k === 'Escape' && presenting) { e.preventDefault(); stopPresenting(); return; }
    else if (k === 'F5') { e.preventDefault(); present(); return; }
    if (to === null) return;
    e.preventDefault();
    setCurrent(to, { scroll: !presenting });
  });
  $('prev').addEventListener('click', () => setCurrent(current - 1, { scroll: true }));
  $('next').addEventListener('click', () => setCurrent(current + 1, { scroll: true }));
  $('presentBtn').addEventListener('click', present);

  function showMessage(title, detail) {
    const box = el('div', 'message');
    const strong = el('strong');
    strong.textContent = title;
    box.append(strong, document.createTextNode(detail || ''));
    $('slides').replaceChildren(box);
  }

  window.lumenSlides = (data) => {
    if (!data || typeof data !== 'object') return;
    const name = String(data.name || 'Presentation');
    document.title = name;
    $('name').textContent = name;
    if (data.error) { showMessage('This presentation can’t be shown', String(data.error)); document.body.dataset.ready = 'error'; return; }
    deck = { width: Number(data.width) || 12192000, height: Number(data.height) || 6858000, slides: Array.isArray(data.slides) ? data.slides : [] };
    media = data.media && typeof data.media === 'object' ? data.media : {};
    expected = new Set(Array.isArray(data.mediaKeys) ? data.mediaKeys.map(String) : Object.keys(media).filter((k) => typeof media[k] === 'string'));
    arrivals.clear();
    complete.clear();
    if (!Array.isArray(data.mediaKeys)) for (const k of expected) complete.add(k);
    mediaInfo = data.mediaInfo && typeof data.mediaInfo === 'object' ? data.mediaInfo : {};
    alias = data.mediaAlias && typeof data.mediaAlias === 'object' ? data.mediaAlias : {};
    shown.clear(); shrunk.clear();
    $('notes').textContent = (Array.isArray(data.warnings) ? data.warnings : []).map(String).join(' ');
    if (!deck.slides.length) { showMessage('This presentation has no slides', ''); document.body.dataset.ready = 'true'; return; }
    const main = $('slides');
    main.replaceChildren();
    frames = deck.slides.map((slide, i) => {
      const frame = el('section', 'frame');
      frame.setAttribute('aria-label', `Slide ${i + 1}`);
      if (slide.hidden) frame.classList.add('hidden-slide');
      const slideEl = el('div', 'slide');
      slideEl.dataset.index = String(i);
      slideEl.style.aspectRatio = `${deck.width} / ${deck.height}`;
      slideEl.addEventListener('click', () => setCurrent(i));
      const caption = el('div', 'caption');
      caption.append(document.createTextNode(String(i + 1)));
      if (slide.hidden) { const tag = el('span', 'tag'); tag.textContent = 'Hidden'; caption.append(tag); }
      frame.append(slideEl, caption);
      main.append(frame);
      resize.observe(slideEl);
      near.observe(slideEl);
      return frame;
    });
    $('presentBtn').disabled = false;
    setCurrent(0);
    window.addEventListener('scroll', trackScroll, { passive: true });
    document.body.dataset.ready = 'true';
  };
})();
