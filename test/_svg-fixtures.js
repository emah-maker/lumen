// The diagram from the bug report (a model's inline SVG: arrows from <marker>, a unicode label), and a hostile one.
const DIAGRAM = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">',
  '  <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#333"/></marker></defs>',
  '  <rect x="70" y="70" width="100" height="100" fill="#e8f0fe" stroke="#111" stroke-width="2"/>',
  '  <line x1="20" y1="120" x2="68" y2="120" stroke="#333" stroke-width="2" marker-end="url(#arr)"/>',
  '  <line x1="220" y1="120" x2="172" y2="120" stroke="#333" stroke-width="2" marker-end="url(#arr)"/>',
  '  <text x="120" y="125" font-family="sans-serif" font-size="14" fill="#111" text-anchor="middle">τ = 9000 psi</text>',
  '</svg>',
].join('\n');

const EVIL = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" onload="window.__svgPwned=(window.__svgPwned||0)+1">',
  '<script>window.__svgPwned=(window.__svgPwned||0)+1;console.log("svg-script-ran")</script>',
  '<rect width="120" height="60" fill="#cde" onclick="window.__svgPwned=9"/>',
  '<foreignObject width="100" height="50"><body xmlns="http://www.w3.org/1999/xhtml" onload="window.__svgPwned=2"><img src="x" onerror="window.__svgPwned=3"/></body></foreignObject>',
  '<image href="https://example.invalid/leak.png" width="10" height="10"/>',
  '<text x="10" y="30" fill="#111">safe label</text>',
  '</svg>',
].join('\n');

module.exports = { DIAGRAM, EVIL };
