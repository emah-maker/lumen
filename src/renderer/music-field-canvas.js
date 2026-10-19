// [look] Music-reactive home screen: the one canvas that draws it (the new-tab page's background, and Settings' Preview). Plain 2D canvas, no WebGL:
// about 180 soft dots (40 in the reduced mode) are a few hundred drawImage calls of three small pre-rendered sprites, which measures cheaper than a
// shader pass over the whole window (see the PR's numbers). The movement and the limits are in features/music-react.js.
//   - The canvas is a quarter to three quarters of the window's pixels (the dots are soft, nobody can tell), never more than 1.6 million, and never
//     scaled up by a high-density screen: DPR-aware by clamping to one pixel per CSS pixel and then to the budget.
//   - One clear and about three fills a frame. Nothing is allocated per frame.
(() => {
  const MR = window.MusicReact;
  const MAX_PIXELS = 1.6e6;

  function rgbOf(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); const n = m ? parseInt(m[1], 16) : 0x0a84ff; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function toHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn; const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function fromHsl(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  // The accent and two neighbours on the colour wheel, a little lighter: "accent tones".
  function tonesOf(hex) {
    const base = rgbOf(hex); const [h, s, l] = toHsl(base);
    return [base, fromHsl(h + 32, Math.max(0.45, s), Math.min(0.72, l + 0.08)), fromHsl(h - 32, Math.max(0.45, s), Math.min(0.72, l + 0.08))];
  }
  function sprite(rgb) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 1)`); g.addColorStop(0.4, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.55)`); g.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    return c;
  }

  // create({ canvas, mode: 'full' | 'reduced', accent: '#rrggbb', tone: 'plain' | 'media' }) -> { draw, resize, setAccent, setTone, count, field }
  function create({ canvas, mode = 'full', accent = '#0a84ff', tone = 'plain' }) {
    const ctx = canvas.getContext('2d');
    const n = MR.COUNTS[mode] || MR.COUNTS.full;
    let w = 0; let h = 0; let q = 1; let cx = 0; let colW = 640;
    let field = null; let tones = tonesOf(accent); let sprites = tones.map(sprite);
    const dot = { x: 0, y: 0, r: 0, a: 0 };
    const api = {
      count: n,
      get field() { return field; },
      setAccent(hex) { tones = tonesOf(hex); sprites = tones.map(sprite); },
      setTone(t) { tone = t === 'media' ? 'media' : 'plain'; },
      // css size of the window, the screen's pixel ratio, and the content column (centre x and width, CSS px)
      resize(cssW, cssH, dpr, column) {
        if (!(cssW > 0 && cssH > 0)) return;
        w = cssW; h = cssH;
        q = Math.min(Math.max(dpr || 1, 1), 1) * (mode === 'reduced' ? 0.5 : 0.75);
        q = Math.min(q, Math.sqrt(MAX_PIXELS / (w * h)));
        canvas.width = Math.max(1, Math.round(w * q)); canvas.height = Math.max(1, Math.round(h * q));
        if (column) { cx = column.cx; colW = column.w; } else { cx = w / 2; colW = 640; }
        if (field) field.resize(w, h); else field = MR.createField(n, w, h);
      },
      // t: milliseconds; c: the mapper's { bass, mids, highs, level, beat }; dt: seconds since the last frame
      draw(t, c, dt) {
        if (!field) return;
        field.step(dt, c);
        ctx.setTransform(q, 0, 0, q, 0, 0);
        ctx.clearRect(0, 0, w, h);
        // the glow that flows: two big soft blobs at the sides drifting slowly, one behind the column at a fifth of the strength; the colour moves along the
        // accent's tones with the energy
        const energy = 0.5 * c.level + 0.5 * c.bass;
        const cap = MR.FLOW_CAP[tone];
        const mix = Math.min(1, energy * 1.4);
        const rgb = [0, 1, 2].map((k) => Math.round(tones[0][k] + (tones[1][k] - tones[0][k]) * mix));
        const rgb2 = [0, 1, 2].map((k) => Math.round(tones[0][k] + (tones[2][k] - tones[0][k]) * mix));
        const s = t / 1000;
        const R = Math.max(w, h) * (0.42 + 0.12 * c.bass);
        const blob = (x, y, col, a) => {
          const g = ctx.createRadialGradient(x, y, 0, x, y, R);
          g.addColorStop(0, `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${a.toFixed(3)})`); g.addColorStop(1, `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0)`);
          ctx.fillStyle = g; ctx.fillRect(Math.max(0, x - R), Math.max(0, y - R), Math.min(w, 2 * R), Math.min(h, 2 * R));
        };
        const a0 = cap * (0.35 + 0.65 * energy);
        blob(w * (0.16 + 0.07 * Math.sin(s * 0.11)), h * (0.3 + 0.12 * Math.sin(s * 0.07 + 1)), rgb, a0);
        blob(w * (0.84 + 0.07 * Math.sin(s * 0.09 + 2)), h * (0.62 + 0.12 * Math.sin(s * 0.06)), rgb2, a0);
        blob(cx, h * 0.18, rgb, a0 * MR.COLUMN_GAIN);
        // the dots
        const ns = sprites.length;
        for (let i = 0; i < n; i++) {
          field.look(i, tone, dot);
          if (dot.a < 0.004) continue;
          ctx.globalAlpha = dot.a;
          ctx.drawImage(sprites[field.tone[i] % ns], dot.x - dot.r, dot.y - dot.r, dot.r * 2, dot.r * 2);
        }
        ctx.globalAlpha = 1;
        // the column behind the content is cut out of everything drawn: COLUMN_GAIN of it is left (columnGain in features/music-react.js)
        const half = colW / 2; const edge = 90; const total = colW + 2 * edge;
        const g = ctx.createLinearGradient(cx - half - edge, 0, cx + half + edge, 0);
        const hold = (1 - MR.COLUMN_GAIN).toFixed(2);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(edge / total, `rgba(0,0,0,${hold})`); g.addColorStop(1 - edge / total, `rgba(0,0,0,${hold})`); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = g; ctx.fillRect(cx - half - edge, 0, total, h);
        ctx.globalCompositeOperation = 'source-over';
      },
    };
    return api;
  }
  window.MusicFieldCanvas = { create, tonesOf };
})();
