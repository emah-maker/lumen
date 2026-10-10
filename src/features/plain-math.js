// LaTeX in a reply, as plain text for places that can't render it: system notifications, and other one-line
// summaries. "$x_2 \approx 93.9\%$" -> "x₂ ≈ 93.9%", "\frac{a+b}{2}" -> "(a+b)/2". Pure; best effort: anything it does
// not know keeps its letters without the backslash, so the line stays readable rather than exact.

const SYMBOLS = {
  approx: '≈', sim: '∼', simeq: '≃', cong: '≅', equiv: '≡', neq: '≠', ne: '≠', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  ll: '≪', gg: '≫', pm: '±', mp: '∓', times: '×', cdot: '·', div: '÷', ast: '∗', circ: '∘', bullet: '•',
  infty: '∞', partial: '∂', nabla: '∇', sum: 'Σ', prod: 'Π', int: '∫', oint: '∮', sqrt: '√',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃',
  degree: '°', circledast: '⊛', propto: '∝', perp: '⊥', parallel: '∥', angle: '∠', ldots: '…', cdots: '⋯', dots: '…',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ' };
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', T: 'ᵀ', '∘': '°' };

// Every character in the table: the Unicode form; otherwise "_(text)" / "^(text)" so nothing is lost.
const script = (text, table, mark) => {
  const chars = [...text];
  if (chars.length && chars.every((ch) => table[ch])) return chars.map((ch) => table[ch]).join('');
  return chars.length === 1 ? `${mark}${text}` : `${mark}(${text})`;
};

// The braced group at `i` (s[i] === '{'), or a single token: [content, next index].
function group(s, i) {
  while (s[i] === ' ') i++;
  if (s[i] === '{') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    return [s.slice(i + 1), s.length];
  }
  if (s[i] === '\\') { const m = /^\\[a-zA-Z]+|^\\./.exec(s.slice(i)); if (m) return [m[0], i + m[0].length]; }
  return [s[i] || '', i + 1];
}
const wrap = (text) => (/^[\w.]+$|^[^\s+\-*/=]$/u.test(text) ? text : `(${text})`);

// One math expression (without its $ delimiters) as text.
function texToText(tex) {
  let s = String(tex);
  let out = '';
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (ch === '\\') {
      const m = /^\\([a-zA-Z]+)|^\\(.)/.exec(s.slice(i));
      if (!m) { i++; continue; }
      const name = m[1] || m[2];
      i += m[0].length;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const [a, j] = group(s, i); const [b, k] = group(s, j); i = k;
        out += `${wrap(texToText(a))}/${wrap(texToText(b))}`;
      } else if (name === 'sqrt') {
        let degree = '';
        if (s[i] === '[') { const end = s.indexOf(']', i); degree = s.slice(i + 1, end); i = end + 1; }
        const [a, j] = group(s, i); i = j;
        out += `${degree ? script(texToText(degree), SUP, '^') : ''}√${wrap(texToText(a))}`;
      } else if (/^(text|textrm|textbf|textit|mathrm|mathbf|mathit|operatorname|mbox|boldsymbol|mathsf|mathtt)$/.test(name)) {
        const [a, j] = group(s, i); i = j; out += texToText(a);
      } else if (/^(left|right|big|Big|bigg|Bigg|displaystyle|textstyle|limits|nolimits)$/.test(name)) {
        // sizing only
      } else if (name === ',' || name === ';' || name === ':' || name === ' ' || name === 'quad' || name === 'qquad' || name === '!') {
        out += name === '!' ? '' : ' ';
      } else if (/^[%$&#_{}]$/.test(name)) {
        out += name;
      } else if (name === '\\') {
        out += ' ';
      } else {
        out += SYMBOLS[name] ?? name;
      }
    } else if (ch === '_' || ch === '^') {
      const [a, j] = group(s, i + 1); i = j;
      out += script(texToText(a), ch === '_' ? SUB : SUP, ch);
    } else if (ch === '{' || ch === '}') {
      i++;
    } else if (ch === '~') {
      out += ' '; i++;
    } else {
      out += ch; i++;
    }
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

// Text with math in $…$, $$…$$, \(…\) or \[…\]: each expression as plain text, the rest unchanged. A "$" that is
// money ("$5 and $10") is left alone: an expression must not start or end with a space and must hold no newline.
function plainMath(text) {
  return String(text ?? '')
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => texToText(tex))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex) => texToText(tex))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex) => texToText(tex))
    .replace(/(^|[^\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\w)/g, (m, before, tex) => (/^\d+(?:[.,]\d+)?$/.test(tex) ? m : `${before}${texToText(tex)}`));
}

module.exports = { plainMath, texToText };
