// [look] Animated effects over the new-tab background (Settings → Appearance → Animated effect):
// Particles (dots joined by lines, like particles.js), Stars (a twinkling night sky), Bubbles and
// Snow, and three soft ones: Aurora drift (slow curtains of light), Soft blobs (large glows that float)
// and Film grain (a faint, slowly shifting noise), in a color (automatic, the accent, rainbow or any), an
// amount, a speed and a size, and optionally reacting to the pointer. newtab.js loads this file only when
// an effect is on, so with it off it costs nothing. One small canvas that never takes a click
// (pointer-events: none; the page's CSS also fades it behind the content column), kept light on purpose:
//   - a particle count scaled to the window and capped; the lines between particles found with a grid of cells, not by
//     comparing every pair; each color's lines and dots batched into a few paths, no shadows, no per-line gradients
//   - a canvas at one pixel per CSS pixel whatever the screen's density (the shapes are soft and the page scales it up), and half that
//     again for the soft effects, which are blurry by nature
//   - at most 30 frames a second for the particles, snow and the like, 15 for the slow drifts, 8 for the grain, each asked for just in
//     time: a timer waits out most of the interval and one animation frame draws it, so there is about one callback per frame
//   - nothing asked for while the page is not in front (another tab, the spare page, a minimised window; its pixel buffer freed after a while)
//   - one still frame, no loop at all, with Reduce motion and with Performance mode (which also stands for battery saver and thermal limits)
//   - a rest after 90 s without input

