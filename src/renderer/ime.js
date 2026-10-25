// One question every Enter handler in Lumen's own pages asks first: is this Enter only confirming an IME composition (Japanese, Chinese,
// Korean input)? If so it must not send, submit or navigate. Chromium marks that keydown isComposing / keyCode 229; Safari-style engines
// deliver it just AFTER compositionend with both cleared, so compositionend also stamps a short window (test/units/ime-enter-units.js).
let imeCompositionEnd = -1e9;
const IME_WINDOW_MS = 60;
function isImeEnter(e) {
  if (!e) return false;
  if (e.isComposing || e.keyCode === 229) return true;
  return e.key === 'Enter' && (e.timeStamp || 0) - imeCompositionEnd >= 0 && (e.timeStamp || 0) - imeCompositionEnd < IME_WINDOW_MS;
}
if (typeof window !== 'undefined') window.addEventListener('compositionend', (e) => { imeCompositionEnd = e.timeStamp || 0; }, true);
if (typeof module !== 'undefined' && module.exports) module.exports = { isImeEnter, markCompositionEnd: (t) => { imeCompositionEnd = t; } };
