// [look] Animated effects over the new-tab background (Settings → Appearance → Animated effect):
// Particles (dots joined by lines, like particles.js), Stars (a twinkling night sky), Bubbles and
// Snow. newtab.js loads this file only when an effect is on, so with it off it costs nothing.
// One small canvas, kept light on purpose: a particle count scaled to the window and capped, at
// most 30 frames a second (20 and half as many particles in Performance mode), a capped pixel
// ratio, nothing drawn while the tab is hidden, and one still frame with Reduce motion.

(() => {
  const TAU = Math.PI * 2;
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);

  // Each effect: how many per 10,000 px² (and a cap), how to make one, move one, and draw them all.
  const EFFECTS = {
    particles: {
      density: 0.9, max: 80,
      make: (w, h) => ({ x: rand(0, w), y: rand(0, h), vx: rand(-0.35, 0.35), vy: rand(-0.35, 0.35), r: rand(1.2, 2.6) }),
      step(p, w, h, dt) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < 0 || p.x > w) p.vx = -p.vx;
        if (p.y < 0 || p.y > h) p.vy = -p.vy;
      },
      draw(ctx, list, rgb, mouse) {
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
          if (mouse.on) {
            const dx = a.x - mouse.x; const dy = a.y - mouse.y;
            if (dx * dx + dy * dy < 180 * 180) buckets[0].push(a, mouse); // the pointer grabs the dots near it
          }
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = `rgb(${rgb})`;
        buckets.forEach((pairs, k) => {
          if (!pairs.length) return;
          ctx.globalAlpha = 0.34 - k * 0.08;
          ctx.beginPath();
          for (let i = 0; i < pairs.length; i += 2) { ctx.moveTo(pairs[i].x, pairs[i].y); ctx.lineTo(pairs[i + 1].x, pairs[i + 1].y); }
          ctx.stroke();
        });
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = `rgb(${rgb})`;
        ctx.beginPath();
        for (const p of list) { ctx.moveTo(p.x + p.r, p.y); ctx.arc(p.x, p.y, p.r, 0, TAU); }
        ctx.fill();
      },
    },
    stars: {
      density: 2.2, max: 220,
      make: (w, h) => ({ x: rand(0, w), y: rand(0, h), r: Math.random() < 0.9 ? rand(0.4, 1.2) : rand(1.2, 2.2), phase: rand(0, TAU), speed: rand(0.01, 0.04), vx: rand(-0.06, 0.06), vy: rand(-0.04, 0.02) }),
      step(p, w, h, dt) {
        p.phase += p.speed * dt;
        p.x = (p.x + p.vx * dt + w) % w; p.y = (p.y + p.vy * dt + h) % h;
      },
      draw(ctx, list, rgb, mouse) {
        ctx.fillStyle = `rgb(${rgb})`;
        // Grouped by brightness so a few fills draw them all; stars near the pointer glow.
        for (let level = 0; level < 4; level++) {
          ctx.globalAlpha = 0.25 + level * 0.22;
          ctx.beginPath();
          for (const p of list) {
            let tw = (Math.sin(p.phase) + 1) / 2;
            let r = p.r;
            if (mouse.on) {
              const dx = p.x - mouse.x; const dy = p.y - mouse.y; const d2 = dx * dx + dy * dy;
              if (d2 < 120 * 120) { const k = 1 - Math.sqrt(d2) / 120; tw = Math.min(1, tw + k); r += k * 1.6; }
            }
            if (Math.min(3, Math.floor(tw * 4)) !== level) continue;
            ctx.moveTo(p.x + r, p.y); ctx.arc(p.x, p.y, r, 0, TAU);
          }
          ctx.fill();
        }
      },
    },
    bubbles: {
      density: 0.22, max: 36,
      make: (w, h, fresh) => ({ x: rand(0, w), y: fresh ? h + rand(10, 80) : rand(0, h), r: rand(6, 30), vy: rand(0.25, 0.8), wob: rand(0, TAU), ox: 0 }),
      step(p, w, h, dt, mouse) {
        p.y -= p.vy * dt; p.wob += 0.02 * dt;
        let push = 0;
        if (mouse.on) { // the pointer nudges bubbles aside
          const dx = p.x - mouse.x; const dy = p.y - mouse.y; const d = Math.hypot(dx, dy);
          if (d < 110) push = (dx >= 0 ? 1 : -1) * (110 - d) * 0.06;
        }
        p.ox = p.ox * 0.94 + push;
        if (p.y + p.r < 0) Object.assign(p, EFFECTS.bubbles.make(w, h, true));
      },
      draw(ctx, list, rgb) {
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = `rgb(${rgb})`;
        ctx.fillStyle = `rgb(${rgb})`;
        ctx.globalAlpha = 0.08;
        ctx.beginPath();
        for (const p of list) { const x = p.x + Math.sin(p.wob) * 6 + p.ox; ctx.moveTo(x + p.r, p.y); ctx.arc(x, p.y, p.r, 0, TAU); }
        ctx.fill();
        ctx.globalAlpha = 0.4;
        ctx.stroke();
        ctx.globalAlpha = 0.5; // a highlight on each
        ctx.beginPath();
        for (const p of list) { const x = p.x + Math.sin(p.wob) * 6 + p.ox - p.r * 0.35; const y = p.y - p.r * 0.35; const hr = Math.max(1, p.r * 0.18); ctx.moveTo(x + hr, y); ctx.arc(x, y, hr, 0, TAU); }
        ctx.fill();
      },
    },
    snow: {
      density: 0.8, max: 110,
      make: (w, h, fresh) => ({ x: rand(0, w), y: fresh ? rand(-40, -5) : rand(0, h), r: rand(0.8, 3), vy: rand(0.3, 1.1), sway: rand(0, TAU) }),
      step(p, w, h, dt) {
        p.y += p.vy * dt; p.sway += 0.015 * dt;
        p.x += Math.sin(p.sway) * 0.35 * dt;
        if (p.y - p.r > h) Object.assign(p, EFFECTS.snow.make(w, h, true));
        if (p.x < -5) p.x = w + 5; else if (p.x > w + 5) p.x = -5;
      },
      draw(ctx, list, rgb) {
        ctx.fillStyle = `rgb(${rgb})`;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        for (const p of list) { ctx.moveTo(p.x + p.r, p.y); ctx.arc(p.x, p.y, p.r, 0, TAU); }
        ctx.fill();
      },
    },
  };

  let run = null; // { name, still, lite, canvas, ctx, list, raf, ... } while an effect is on

  function stop() {
    if (!run) return;
    cancelAnimationFrame(run.raf);
    removeEventListener('resize', run.onResize);
    removeEventListener('pointermove', run.onPointer);
    document.documentElement.removeEventListener('pointerleave', run.onLeave);
    run.canvas.remove();
    run = null;
  }

  // The dots' color: white over a background, the page's text color on Plain.
  function colorOf() {
    const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).color);
    return m ? `${m[1]}, ${m[2]}, ${m[3]}` : '255, 255, 255';
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
    const fx2 = EFFECTS[r.name];
    const want = Math.min(fx2.max, Math.round(((w * h) / 10000) * fx2.density)) * (r.lite ? 0.5 : 1);
    while (r.list.length < want) r.list.push(fx2.make(w, h, false));
    r.list.length = Math.max(0, Math.round(want));
    r.rgb = colorOf();
  }

  function draw() {
    const r = run;
    r.ctx.clearRect(0, 0, r.w, r.h);
    EFFECTS[r.name].draw(r.ctx, r.list, r.rgb, r.mouse);
    r.ctx.globalAlpha = 1;
  }

  function frame(t) {
    const r = run;
    if (!r) return;
    r.raf = requestAnimationFrame(frame); // the browser stops calling this while the tab is hidden
    const interval = r.lite ? 50 : 33;
    if (t - r.last < interval) return;
    const dt = Math.min(3, (t - (r.last || t - interval)) / 16.7); // in 60 Hz frames; a long pause doesn't jump
    r.last = t;
    if (r.resized) { r.resized = false; size(); }
    const fx = EFFECTS[r.name];
    for (const p of r.list) fx.step(p, r.w, r.h, dt, r.mouse);
    draw();
  }

  // name: an EFFECTS key or anything else for none. still: one frame, no animation. lite: Performance mode.
  window.setBackdropEffect = (name, { still = false, lite = false } = {}) => {
    const motion = !still && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (run && run.name === name && run.still === !motion && run.lite === lite) { run.rgb = colorOf(); if (!motion) draw(); return; }
    stop();
    if (!EFFECTS[name]) return;
    const canvas = document.createElement('canvas');
    canvas.id = 'effect';
    canvas.setAttribute('aria-hidden', 'true');
    document.getElementById('backdrop').after(canvas);
    run = { name, still: !motion, lite, canvas, ctx: canvas.getContext('2d'), list: [], raf: 0, last: 0, w: 0, h: 0, mouse: { on: false, x: 0, y: 0 } };
    size();
    if (!motion) { draw(); return; }
    run.onResize = () => { run.resized = true; };
    run.onPointer = (e) => { run.mouse.on = true; run.mouse.x = e.clientX; run.mouse.y = e.clientY; };
    run.onLeave = () => { run.mouse.on = false; };
    addEventListener('resize', run.onResize, { passive: true });
    addEventListener('pointermove', run.onPointer, { passive: true });
    document.documentElement.addEventListener('pointerleave', run.onLeave);
    run.raf = requestAnimationFrame(frame);
  };
})();
