// [look] Animated effects over the new-tab background (Settings → Appearance → Animated effect):
// Particles (dots joined by lines, like particles.js), Stars (a twinkling night sky), Bubbles and
// Snow, in a color (automatic, the accent, rainbow or any), an amount, a speed and a size, and
// optionally reacting to the pointer. newtab.js loads this file only when an effect is on, so with
// it off it costs nothing. One small canvas that never takes a click (pointer-events: none; the
// page's CSS also fades it behind the content column), kept light on purpose: a particle count
// scaled to the window and capped, at most 30 frames a second (20 and half as many particles in
// Performance mode), a capped pixel ratio, nothing drawn while the tab is hidden, and one still
// frame with Reduce motion. Each color is one batched fill, so rainbow costs a few more calls only.

(() => {
  const TAU = Math.PI * 2;
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const LEVEL = { few: 0.5, normal: 1, many: 1.8, slow: 0.5, fast: 1.8, small: 0.65, large: 1.6 };
  const RAINBOW = ['255, 99, 132', '255, 159, 64', '255, 214, 10', '52, 199, 89', '10, 132, 255', '191, 90, 242'];

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
      draw(ctx, list, colors, mouse) {
        const LINK = 130;
        // Lines in four opacity buckets: four strokes a frame instead of one per line.
        const buckets = [[], [], [], []];
        for (let i = 0; i < list.length; i++) {
          const a = list[i];
          for (let j = i + 1; j < list.length; j++) {
            const b = list[j];
            const dx = a.x - b.x; const dy = a.y - b.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < LINK * LINK) buckets[Math.min(3, Math.floor((Math.sqrt(d2) / LINK) * 4))].push(a, b);
          }
          if (near(a, mouse, 180)) buckets[0].push(a, mouse); // the pointer grabs the dots near it
        }
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
  };

  let run = null; // { name, key, canvas, ctx, list, raf, colors, ... } while an effect is on

  function stop() {
    if (!run) return;
    cancelAnimationFrame(run.raf);
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
  function colorsOf(choice) {
    const text = rgbOf(getComputedStyle(document.body).color);
    const colors = choice === 'rainbow' ? [...RAINBOW]
      : choice === 'accent' ? [rgbOf(getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#0a84ff')]
        : /^#[0-9a-f]{6}$/i.test(choice || '') ? [rgbOf(choice)] : [text];
    colors.line = choice === 'rainbow' ? text : colors[0];
    return colors;
  }

  function size() {
    const r = run;
    const dpr = Math.min(devicePixelRatio || 1, r.lite ? 1 : 1.5);
    const w = innerWidth; const h = innerHeight;
    r.canvas.width = Math.round(w * dpr); r.canvas.height = Math.round(h * dpr);
    r.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const fx = r.w ? w / r.w : 1; const fy = r.h ? h / r.h : 1;
    for (const p of r.list) { p.x *= fx; p.y *= fy; }
    r.w = w; r.h = h;
    const e = EFFECTS[r.name];
    const want = Math.round(Math.min(e.max, ((w * h) / 10000) * e.density) * r.amount * (r.lite ? 0.5 : 1));
    while (r.list.length < want) r.list.push(Object.assign(e.make(w, h, false), { c: Math.floor(Math.random() * RAINBOW.length) }));
    r.list.length = Math.max(0, want);
    r.colors = colorsOf(r.color);
  }

  function draw() {
    const r = run;
    r.ctx.clearRect(0, 0, r.w, r.h);
    EFFECTS[r.name].draw(r.ctx, r.list, r.colors, r.mouse);
    r.ctx.globalAlpha = 1;
  }

  function frame(t) {
    const r = run;
    if (!r) return;
    r.raf = requestAnimationFrame(frame); // the browser stops calling this while the tab is hidden
    const interval = r.lite ? 50 : 33;
    if (t - r.last < interval) return;
    const dt = (Math.min(3, (t - (r.last || t - interval)) / 16.7)) * r.speed; // in 60 Hz frames; a long pause doesn't jump
    r.last = t;
    if (r.resized) { r.resized = false; size(); }
    const e = EFFECTS[r.name];
    for (const p of r.list) e.step(p, r.w, r.h, dt, r.mouse);
    draw();
  }

  // name: an EFFECTS key or anything else for none. still: one frame, no animation. lite: Performance
  // mode. effectStyle: { color, amount, speed, size, interact } (settings-backend.js newTabLook).
  window.setBackdropEffect = (name, { still = false, lite = false, effectStyle = {} } = {}) => {
    const motion = !still && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const s = effectStyle || {};
    const opts = { color: typeof s.color === 'string' ? s.color : 'auto', amount: LEVEL[s.amount] || 1, speed: LEVEL[s.speed] || 1, size: LEVEL[s.size] || 1, interact: s.interact !== false };
    const key = JSON.stringify([name, motion, lite, opts.amount, opts.size, opts.interact]);
    if (run && run.key === key) { // same particles: only the color or speed changed
      Object.assign(run, { color: opts.color, speed: opts.speed, colors: colorsOf(opts.color) });
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
    run = { name, key, lite, ...opts, canvas, ctx: canvas.getContext('2d'), list: [], raf: 0, last: 0, w: 0, h: 0, mouse: { on: false, x: 0, y: 0 } };
    size();
    if (!motion) { draw(); return; }
    run.onResize = () => { run.resized = true; };
    addEventListener('resize', run.onResize, { passive: true });
    if (opts.interact) {
      run.onPointer = (e) => { run.mouse.on = true; run.mouse.x = e.clientX; run.mouse.y = e.clientY; };
      run.onLeave = () => { run.mouse.on = false; };
      addEventListener('pointermove', run.onPointer, { passive: true });
      document.documentElement.addEventListener('pointerleave', run.onLeave);
    }
    run.raf = requestAnimationFrame(frame);
  };
  // What is running, for tests and a glance in DevTools.
  window.setBackdropEffect.info = () => (run ? { name: run.name, count: run.list.length, colors: [...run.colors], line: run.colors.line, speed: run.speed, size: style.size, interact: run.interact, still: run.still } : null);
})();