(() => {
  const TAU = Math.PI * 2;
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const LEVEL = { few: 0.5, normal: 1, many: 1.8, slow: 0.5, fast: 1.8, small: 0.65, large: 1.6 };
  const RAINBOW = ['255, 99, 132', '255, 159, 64', '255, 214, 10', '52, 199, 89', '10, 132, 255', '191, 90, 242'];

  const MAX_PIXELS = 1.6e6; // the canvas never holds more pixels than this (a 1920 x 1080 window is 2.1e6 CSS pixels: drawn a little smaller, shown scaled)
  const FREE_AFTER_MS = 20e3; // hidden this long: the canvas gives its pixel buffer back (redrawn from the particles when shown)

  const IDLE_PAUSE_MS = 90e3; // no pointer, key or wheel input this long: the animation rests (a still canvas) until the next input

  let style = { size: 1 }; // the current run's multipliers (make() reads the size)

  // Circles for every particle of each color, one fill per color. rOf/xOf/keep: per-particle radius,
  // x position and whether to draw it in this pass.
  function dots(ctx, list, colors, alpha, rOf = (p) => p.r, xOf = (p) => p.x, keep = null) {
    ctx.globalAlpha = alpha;
    for (let c = 0; c < colors.length; c++) {
      ctx.fillStyle = `rgb(${colors[c]})`;
      ctx.beginPath();
      for (const p of list) {
        if (p.c % colors.length !== c || (keep && !keep(p))) continue;
        const r = rOf(p); const x = xOf(p);
        ctx.moveTo(x + r, p.y); ctx.arc(x, p.y, r, 0, TAU);
      }
      ctx.fill();
    }
  }
  const near = (p, mouse, dist) => { if (!mouse.on) return 0; const dx = p.x - mouse.x; const dy = p.y - mouse.y; const d2 = dx * dx + dy * dy; return d2 < dist * dist ? 1 - Math.sqrt(d2) / dist : 0; };

  // Each effect: how many per 10,000 px² (and a cap), how to make one, move one, and draw them all.
  const EFFECTS = {
    particles: {
      density: 0.9, max: 80,
      make: (w, h) => ({ x: rand(0, w), y: rand(0, h), vx: rand(-0.35, 0.35), vy: rand(-0.35, 0.35), r: rand(1.2, 2.6) * style.size }),
      step(p, w, h, dt) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < 0 || p.x > w) p.vx = -p.vx;
        if (p.y < 0 || p.y > h) p.vy = -p.vy;
      },
      draw(ctx, list, colors, mouse, r) {
        const LINK = 130; const LINK2 = LINK * LINK;
        // Lines in four opacity buckets: four strokes a frame instead of one per line.
        const buckets = [[], [], [], []];
        // A grid of LINK-sized cells: a particle is only compared with the ones in its own cell and the eight around it (a few
        // hundred pairs in all, where comparing every pair was n(n-1)/2: 3160 for 80). Particles are chained per cell in two typed arrays.
        const cols = Math.max(1, Math.ceil(r.w / LINK)); const rows = Math.max(1, Math.ceil(r.h / LINK));
        const cells = cols * rows;
        if (!r.head || r.head.length < cells) r.head = new Int16Array(cells);
        if (!r.chain || r.chain.length < list.length) r.chain = new Int16Array(list.length);
        const head = r.head; const chain = r.chain;
        head.fill(-1, 0, cells);
        const colOf = (p) => Math.min(cols - 1, Math.max(0, Math.floor(p.x / LINK)));
        const rowOf = (p) => Math.min(rows - 1, Math.max(0, Math.floor(p.y / LINK)));
        for (let i = 0; i < list.length; i++) { const c = rowOf(list[i]) * cols + colOf(list[i]); chain[i] = head[c]; head[c] = i; }
        let checks = 0;
        for (let i = 0; i < list.length; i++) {
          const a = list[i];
          const cx = colOf(a); const cy = rowOf(a);
          for (let y = Math.max(0, cy - 1); y <= Math.min(rows - 1, cy + 1); y++) {
            for (let x = Math.max(0, cx - 1); x <= Math.min(cols - 1, cx + 1); x++) {
              for (let j = head[y * cols + x]; j !== -1; j = chain[j]) {
                if (j <= i) continue; // (each pair once)
                const b = list[j];
                const dx = a.x - b.x; const dy = a.y - b.y;
                const d2 = dx * dx + dy * dy;
                checks++;
                if (d2 < LINK2) buckets[Math.min(3, Math.floor((Math.sqrt(d2) / LINK) * 4))].push(a, b);
              }
            }
          }
          if (near(a, mouse, 180)) buckets[0].push(a, mouse); // the pointer grabs the dots near it
        }
        r.stats.checks += checks;
        ctx.lineWidth = Math.max(0.6, style.size * 0.9);
        ctx.strokeStyle = `rgb(${colors.line})`;
        buckets.forEach((pairs, k) => {
          if (!pairs.length) return;
          ctx.globalAlpha = 0.34 - k * 0.08;
          ctx.beginPath();
          for (let i = 0; i < pairs.length; i += 2) { ctx.moveTo(pairs[i].x, pairs[i].y); ctx.lineTo(pairs[i + 1].x, pairs[i + 1].y); }
          ctx.stroke();
        });
        dots(ctx, list, colors, 0.8);
      },
    },
    stars: {
      density: 2.2, max: 220,
      make: (w, h) => ({ x: rand(0, w), y: rand(0, h), r: (Math.random() < 0.9 ? rand(0.4, 1.2) : rand(1.2, 2.2)) * style.size, phase: rand(0, TAU), speed: rand(0.01, 0.04), vx: rand(-0.06, 0.06), vy: rand(-0.04, 0.02) }),
      step(p, w, h, dt, mouse) {
        p.phase += p.speed * dt;
        p.x = (p.x + p.vx * dt + w) % w; p.y = (p.y + p.vy * dt + h) % h;
        const k = near(p, mouse, 120); // stars near the pointer glow
        p.glow = k;
        p.level = Math.min(3, Math.floor(Math.min(1, (Math.sin(p.phase) + 1) / 2 + k) * 4));
      },
      draw(ctx, list, colors) {
        // Grouped by brightness and color so a few fills draw them all.
        for (let level = 0; level < 4; level++) dots(ctx, list, colors, 0.25 + level * 0.22, (p) => p.r + (p.glow || 0) * 1.6 * style.size, undefined, (p) => (p.level ?? 1) === level);
      },
    },
    bubbles: {
      density: 0.22, max: 36,
      make: (w, h, fresh) => ({ x: rand(0, w), y: fresh ? h + rand(10, 80) : rand(0, h), r: rand(6, 30) * style.size, vy: rand(0.25, 0.8), wob: rand(0, TAU), ox: 0 }),
      step(p, w, h, dt, mouse) {
        p.y -= p.vy * dt; p.wob += 0.02 * dt;
        const k = near(p, mouse, 110); // the pointer nudges bubbles aside
        p.ox = p.ox * 0.94 + (k ? (p.x >= mouse.x ? 1 : -1) * k * 6.6 : 0);
        if (p.y + p.r < 0) Object.assign(p, EFFECTS.bubbles.make(w, h, true), { c: p.c });
      },
      draw(ctx, list, colors) {
        const xOf = (p) => p.x + Math.sin(p.wob) * 6 + p.ox;
        dots(ctx, list, colors, 0.08, undefined, xOf);
        ctx.lineWidth = 1.2;
        ctx.globalAlpha = 0.4;
        for (let c = 0; c < colors.length; c++) {
          ctx.strokeStyle = `rgb(${colors[c]})`;
          ctx.beginPath();
          for (const p of list) { if (p.c % colors.length !== c) continue; const x = xOf(p); ctx.moveTo(x + p.r, p.y); ctx.arc(x, p.y, p.r, 0, TAU); }
          ctx.stroke();
        }
        // A highlight on each.
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = 'rgb(255, 255, 255)';
        ctx.beginPath();
        for (const p of list) { const x = xOf(p) - p.r * 0.35; const y = p.y - p.r * 0.35; const hr = Math.max(1, p.r * 0.18); ctx.moveTo(x + hr, y); ctx.arc(x, y, hr, 0, TAU); }
        ctx.fill();
      },
    },
    snow: {
      density: 0.8, max: 110,
      make: (w, h, fresh) => ({ x: rand(0, w), y: fresh ? rand(-40, -5) : rand(0, h), r: rand(0.8, 3) * style.size, vy: rand(0.3, 1.1), sway: rand(0, TAU), ox: 0 }),
      step(p, w, h, dt, mouse) {
        p.y += p.vy * dt; p.sway += 0.015 * dt;
        p.x += Math.sin(p.sway) * 0.35 * dt;
        const k = near(p, mouse, 90); // flakes drift away from the pointer
        if (k) p.x += (p.x >= mouse.x ? 1 : -1) * k * 2 * dt;
        if (p.y - p.r > h) Object.assign(p, EFFECTS.snow.make(w, h, true), { c: p.c });
        if (p.x < -5) p.x = w + 5; else if (p.x > w + 5) p.x = -5;
      },
      draw(ctx, list, colors) { dots(ctx, list, colors, 0.8); },
    },
    // The soft ones. `soft`: drawn on a half-size canvas the page scales up; `fps`: how often they are redrawn; `fade: false`: they are
    // ambient light, faint everywhere, so they are not cleared from behind the content column the way the small ones are.
    aurora: {
      soft: true, fps: 15, fade: false, fixed: () => 4,
      make: (w, h) => ({ x: rand(w * 0.2, w * 0.8), y: rand(h * 0.08, h * 0.5), r: rand(0.28, 0.42) * Math.max(w, h * 1.4), sx: rand(1.6, 2.4), phase: rand(0, TAU), speed: rand(0.002, 0.005), swing: rand(0.12, 0.22) }),
      step(p, w, h, dt) { p.phase += p.speed * dt; },
      draw(ctx, list, colors, mouse, r) {
        // Curtains: wide, flat glows that slide sideways and breathe, one color each (the palette repeats).
        ctx.globalAlpha = 1;
        for (let i = 0; i < list.length; i++) {
          const p = list[i]; const col = colors[i % colors.length];
          const x = p.x + Math.sin(p.phase) * r.w * p.swing; const y = p.y + Math.cos(p.phase * 0.7) * r.h * 0.06;
          const a = 0.26 + 0.12 * Math.sin(p.phase * 1.3 + i);
          ctx.save();
          ctx.translate(x, y); ctx.scale(p.sx, 0.55);
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, p.r * 0.6);
          g.addColorStop(0, `rgba(${col}, ${a})`); g.addColorStop(1, `rgba(${col}, 0)`);
          ctx.fillStyle = g;
          ctx.fillRect(-p.r * 0.6, -p.r * 0.6, p.r * 1.2, p.r * 1.2);
          ctx.restore();
        }
      },
    },
    blobs: {
      soft: true, fps: 15, fade: false, fixed: () => 6,
      make: (w, h) => ({ x: rand(0, w), y: rand(0, h), r: rand(0.16, 0.3) * Math.min(w, h * 1.3) * style.size, vx: rand(-0.12, 0.12), vy: rand(-0.1, 0.1), phase: rand(0, TAU) }),
      step(p, w, h, dt) {
        p.x += p.vx * dt; p.y += p.vy * dt; p.phase += 0.004 * dt;
        if (p.x < -p.r * 0.3 || p.x > w + p.r * 0.3) p.vx = -p.vx;
        if (p.y < -p.r * 0.3 || p.y > h + p.r * 0.3) p.vy = -p.vy;
      },
      draw(ctx, list, colors) {
        ctx.globalAlpha = 1;
        for (let i = 0; i < list.length; i++) {
          const p = list[i]; const col = colors[i % colors.length];
          const rad = p.r * (1 + 0.06 * Math.sin(p.phase));
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
          g.addColorStop(0, `rgba(${col}, 0.34)`); g.addColorStop(1, `rgba(${col}, 0)`);
          ctx.fillStyle = g;
          ctx.fillRect(p.x - rad, p.y - rad, rad * 2, rad * 2);
        }
      },
    },
    grain: {
      soft: true, fps: 8, fade: false, fixed: () => 1,
      make: () => ({ ox: 0, oy: 0 }),
      step(p) { p.ox = Math.floor(Math.random() * 128); p.oy = Math.floor(Math.random() * 128); }, // a new patch of the same noise
      draw(ctx, list, colors, mouse, r) {
        // One 128 px tile of noise, made once; each frame lays it over the canvas from another offset.
        if (!r.tile) {
          const t = document.createElement('canvas'); t.width = 128; t.height = 128;
          const tc = t.getContext('2d'); const img = tc.createImageData(128, 128);
          for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() < 0.5 ? 0 : 255; img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = Math.floor(rand(10, 46)); }
          tc.putImageData(img, 0, 0);
          r.tile = ctx.createPattern(t, 'repeat');
        }
        const p = list[0];
        ctx.save();
        ctx.translate(-p.ox, -p.oy);
        ctx.globalAlpha = 1;
        ctx.fillStyle = r.tile;
        ctx.fillRect(0, 0, r.w + 128, r.h + 128);
        ctx.restore();
      },
    },
  };

  const INPUTS = ['pointermove', 'pointerdown', 'keydown', 'wheel'];
  let run = null; // { name, key, canvas, ctx, list, raf, colors, ... } while an effect is on

  function stop() {
    if (!run) return;
    cancelAnimationFrame(run.raf);
    clearTimeout(run.timer);
    clearTimeout(run.freeTimer);
    document.removeEventListener('visibilitychange', run.onVisibility);
    for (const t of INPUTS) removeEventListener(t, run.onInput);
    removeEventListener('resize', run.onResize);
    removeEventListener('pointermove', run.onPointer);
    document.documentElement.removeEventListener('pointerleave', run.onLeave);
    run.canvas.remove();
    run = null;
  }

  // "r, g, b" strings: the chosen color, the accent, a rainbow, or white over a background and
  // the page's text color on Plain. colors.line is the one the particles' lines use.
  const rgbOf = (css) => {
    const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
    if (hex) { const n = parseInt(hex[1], 16); return `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`; }
    const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(css);
    return m ? `${m[1]}, ${m[2]}, ${m[3]}` : '255, 255, 255';
  };
  // The soft effects' own palettes for Automatic (white or the text color would only fog the page).
  const SOFT_AUTO = { aurora: ['46, 213, 170', '94, 92, 230', '191, 90, 242', '10, 132, 255'], blobs: ['94, 92, 230', '255, 99, 132', '10, 132, 255', '255, 159, 64', '46, 213, 170', '191, 90, 242'] };
  // `from`: the text color and the accent as CSS strings when they are not the page's own (the Settings preview draws with its own).
  function colorsOf(choice, name, from = {}) {
    const text = rgbOf(from.text || getComputedStyle(document.body).color);
    const colors = choice === 'rainbow' ? [...RAINBOW]
      : choice === 'accent' ? [rgbOf(from.accent || getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#0a84ff')]
        : /^#[0-9a-f]{6}$/i.test(choice || '') ? [rgbOf(choice)] : SOFT_AUTO[name] ? [...SOFT_AUTO[name]] : [text];
    colors.line = choice === 'rainbow' ? text : colors[0];
    return colors;
  }

  function size() {
    const r = run;
    const w = innerWidth; const h = innerHeight;
    const e = EFFECTS[r.name];
    // One canvas pixel per CSS pixel (never the screen's 1.5 or 2: the shapes are soft, and a canvas of four times the pixels costs four times the
    // fill), half that for the soft effects, and fewer still in a huge window.
    const dpr = Math.min(e.soft ? 0.5 : 1, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
    r.canvas.width = Math.max(1, Math.round(w * dpr)); r.canvas.height = Math.max(1, Math.round(h * dpr));
    r.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fx = r.w ? w / r.w : 1; const fy = r.h ? h / r.h : 1;
    for (const p of r.list) { p.x *= fx; p.y *= fy; }
    r.w = w; r.h = h;
    const want = e.fixed ? e.fixed() : Math.round(Math.min(e.max, ((w * h) / 10000) * e.density) * r.amount);
    while (r.list.length < want) r.list.push(Object.assign(e.make(w, h, false), { c: Math.floor(Math.random() * RAINBOW.length) }));
    r.list.length = Math.max(0, want);
    r.colors = colorsOf(r.color, r.name);
  }

  // The effect fades behind the content column (text and fields stay clear): 28% visible between
  // 300 px either side of the centre, full strength beyond 400 px. Drawn into the canvas, since a CSS
  // mask on a canvas that redraws every frame is re-masked every frame. Not on narrow windows (CSS
  // lowers the whole layer's opacity there).
  function fade(r) {
    if (r.w <= 760 || EFFECTS[r.name].fade === false) return;
    const at = (px) => Math.min(1, Math.max(0, px / r.w));
    const g = r.ctx.createLinearGradient(0, 0, r.w, 0);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(at(r.w / 2 - 400), 'rgba(0, 0, 0, 0)');
    g.addColorStop(at(r.w / 2 - 300), 'rgba(0, 0, 0, 0.72)');
    g.addColorStop(at(r.w / 2 + 300), 'rgba(0, 0, 0, 0.72)');
    g.addColorStop(at(r.w / 2 + 400), 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    r.ctx.globalCompositeOperation = 'destination-out';
    r.ctx.fillStyle = g;
    r.ctx.fillRect(Math.max(0, r.w / 2 - 400), 0, Math.min(r.w, 800), r.h); // (the gradient is clear beyond 400 px either side: only the band needs filling)
    r.ctx.globalCompositeOperation = 'source-over';
  }

  function draw() {
    const r = run;
    r.ctx.clearRect(0, 0, r.w, r.h);
    EFFECTS[r.name].draw(r.ctx, r.list, r.colors, r.mouse, r);
    r.ctx.globalAlpha = 1;
    fade(r);
  }

  // The loop asks for an animation frame only when a frame is due: a timer waits out most of the interval (the effect's own: 30 fps for the
  // particles, 15 for the slow drifts, 8 for the grain), then one requestAnimationFrame draws it, so a frame is about one callback. (It used to
  // ask for every vsync and return early for most of them, three or four callbacks per frame on a fast display.)
  // It also stops after IDLE_PAUSE_MS without input (the canvas keeps the last frame) and starts again on the next input.
  const intervalOf = (r) => 1000 / (EFFECTS[r.name].fps || 30);
  function arm(r, wait) {
    clearTimeout(r.timer);
    r.timer = setTimeout(() => { r.timer = 0; if (run === r && !r.raf && !document.hidden) r.raf = requestAnimationFrame(frame); }, Math.max(0, wait));
  }
  const next = (r, spent) => arm(r, intervalOf(r) - 10 - spent); // (the timer is set to run out a little before the next vsync: 24 ms for 33, so at 60 Hz the frame lands on the vsync at 33 ms, not the one after)

  function frame(t) {
    const r = run;
    if (!r) return;
    r.raf = 0;
    if (document.hidden) return; // (onVisibility starts the loop again)
    const interval = intervalOf(r);
    if (r.last && t - r.last < interval * 0.82) { arm(r, interval - (t - r.last)); return; } // (a frame came well early, as on a display faster than 60 Hz: wait out the rest, so an effect never draws much above its rate)
    if (performance.now() - r.input > IDLE_PAUSE_MS) { r.last = 0; r.idle = true; return; } // (onInput starts the loop again)
    const dt = (Math.min(3, (t - (r.last || t - interval)) / 16.7)) * r.speed; // in 60 Hz frames; a long pause doesn't jump
    r.last = t;
    if (r.resized) { r.resized = false; size(); }
    const e = EFFECTS[r.name];
    const began = performance.now();
    for (const p of r.list) e.step(p, r.w, r.h, dt, r.mouse);
    draw();
    const spent = performance.now() - began;
    r.stats.frames++; r.stats.ms += spent; if (spent > r.stats.max) r.stats.max = spent;
    next(r, spent);
  }

  // name: an EFFECTS key or anything else for none. still: one frame, no animation. lite: Performance
  // mode (also battery saver and thermal limits): one frame too. effectStyle: { color, amount, speed, size, interact } (settings-backend.js newTabLook).
  window.setBackdropEffect = (name, { still = false, lite = false, effectStyle = {} } = {}) => {
    const motion = !still && !lite && !matchMedia('(prefers-reduced-motion: reduce)').matches; // (one still frame otherwise: no loop, no timer)
    const s = effectStyle || {};
    const opts = { color: typeof s.color === 'string' ? s.color : 'auto', amount: LEVEL[s.amount] || 1, speed: LEVEL[s.speed] || 1, size: LEVEL[s.size] || 1, interact: s.interact !== false };
    const key = JSON.stringify([name, motion, lite, opts.amount, opts.size, opts.interact]);
    if (run && run.key === key) { // same particles: only the color or speed changed
      Object.assign(run, { color: opts.color, speed: opts.speed, colors: colorsOf(opts.color, name) });
      if (!motion) draw();
      return;
    }
    stop();
    if (!EFFECTS[name]) return;
    style = { size: opts.size };
    const canvas = document.createElement('canvas');
    canvas.id = 'effect';
    canvas.setAttribute('aria-hidden', 'true');
    document.getElementById('backdrop').after(canvas);
    run = { name, key, lite, ...opts, canvas, ctx: canvas.getContext('2d'), list: [], raf: 0, timer: 0, idle: false, input: 0, last: 0, w: 0, h: 0, mouse: { on: false, x: 0, y: 0 }, stats: { frames: 0, checks: 0, ms: 0, max: 0 } };
    size();
    if (!motion) { draw(); return; }
    // Not in front (another tab, the spare page, a minimised window): no animation frame is even asked for, and after a while the canvas
    // gives its pixels back. Back in front: the buffer is made again and the loop starts where the particles are.
    run.onVisibility = () => {
      const r = run;
      if (!r) return;
      if (document.hidden) {
        cancelAnimationFrame(r.raf); r.raf = 0;
        clearTimeout(r.timer); r.timer = 0;
        clearTimeout(r.freeTimer);
        r.freeTimer = setTimeout(() => { if (run === r && document.hidden) { r.canvas.width = 1; r.canvas.height = 1; r.freed = true; } }, FREE_AFTER_MS);
        return;
      }
      clearTimeout(r.freeTimer);
      if (r.freed) { r.freed = false; size(); }
      r.last = 0; r.input = performance.now(); r.idle = false;
      if (!r.raf) r.raf = requestAnimationFrame(frame);
    };
    run.input = performance.now();
    run.onInput = () => {
      const r = run;
      if (!r) return;
      r.input = performance.now();
      if (r.idle && !document.hidden) { r.idle = false; if (!r.raf) r.raf = requestAnimationFrame(frame); }
    };
    for (const t of INPUTS) addEventListener(t, run.onInput, { passive: true });
    document.addEventListener('visibilitychange', run.onVisibility);
    run.onResize = () => { run.resized = true; };
    addEventListener('resize', run.onResize, { passive: true });
    if (opts.interact) {
      run.onPointer = (e) => { run.mouse.on = true; run.mouse.x = e.clientX; run.mouse.y = e.clientY; };
      run.onLeave = () => { run.mouse.on = false; };
      addEventListener('pointermove', run.onPointer, { passive: true });
      document.documentElement.addEventListener('pointerleave', run.onLeave);
    }
    if (document.hidden) run.onVisibility(); else run.raf = requestAnimationFrame(frame);
  };
  // The same effects as a small picture: Settings → Home draws one on the preview's canvas (renderer/settings-preview.js). The scene is simulated at a
  // page-sized stage (so the particle counts, speeds and sizes are what the page has) and drawn scaled down onto the canvas. Several independent
  // previews never share state with the page's own run above; only the shared `style` size is set before each step.
  //   const fx = createEffectPreview(canvas, { stageW, stageH });   fx.set({ name, color, amount, speed, size, text, accent, animate }); fx.stop();
  // `animate`: false draws one still frame (Reduce motion, Performance mode). The loop asks for no frame while the canvas is offscreen
  // (IntersectionObserver), hidden (a closed page or section) or the document is not in front, and at most one frame per effect interval.
  window.createEffectPreview = (canvas, { stageW = 900, stageH = 380 } = {}) => {
    const ctx = canvas.getContext('2d');
    let r = null; let timer = 0; let raf = 0; let visible = true; let observer = null; let animate = false;
    const stats = { frames: 0, maxMs: 0 };
    const stopLoop = () => { clearTimeout(timer); cancelAnimationFrame(raf); timer = 0; raf = 0; };
    const sizeCanvas = () => { // at one canvas pixel per CSS pixel of the preview (more would only cost more)
      const w = Math.max(1, Math.round(canvas.clientWidth || 360)); const h = Math.max(1, Math.round(w * stageH / stageW));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.setTransform(w / stageW, 0, 0, h / stageH, 0, 0);
    };
    const paint = () => {
      if (!r) return;
      sizeCanvas();
      style = { size: r.size };
      ctx.clearRect(0, 0, stageW, stageH);
      EFFECTS[r.name].draw(ctx, r.list, r.colors, r.mouse, r);
      ctx.globalAlpha = 1;
      fade(Object.assign(r, { ctx }));
    };
    const interval = () => 1000 / (EFFECTS[r.name].fps || 30);
    const frame = (t) => {
      raf = 0;
      if (!r || !animate || !visible || document.hidden) return;
      const began = performance.now();
      const dt = Math.min(3, (t - (r.last || t - interval())) / 16.7) * r.speed;
      r.last = t;
      style = { size: r.size };
      for (const p of r.list) EFFECTS[r.name].step(p, stageW, stageH, dt, r.mouse);
      paint();
      const spent = performance.now() - began;
      stats.frames++; stats.maxMs = Math.max(stats.maxMs, spent);
      arm(interval() - 10 - spent);
    };
    const arm = (wait) => { clearTimeout(timer); timer = setTimeout(() => { timer = 0; if (!raf && animate && visible && !document.hidden) raf = requestAnimationFrame(frame); }, Math.max(0, wait)); };
    const resume = () => { if (r && animate && visible && !document.hidden && !raf && !timer) { r.last = 0; raf = requestAnimationFrame(frame); } };
    const onDoc = () => { if (document.hidden) stopLoop(); else resume(); };
    document.addEventListener('visibilitychange', onDoc);
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) { paint(); resume(); } else stopLoop(); });
      observer.observe(canvas);
    }
    return {
      set({ name, color = 'auto', amount = 'normal', speed = 'normal', size = 'normal', text = '#ffffff', accent = '#0a84ff', animate: moving = false } = {}) {
        if (!EFFECTS[name]) { stopLoop(); r = null; animate = false; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
        const k = { amount: LEVEL[amount] || 1, speed: LEVEL[speed] || 1, size: LEVEL[size] || 1 };
        const same = r && r.name === name && r.amount === k.amount && r.size === k.size;
        if (!same) { // new particles
          stopLoop();
          style = { size: k.size };
          const e = EFFECTS[name];
          const want = e.fixed ? e.fixed() : Math.round(Math.min(e.max, ((stageW * stageH) / 10000) * e.density) * k.amount);
          const list = [];
          while (list.length < want) list.push(Object.assign(e.make(stageW, stageH, false), { c: Math.floor(Math.random() * RAINBOW.length) }));
          r = { name, list, w: stageW, h: stageH, mouse: { on: false, x: 0, y: 0 }, stats: { checks: 0 }, last: 0, ...k };
        }
        Object.assign(r, { speed: k.speed, color, colors: colorsOf(color, name, { text, accent }) });
        animate = moving;
        stopLoop();
        paint(); // (always one frame; a loop only when it may move)
        resume();
      },
      info: () => (r ? { name: r.name, count: r.list.length, colors: [...r.colors], animating: animate && visible && !document.hidden, frames: stats.frames, maxMs: stats.maxMs } : null),
      stop() { stopLoop(); document.removeEventListener('visibilitychange', onDoc); observer?.disconnect(); r = null; },
    };
  };
  // What is running, for tests and a glance in DevTools.
  window.setBackdropEffect.info = () => (run ? { name: run.name, count: run.list.length, colors: [...run.colors], line: run.colors.line, speed: run.speed, size: style.size, interact: run.interact, still: run.still, stats: { ...run.stats } } : null);
})();
