// Graphics: Automatic / Full effects / Light (Settings > System). "Light" is Lumen's integrated-GPU path: no backdrop blur
// (a solid, slightly more opaque tint instead), a cheaper particle effect (fewer particles, a smaller canvas, 24 fps) and no
// effect that repaints every frame while nothing happens. Automatic picks Light on an integrated GPU.
//
// Decided once, at start-up, from the GPU Chromium is really drawing with (app.getGPUInfo) and the setting. It never listens to
// power, battery or speed-limit events (Performance mode does, features/performance.js; it is not read here), so a power source that
// flips every few seconds cannot toggle it.
const MODES = ['auto', 'full', 'light'];
const INTEL = 0x8086;
const AMD = 0x1002;
const MICROSOFT = 0x1414; // "Microsoft Basic Render Driver": the software fallback, never a real choice

// Is this device an integrated GPU? Intel (except the discrete Arc A/B cards) and AMD's APU graphics ("Radeon(TM) Graphics", "Radeon 780M",
// "Vega 8"); not an RX, a Pro or an Instinct card.
function isIntegrated(d) {
  const name = String(d.deviceString || d.name || '');
  const vendor = Number(d.vendorId ?? d.vendor);
  if (vendor === INTEL) return !/\bArc\b.*\b[AB]\d{3}\b/i.test(name) && !/\bData Center\b|\bMax\b/i.test(name);
  if (vendor === AMD) return /Radeon(?:\(TM\))?\s+(?:Graphics|\d{3}M\b)|Vega\s*\d+\s+Graphics/i.test(name) && !/\bRX\b|\bPro\b|\bInstinct\b/i.test(name);
  return false;
}

// devices: getGPUInfo's gpuDevice list. Returns { integrated, why, device }.
function classify(devices) {
  const real = (Array.isArray(devices) ? devices : []).filter((d) => Number(d.vendorId ?? d.vendor) !== MICROSOFT && (d.deviceString || d.name));
  if (!real.length) return { integrated: false, why: 'no GPU reported', device: null };
  const active = real.find((d) => d.active);
  const device = active || (real.length === 1 ? real[0] : null);
  if (!device) return { integrated: false, why: 'several GPUs, none reported as active', device: null };
  const name = device.deviceString || device.name;
  if (isIntegrated(device)) return { integrated: true, why: 'the active GPU is integrated', device: name };
  if (real.length === 1) return { integrated: true, why: 'the only GPU', device: name }; // one GPU shared with the display: the same budget
  return { integrated: false, why: 'the active GPU is a discrete card', device: name };
}

// deps: { app, readSettings, onChange? }
function create(deps) {
  const { app, readSettings, onChange } = deps;
  let detected = { integrated: false, why: 'not checked yet', device: null };
  let last = null;
  const mode = () => (MODES.includes(readSettings().graphicsMode) ? readSettings().graphicsMode : 'auto');
  const light = () => mode() === 'light' || (mode() === 'auto' && detected.integrated);
  const info = () => ({ mode: mode(), light: light(), integrated: detected.integrated, device: detected.device, why: detected.why });
  const refresh = () => { const now = light(); if (now !== last) { last = now; onChange?.(info()); } };
  // Once, after the GPU process has reported.
  async function detect() {
    try { detected = classify((await app.getGPUInfo('complete')).gpuDevice); } catch { /* keep "not checked" */ }
    refresh();
    return detected;
  }
  return { mode, light, info, refresh, detect, setDetected: (d) => { detected = d; refresh(); } };
}

module.exports = { MODES, classify, isIntegrated, create };
