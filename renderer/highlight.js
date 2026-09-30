// Syntax colours for code blocks in chat replies: one small tokenizer (comments, strings, numbers,
// keywords, types, functions) with keyword lists for the languages replies use most. No library: the
// sidebar loads nothing it doesn't need, and a block is coloured in well under a millisecond.
(() => {
  const words = (s) => new Set(s.split(' '));
  const C_LIKE = 'if else for while do switch case default break continue return goto sizeof typedef struct union enum const static extern volatile register inline void';
  const KEYWORDS = {
    js: words('var let const function return if else for while do switch case default break continue new delete typeof instanceof in of class extends super this import export from as async await yield try catch finally throw void null undefined true false static get set'),
    ts: words('var let const function return if else for while do switch case default break continue new delete typeof instanceof in of class extends super this import export from as async await yield try catch finally throw void null undefined true false static get set interface type enum implements private public protected readonly abstract declare namespace keyof infer is satisfies never unknown any'),
    py: words('def return if elif else for while break continue pass class import from as try except finally raise with lambda yield global nonlocal assert del in is not and or None True False async await match case self'),
    sh: words('if then else elif fi for in do done while until case esac function return local export readonly unset shift exit echo cd source set'),
    ps: words('function param if elseif else foreach for while do until switch return break continue try catch finally throw begin process end in'),
    go: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false'),
    rust: words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err'),
    java: words('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws try void volatile while null true false var record'),
    c: words(`${C_LIKE} int char float double long short unsigned signed bool true false NULL auto class namespace template typename public private protected virtual override new delete this nullptr using try catch throw`),
    cs: words('abstract as base bool break byte case catch char class const continue decimal default delegate do double else enum event explicit extern false finally float for foreach if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sealed short static string struct switch this throw true try typeof uint ulong using var virtual void while async await get set'),
    sql: words('select from where and or not insert into values update set delete create table drop alter index join left right inner outer full on group by order having limit offset as distinct union all null is in like between case when then else end primary key foreign references default exists with returning'),
    css: words('important media supports keyframes import from to and not only'),
    json: words('true false null'),
  };
  const ALIAS = { javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js', typescript: 'ts', tsx: 'ts', python: 'py', py3: 'py', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', powershell: 'ps', pwsh: 'ps', ps1: 'ps', golang: 'go', rs: 'rust', kotlin: 'java', kt: 'java', scala: 'java', swift: 'java', dart: 'java', cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', cc: 'c', objc: 'c', csharp: 'cs', 'c#': 'cs', postgres: 'sql', mysql: 'sql', sqlite: 'sql', scss: 'css', less: 'css', jsonc: 'json', json5: 'json' };
  const HASH_COMMENT = new Set(['py', 'sh', 'ps', 'rb']);
  // One pass, left to right: the first alternative that matches at a position wins.
  function tokenizer(lang) {
    const comment = lang === 'sql' ? '--[^\\n]*|/\\*[\\s\\S]*?\\*/'
      : HASH_COMMENT.has(lang) ? '#[^\\n]*'
      : lang === 'json' ? '(?!)'
      : lang === 'css' ? '/\\*[\\s\\S]*?\\*/'
      : '//[^\\n]*|/\\*[\\s\\S]*?\\*/';
    const strings = lang === 'py' ? '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|' : '';
    const templ = lang === 'js' || lang === 'ts' ? '|`(?:\\\\[\\s\\S]|[^`\\\\])*`' : '';
    return new RegExp(`(${comment})|(${strings}"(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'${templ})|(\\b(?:0x[\\da-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)|([A-Za-z_$][\\w$]*)`, 'g');
  }
  const cache = new Map();
  const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  function highlight(code, langName) {
    const lang = ALIAS[langName] || langName;
    const keys = KEYWORDS[lang];
    if (!keys || code.length > 60000) return null; // unknown language, or too big to be worth it: plain
    let re = cache.get(lang);
    if (!re) cache.set(lang, (re = tokenizer(lang)));
    re.lastIndex = 0;
    let out = '';
    let at = 0;
    for (let m; (m = re.exec(code));) {
      if (!m[0]) { re.lastIndex++; continue; }
      out += esc(code.slice(at, m.index));
      at = m.index + m[0].length;
      const [text, com, str, num, word] = m;
      const nextParen = word !== undefined && /^\s*\(/.test(code.slice(at, at + 8));
      const cls = com ? 'tk-com' : str ? (lang === 'json' && /^\s*:/.test(code.slice(at, at + 8)) ? 'tk-key' : 'tk-str') : num ? 'tk-num'
        : keys.has(text) || (lang === 'sql' && keys.has(text.toLowerCase())) ? 'tk-kw'
        : nextParen ? 'tk-fn'
        : /^[A-Z][a-z]\w*$/.test(text) && lang !== 'sql' ? 'tk-type' : '';
      out += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text);
    }
    return out + esc(code.slice(at));
  }
  window.highlightCode = (codeEl, langName) => {
    const lang = String(langName || '').toLowerCase();
    if (!lang || codeEl.dataset.hl) return;
    const html = highlight(codeEl.textContent, lang);
    if (html === null) return;
    codeEl.innerHTML = html;
    codeEl.dataset.hl = '1';
  };
  window.highlightCode.test = highlight; // (unit tests)
})();
