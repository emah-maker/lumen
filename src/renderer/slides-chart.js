// Draws one chart of a slide (features/pptx.js parseChart) as inline SVG: bars, lines, areas, scatter, pie and doughnut,
// with axes, gridlines, a legend and a title. Only createElementNS / setAttribute / textContent, never HTML: the text
// is the deck's. Sizes are in points (1 CSS px = 1 point on a slide stage). `doc` is the document (a tiny fake in tests).
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const HEX = /^#[0-9a-f]{6}$/i;
  const FONT = 'Calibri, Carlito, "Segoe UI", Arial, sans-serif';
  const hex = (c, fallback) => (HEX.test(c || '') ? c : fallback);
  const f2 = (v) => String(Math.round(v * 100) / 100);

  function niceTicks(lo, hi, major, target = 5) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    if (hi === lo) { if (lo === 0) hi = 1; else { lo = Math.min(lo, 0); hi = Math.max(hi, 0); if (hi === lo) hi = lo + 1; } }
    let step = major;
    if (!step) {
      const raw = (hi - lo) / target;
      const mag = 10 ** Math.floor(Math.log10(raw));
      const r = raw / mag;
      step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag;
    }
    return { step, lo, hi, start: Math.ceil(lo / step - 1e-9) * step };
  }
  // Auto range: includes zero for bars and areas; rounded out to a tick.
  function range(min, max, o) {
    let lo = Number.isFinite(min) ? min : 0; let hi = Number.isFinite(max) ? max : 1;
    if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const t = niceTicks(lo, hi, o.major);
    if (o.min === null || o.min === undefined) lo = Math.floor(lo / t.step + 1e-9) * t.step; else lo = o.min;
    if (o.max === null || o.max === undefined) hi = Math.ceil(hi / t.step - 1e-9) * t.step; else hi = o.max;
    if (hi <= lo) hi = lo + t.step;
    const ticks = [];
    for (let v = Math.ceil(lo / t.step - 1e-9) * t.step, i = 0; v <= hi + t.step * 1e-6 && i < 200; v += t.step, i++) ticks.push(Math.abs(v) < t.step * 1e-9 ? 0 : v);
    return { lo, hi, ticks };
  }
  function fmt(v, format) {
    if (!Number.isFinite(v)) return '';
    const f = String(format || '');
    if (f.includes('%')) return `${Number((v * 100).toFixed(1))}%`;
    const dec = /0\.(0+)/.exec(f);
    const d = dec ? Math.min(6, dec[1].length) : null;
    const n = d !== null ? v.toFixed(d) : String(Number(v.toFixed(4)));
    const withGroups = f.includes(',') || (d === null && Math.abs(v) >= 10000);
    const s = withGroups ? Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d === null ? 4 : d }) : n;
    return /^\$|\[\$\$/.test(f) ? `$${s}` : s;
  }

  function drawChart(doc, chart, W, H) {
    const svg = doc.createElementNS(SVG, 'svg');
    const mk = (tag, attrs, parent = svg) => {
      const n = doc.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
      parent.append(n);
      return n;
    };
    const textColor = hex(chart.textColor, '#595959');
    const baseSize = Math.max(6, Math.min(40, Number(chart.fontSize) || 10));
    const text = (str, x, y, o = {}) => {
      const t = mk('text', { x: f2(x), y: f2(y), 'font-size': f2(o.size || baseSize), 'text-anchor': o.anchor || 'start', fill: o.fill || textColor, 'font-family': FONT, 'dominant-baseline': o.base || 'central' }, o.parent);
      if (o.bold) t.setAttribute('font-weight', '700');
      if (o.rotate) t.setAttribute('transform', `rotate(${o.rotate} ${f2(x)} ${f2(y)})`);
      t.textContent = String(str);
      return t;
    };
    const clip = (s, n) => { s = String(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
    svg.setAttribute('width', f2(W)); svg.setAttribute('height', f2(H)); svg.setAttribute('viewBox', `0 0 ${f2(W)} ${f2(H)}`);
    svg.setAttribute('class', 'chart');
    if (hex(chart.background, null)) mk('rect', { x: 0, y: 0, width: f2(W), height: f2(H), fill: chart.background });

    const plots = (chart.plots || []).filter((p) => p.kind && p.series && p.series.length);
    const pie = plots.find((p) => p.kind === 'pie' || p.kind === 'doughnut');
    const cart = pie ? [] : plots;
    if (!plots.length) { text('No data to show', W / 2, H / 2, { anchor: 'middle' }); return svg; }

    // ---- title and legend
    const pad = 8;
    let top = pad; let bottom = H - pad; let left = pad; let right = W - pad;
    if (chart.title && chart.title.text) {
      const ts = Math.max(8, Math.min(36, Number(chart.title.size) || baseSize * 1.4));
      const lines = String(chart.title.text).split('\n').slice(0, 3);
      lines.forEach((ln, i) => text(clip(ln, Math.max(10, Math.floor(W / (ts * 0.5)))), W / 2, top + ts * (0.6 + i * 1.2), { anchor: 'middle', size: ts, fill: textColor }));
      top += ts * 1.2 * lines.length + 6;
    }
    const entries = [];
    if (pie) {
      const s = pie.series[0];
      const n = Math.max(s.values.length, s.cats ? s.cats.length : 0);
      for (let i = 0; i < n && i < 60; i++) entries.push({ label: (s.cats && s.cats[i]) || String(i + 1), color: (s.slice && s.slice[i]) || '#999999' });
    } else {
      for (const p of cart) {
        p.series.forEach((s, i) => {
          if (p.series.length === 1 && s.points && s.cats) s.cats.forEach((c, k) => { if (entries.length < 60) entries.push({ label: c || String(k + 1), color: s.points[k] || s.color }); });
          else entries.push({ label: s.name || `Series ${i + 1}`, color: s.color });
        });
      }
    }
    if (chart.legend && entries.length && !(cart.length && entries.length === 1 && !entries[0].label)) {
      const pos = chart.legend;
      const ls = baseSize;
      const wOf = (e) => Math.min(W * 0.4, clip(e.label, 40).length * ls * 0.52 + ls * 2.1);
      const swatch = (x, y, e) => mk('rect', { x: f2(x), y: f2(y - ls * 0.35), width: f2(ls * 0.7), height: f2(ls * 0.7), fill: hex(e.color, '#999999') });
      if (pos === 'l' || pos === 'r' || pos === 'tr') {
        const colW = Math.max(...entries.map(wOf)) + 4;
        const rowH = ls * 1.5;
        const rows = Math.min(entries.length, Math.max(1, Math.floor((bottom - top) / rowH)));
        const x0 = pos === 'l' ? left : right - colW;
        const y0 = pos === 'tr' ? top : top + ((bottom - top) - rows * rowH) / 2;
        entries.slice(0, rows).forEach((e, i) => { swatch(x0, y0 + i * rowH + rowH / 2, e); text(clip(e.label, 40), x0 + ls * 1.1, y0 + i * rowH + rowH / 2, { size: ls }); });
        if (pos === 'l') left += colW + 6; else right -= colW + 6;
      } else {
        const rowH = ls * 1.6;
        const rows = [[]]; let used = 0;
        for (const e of entries) { const w = wOf(e); if (used + w > right - left && rows[rows.length - 1].length) { rows.push([]); used = 0; } rows[rows.length - 1].push(e); used += w; }
        const shown = rows.slice(0, 3);
        const y0 = pos === 't' ? top : bottom - shown.length * rowH;
        shown.forEach((row, r) => {
          const total = row.reduce((a, e) => a + wOf(e), 0);
          let x = (left + right) / 2 - total / 2;
          for (const e of row) { swatch(x, y0 + r * rowH + rowH / 2, e); text(clip(e.label, 40), x + ls * 1.1, y0 + r * rowH + rowH / 2, { size: ls }); x += wOf(e); }
        });
        if (pos === 't') top += shown.length * rowH + 4; else bottom -= shown.length * rowH + 4;
      }
    }

    // ---- pie / doughnut
    if (pie) {
      const s = pie.series[0];
      const vals = s.values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
      const sum = vals.reduce((a, b) => a + b, 0);
      const cx = (left + right) / 2; const cy = (top + bottom) / 2;
      const r = Math.max(8, Math.min(right - left, bottom - top) / 2 - 4);
      if (!sum) { text('No data to show', cx, cy, { anchor: 'middle' }); return svg; }
      const inner = pie.kind === 'doughnut' ? r * Math.max(0.1, Math.min(0.9, (pie.hole || 50) / 100)) : 0;
      let a0 = ((Number(pie.firstAngle) || 0) - 90) * Math.PI / 180;
      const pt = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
      vals.forEach((v, i) => {
        if (!v) return;
        const sweep = (v / sum) * Math.PI * 2;
        const a1 = a0 + sweep;
        const color = hex(s.slice && s.slice[i], '#999999');
        if (sweep >= Math.PI * 2 - 1e-6) {
          if (inner) mk('path', { d: `M${f2(cx - r)} ${f2(cy)}a${f2(r)} ${f2(r)} 0 1 0 ${f2(2 * r)} 0a${f2(r)} ${f2(r)} 0 1 0 ${f2(-2 * r)} 0ZM${f2(cx - inner)} ${f2(cy)}a${f2(inner)} ${f2(inner)} 0 1 1 ${f2(2 * inner)} 0a${f2(inner)} ${f2(inner)} 0 1 1 ${f2(-2 * inner)} 0Z`, 'fill-rule': 'evenodd', fill: color, class: 'slice' });
          else mk('circle', { cx: f2(cx), cy: f2(cy), r: f2(r), fill: color, class: 'slice' });
        } else {
          const [x0, y0] = pt(r, a0); const [x1, y1] = pt(r, a1);
          const large = sweep > Math.PI ? 1 : 0;
          let d;
          if (inner) { const [ix1, iy1] = pt(inner, a1); const [ix0, iy0] = pt(inner, a0); d = `M${f2(x0)} ${f2(y0)}A${f2(r)} ${f2(r)} 0 ${large} 1 ${f2(x1)} ${f2(y1)}L${f2(ix1)} ${f2(iy1)}A${f2(inner)} ${f2(inner)} 0 ${large} 0 ${f2(ix0)} ${f2(iy0)}Z`; }
          else d = `M${f2(cx)} ${f2(cy)}L${f2(x0)} ${f2(y0)}A${f2(r)} ${f2(r)} 0 ${large} 1 ${f2(x1)} ${f2(y1)}Z`;
          mk('path', { d, fill: color, stroke: '#ffffff', 'stroke-width': 1, class: 'slice' });
        }
        const lb = s.labels;
        if (lb && sweep > 0.12) {
          const mid = (a0 + a1) / 2; const [lx, ly] = pt(inner ? (r + inner) / 2 : r * 0.62, mid);
          const parts = [];
          if (lb.cat && s.cats && s.cats[i]) parts.push(clip(s.cats[i], 16));
          if (lb.val) parts.push(fmt(v, lb.format || s.format));
          if (lb.pct) parts.push(`${Math.round((v / sum) * 100)}%`);
          if (parts.length) text(parts.join(' '), lx, ly, { anchor: 'middle', fill: '#ffffff', size: baseSize });
        }
        a0 = a1;
      });
      return svg;
    }

    // ---- cartesian (bars, lines, areas, scatter)
    const horiz = cart.some((p) => p.kind === 'bar' && p.dir === 'bar');
    const scatter = cart.every((p) => p.kind === 'scatter');
    const axes = chart.axes || [];
    const valAx = scatter ? axes.find((a) => a.kind === 'val' && /^[lr]$/.test(a.pos || '')) || axes[1] || null : axes.find((a) => a.kind === 'val') || null;
    const catAx = scatter ? axes.find((a) => a.kind === 'val' && /^[bt]$/.test(a.pos || '')) || axes[0] || null : axes.find((a) => a.kind === 'cat') || null;
    const n = Math.max(1, ...cart.flatMap((p) => p.series.map((s) => Math.max(s.values.length, s.cats && !scatter ? s.cats.length : 0))));
    const catLabels = Array.from({ length: n }, (_v, i) => { const s = cart.flatMap((p) => p.series).find((x) => x.cats && x.cats[i] !== undefined && x.cats[i] !== ''); return s ? s.cats[i] : String(i + 1); });
    const percent = (p) => p.grouping === 'percentStacked';
    // value extents (stacked sums per category)
    let vmin = Infinity; let vmax = -Infinity;
    const take = (v) => { if (Number.isFinite(v)) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); } };
    for (const p of cart) {
      if (percent(p)) { take(0); take(1); continue; }
      const stacked = p.grouping === 'stacked' && p.kind !== 'scatter';
      if (stacked) {
        for (let i = 0; i < n; i++) { let pos = 0; let neg = 0; for (const s of p.series) { const v = s.values[i]; if (Number.isFinite(v)) { if (v >= 0) pos += v; else neg += v; } } take(pos); take(neg); }
      } else for (const s of p.series) for (const v of s.values) take(v);
    }
    const zero = cart.some((p) => p.kind === 'bar' || p.kind === 'area');
    const vr = range(vmin, vmax, { zero, min: valAx ? valAx.min : null, max: valAx ? valAx.max : null, major: valAx ? valAx.major : null });
    const valFormat = valAx && valAx.format ? valAx.format : cart.some(percent) ? '0%' : (cart[0].series[0] && cart[0].series[0].format) || '';
    let xr = null;
    if (scatter) {
      let xmin = Infinity; let xmax = -Infinity;
      for (const p of cart) for (const s of p.series) s.values.forEach((_v, i) => { const x = s.cats && Number.isFinite(s.cats[i]) ? s.cats[i] : i + 1; xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); });
      xr = range(xmin, xmax, { zero: false, min: catAx ? catAx.min : null, max: catAx ? catAx.max : null, major: catAx ? catAx.major : null });
    }

    // margins for the labels and axis titles
    const axisSize = baseSize;
    const valLabels = vr.ticks.map((t) => fmt(t, valFormat));
    const valLabelW = Math.max(...valLabels.map((l) => l.length)) * axisSize * 0.55 + 8;
    const catLabelW = scatter ? 0 : Math.min((right - left) * 0.3, Math.max(...catLabels.map((l) => clip(l, 24).length)) * axisSize * 0.55 + 8);
    const catAxTitle = catAx && catAx.title ? catAx.title.text : '';
    const valAxTitle = valAx && valAx.title ? valAx.title.text : '';
    const valHidden = valAx && valAx.deleted; const catHidden = catAx && catAx.deleted;
    const xr0 = scatter ? xr.ticks.map((t) => fmt(t, catAx && catAx.format)) : [];
    const leftNeed = (horiz ? (catHidden ? 0 : catLabelW) : (valHidden ? 0 : valLabelW)) + (horiz ? (catAxTitle ? axisSize * 1.4 : 0) : (valAxTitle ? axisSize * 1.4 : 0));
    const bottomNeed = (horiz ? (valHidden ? 0 : axisSize * 1.8) : (catHidden && !scatter ? 0 : axisSize * 1.8)) + (horiz ? (valAxTitle ? axisSize * 1.4 : 0) : (catAxTitle ? axisSize * 1.4 : 0));
    const plot = { x: left + leftNeed + 4, y: top + axisSize, w: 0, h: 0 };
    plot.w = Math.max(20, right - 6 - plot.x);
    plot.h = Math.max(20, bottom - bottomNeed - plot.y);

    // value -> position along the value axis; category i -> position along the category axis
    const vpos = (v) => { const f = (v - vr.lo) / (vr.hi - vr.lo); return horiz ? plot.x + f * plot.w : plot.y + plot.h - f * plot.h; };
    const between = scatter ? false : cart.some((p) => p.kind === 'bar') || !catAx || catAx.between !== false;
    const rev = Boolean(catAx && catAx.reverse);
    const cpos = (i) => {
      const f = between ? (i + 0.5) / n : n > 1 ? i / (n - 1) : 0.5;
      const g = rev ? 1 - f : f;
      return horiz ? plot.y + plot.h - g * plot.h : plot.x + g * plot.w;
    };
    const bandSize = (horiz ? plot.h : plot.w) / n;

    // gridlines, value labels
    vr.ticks.forEach((t, i) => {
      const p = vpos(t);
      if (!valAx || valAx.grid || !axes.length) {
        if (horiz) mk('line', { x1: f2(p), y1: f2(plot.y), x2: f2(p), y2: f2(plot.y + plot.h), stroke: '#d9d9d9', 'stroke-width': 0.75, class: 'grid' });
        else mk('line', { x1: f2(plot.x), y1: f2(p), x2: f2(plot.x + plot.w), y2: f2(p), stroke: '#d9d9d9', 'stroke-width': 0.75, class: 'grid' });
      }
      if (!valHidden) {
        if (horiz) text(valLabels[i], p, plot.y + plot.h + axisSize * 1, { anchor: 'middle', size: axisSize });
        else text(valLabels[i], plot.x - 6, p, { anchor: 'end', size: axisSize });
      }
    });
    if (scatter) {
      xr.ticks.forEach((t, i) => {
        const x = plot.x + ((t - xr.lo) / (xr.hi - xr.lo)) * plot.w;
        if (catAx && catAx.grid) mk('line', { x1: f2(x), y1: f2(plot.y), x2: f2(x), y2: f2(plot.y + plot.h), stroke: '#d9d9d9', 'stroke-width': 0.75, class: 'grid' });
        if (!catHidden) text(xr0[i], x, plot.y + plot.h + axisSize, { anchor: 'middle', size: axisSize });
      });
    }
    // axis lines at the baseline
    const base = Math.max(vr.lo, Math.min(vr.hi, 0));
    if (horiz) mk('line', { x1: f2(vpos(base)), y1: f2(plot.y), x2: f2(vpos(base)), y2: f2(plot.y + plot.h), stroke: '#8c8c8c', 'stroke-width': 0.75, class: 'axis' });
    else mk('line', { x1: f2(plot.x), y1: f2(vpos(base)), x2: f2(plot.x + plot.w), y2: f2(vpos(base)), stroke: '#8c8c8c', 'stroke-width': 0.75, class: 'axis' });
    if (scatter) mk('line', { x1: f2(plot.x), y1: f2(plot.y), x2: f2(plot.x), y2: f2(plot.y + plot.h), stroke: '#8c8c8c', 'stroke-width': 0.75, class: 'axis' });
    // category labels (thinned when crowded)
    if (!scatter && !catHidden) {
      const step = horiz ? Math.max(1, Math.ceil((axisSize * 1.4) / Math.max(1, bandSize))) : Math.max(1, Math.ceil((catLabelW + 4) / Math.max(1, bandSize)));
      for (let i = 0; i < n; i += step) {
        if (horiz) text(clip(catLabels[i], 24), plot.x - 6, cpos(i), { anchor: 'end', size: axisSize });
        else text(clip(catLabels[i], 24), cpos(i), plot.y + plot.h + axisSize, { anchor: 'middle', size: axisSize });
      }
    }
    if (catAxTitle) { if (horiz) text(clip(catAxTitle, 40), left + axisSize * 0.7, plot.y + plot.h / 2, { anchor: 'middle', size: axisSize, rotate: -90 }); else text(clip(catAxTitle, 60), plot.x + plot.w / 2, bottom - axisSize * 0.6, { anchor: 'middle', size: axisSize }); }
    if (valAxTitle) { if (horiz) text(clip(valAxTitle, 60), plot.x + plot.w / 2, bottom - axisSize * 0.6, { anchor: 'middle', size: axisSize }); else text(clip(valAxTitle, 40), left + axisSize * 0.7, plot.y + plot.h / 2, { anchor: 'middle', size: axisSize, rotate: -90 }); }

    // ---- the data
    const label = (s, v, x, y, anchor = 'middle', fill = textColor, f = '') => { if (s.labels && s.labels.val && Number.isFinite(v)) text(fmt(v, s.labels.format || f || s.format), x, y, { anchor, size: baseSize * 0.9, fill }); };
    const stackedValue = (p, si, i) => {
      // [from, to] of series si at category i
      const v = p.series[si].values[i];
      if (!Number.isFinite(v)) return null;
      let tot = 1;
      if (percent(p)) { tot = p.series.reduce((a, s) => a + (Number.isFinite(s.values[i]) ? Math.abs(s.values[i]) : 0), 0) || 1; }
      let pos = 0; let neg = 0;
      for (let k = 0; k < si; k++) { const w = p.series[k].values[i]; if (Number.isFinite(w)) { if (w >= 0) pos += w / tot; else neg += w / tot; } }
      const val = v / tot;
      return val >= 0 ? [pos, pos + val, v] : [neg, neg + val, v];
    };
    for (const p of cart) {
      const stack = p.grouping === 'stacked' || percent(p);
      const ns = p.series.length;
      if (p.kind === 'bar') {
        const groupW = bandSize / (1 + Math.max(0, p.gap) / 100);
        const ov = Math.max(-100, Math.min(100, p.overlap === null || p.overlap === undefined ? (stack ? 100 : 0) : p.overlap));
        const eachW = stack ? groupW : groupW / (ns - (ns - 1) * ov / 100);
        const stepW = stack ? 0 : eachW * (1 - ov / 100);
        p.series.forEach((s, si) => {
          for (let i = 0; i < n; i++) {
            const sv = stack ? stackedValue(p, si, i) : (Number.isFinite(s.values[i]) ? [0, s.values[i], s.values[i]] : null);
            if (!sv) continue;
            const c = (s.points && s.points[i]) || s.color;
            const mid = cpos(i);
            const off = stack ? -groupW / 2 : -groupW / 2 + si * stepW;
            const a = vpos(sv[0]); const b = vpos(sv[1]);
            const attrs = horiz
              ? { x: f2(Math.min(a, b)), y: f2(mid + off), width: f2(Math.abs(b - a)), height: f2(Math.max(0.5, eachW)) }
              : { x: f2(mid + off), y: f2(Math.min(a, b)), width: f2(Math.max(0.5, eachW)), height: f2(Math.abs(b - a)) };
            if (rev && horiz) attrs.y = f2(mid - off - eachW);
            const rect = mk('rect', { ...attrs, fill: hex(c, '#4472c4'), class: 'bar' });
            if (s.alpha < 1) rect.setAttribute('fill-opacity', f2(s.alpha));
            const cx = horiz ? Math.max(a, b) + 3 : mid + off + eachW / 2;
            const cy = horiz ? mid + off + eachW / 2 : Math.min(a, b) - 6;
            if (stack) label(s, sv[2], horiz ? (a + b) / 2 : cx, horiz ? cy : (a + b) / 2, 'middle', '#ffffff', percent(p) ? '' : '');
            else label(s, sv[2], cx, cy, horiz ? 'start' : 'middle');
          }
        });
      } else if (p.kind === 'line' || p.kind === 'scatter' || p.kind === 'area') {
        p.series.forEach((s, si) => {
          const pts = [];
          for (let i = 0; i < s.values.length && i < n; i++) {
            const v = s.values[i];
            if (!Number.isFinite(v)) { pts.push(null); continue; }
            let x; let y; let raw = v;
            if (p.kind === 'scatter') { const xv = s.cats && Number.isFinite(s.cats[i]) ? s.cats[i] : i + 1; x = plot.x + ((xv - xr.lo) / (xr.hi - xr.lo)) * plot.w; y = vpos(v); } else {
              const sv = stack ? stackedValue(p, si, i) : null;
              const top2 = sv ? sv[1] : v; raw = v;
              x = horiz ? vpos(top2) : cpos(i); y = horiz ? cpos(i) : vpos(top2);
              pts.push({ x, y, v: raw, base: sv ? sv[0] : 0 });
              continue;
            }
            pts.push({ x, y, v: raw, base: 0 });
          }
          const runs = []; let cur = [];
          for (const q of pts) { if (q) cur.push(q); else if (cur.length) { runs.push(cur); cur = []; } }
          if (cur.length) runs.push(cur);
          const color = hex(s.color, '#4472c4');
          if (p.kind === 'area') {
            for (const run of runs) {
              const upper = run.map((q) => `${f2(q.x)} ${f2(q.y)}`);
              const lower = run.slice().reverse().map((q) => `${f2(q.x)} ${f2(vpos(stack ? q.base : base))}`);
              mk('path', { d: `M${upper.join('L')}L${lower.join('L')}Z`, fill: color, 'fill-opacity': f2(Math.min(0.9, (s.alpha || 1) * 0.85)), class: 'area' });
            }
          }
          if (p.kind !== 'area' && !s.noLine && !(p.kind === 'scatter' && /^marker$/.test(p.scatterStyle))) {
            for (const run of runs) if (run.length > 1) mk('polyline', { points: run.map((q) => `${f2(q.x)},${f2(q.y)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': f2(Math.max(0.75, s.lineWidth || 2.25)), 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'series' });
          }
          const showMarkers = p.kind === 'scatter' ? !(s.marker && s.marker.symbol === 'none') : p.kind === 'line' && p.markers && !(s.marker && s.marker.symbol === 'none');
          if (showMarkers) {
            const r = Math.max(2, Math.min(10, (s.marker && s.marker.size ? s.marker.size : 5) / 2));
            for (const q of pts) if (q) mk('circle', { cx: f2(q.x), cy: f2(q.y), r: f2(r), fill: hex(s.marker && s.marker.color, color), class: 'marker' });
          }
          for (const q of pts) if (q) label(s, q.v, q.x, q.y - 8);
        });
      }
    }
    return svg;
  }

  const api = { drawChart, niceTicks, range, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.lumenChart = api;
})();
