// For the annotate e2e suites: source of a function, run in the overlay's world, that gives the ink box of a <text> the
// annotate tool wrote (the real glyphs of its lines, measured with canvas measureText in its font), not the font's padded
// em box that getBoundingClientRect returns. Use as `(${INK_FN})(textElement)` -> { left, top, right, bottom }.
const INK_FN = `(e) => {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = e.getAttribute('font-weight') + ' ' + e.getAttribute('font-size') + 'px ' + e.getAttribute('font-family');
  const ls = Array.from(e.querySelectorAll('tspan')).map((t) => {
    const mm = ctx.measureText(t.textContent), x = Number(t.getAttribute('x')), y = Number(t.getAttribute('y'));
    return { left: x - mm.actualBoundingBoxLeft, right: x + mm.actualBoundingBoxRight, top: y - mm.actualBoundingBoxAscent, bottom: y + mm.actualBoundingBoxDescent };
  });
  return { left: Math.min(...ls.map((q) => q.left)), right: Math.max(...ls.map((q) => q.right)), top: Math.min(...ls.map((q) => q.top)), bottom: Math.max(...ls.map((q) => q.bottom)) };
}`;

module.exports = { INK_FN };
