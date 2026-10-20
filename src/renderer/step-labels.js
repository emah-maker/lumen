// The one readable line a step of the AI's work shows in the chat ("Reading p2.png", "Running pdf2png.ps1"), instead of the raw
// command. Pure: a plain script in the UI (window.stepLabels), require()d by the engines and the tests.
//
//   label(name, input)           the line: the tool's own `description` first, else a humanized label per tool, else a summary of the shell command
//   summarizeCommand(command)    "cd X && powershell -File pdf2png.ps1" -> "Running pdf2png.ps1"; never the raw command, at most ~70 characters
//   surfaceOf(name)              'browser' | 'shell' | null: which activity card a step belongs to (chat step-ui.js)
//   groupInfo(name, input, label) what makes consecutive steps one row ("Read 4 pages", "Used PowerShell 3 times")
//   failure(name, input, error)  { text: "Couldn't read p2.png", why: "the file was empty" }
//   taskName(text)               the user's request in about four words, for a card's subtitle
//   compactInput(name, input)    the part of a step's input kept with the saved chat (bounded)
// Strings come from locales/en.json through `t` (the UI's window.t; in Node the English table).
(function (root) {
  const MAX = 70;
  // A skill's message is wrapped for the model in <skill_request name=".." title=".." input="..">prompt</skill_request> (features/skills.js).
  // None of that is for the user: wherever a message becomes a label, title, preview or search text it goes through skillText, which
  // reads it as "Research skill: what you typed". Complete, cut off ("<skill_request name="research" …") or stray: never raw.
  const SKILL_TAG = /<skill_request\b([^>]*)(?:>[\s\S]*?<\/skill_request>|>[\s\S]*$|$)|<\/skill_request>/gi;
  const decodeEntities = (s) => String(s).replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
  const attrOf = (attrs, k) => { const m = new RegExp(`\\b${k}="([^"]*)${k === 'input' ? '' : '"'}`).exec(attrs); return m ? decodeEntities(m[1]).trim() : ''; };
  const hasSkill = (v) => typeof v === 'string' && v.includes('skill_request');
  // { title, input } of one tag's attributes; the title falls back to the skill's name ("research-notes" -> "Research notes").
  function skillParts(attrs) {
    const name = attrOf(attrs, 'name').replace(/[-_]+/g, ' ');
    const title = attrOf(attrs, 'title') || (name ? name.charAt(0).toUpperCase() + name.slice(1) : '');
    return { title, input: attrOf(attrs, 'input') };
  }
  // The text with each skill message replaced by "Title skill: input" (t: the UI's translator; English when none).
  function skillText(text, t, form = 'label') {
    const s = String(text ?? '');
    if (!hasSkill(s)) return s;
    const tr = t || (typeof root.t === 'function' && root.t) || api.en || ((k, v) => (k === 'skill.label' ? v.title + ' skill: ' + v.input : v.title + ' skill'));
    return s.replace(SKILL_TAG, (_m, attrs = '') => {
      const { title, input } = skillParts(attrs);
      if (form === 'task') return input || title; // a card's subtitle: what was asked, not the skill's name
      if (!title) return input;
      return input ? tr('skill.label', { title, input }) : tr('skill.label.bare', { title });
    }).replace(/\s+/g, ' ').trim();
  }
  const clip = (v, n = MAX) => { const s = skillText(v ?? '', null).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  // The last piece of a path, either slash; a url keeps its host.
  const base = (p) => { const s = String(p || '').replace(/[\\/]+$/, ''); return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1); };
  const dirOf = (p) => { const s = String(p || '').replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i > 0 ? s.slice(0, i) : ''; };
  const hostOf = (u) => { try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`).host.replace(/^www\./, ''); } catch { return clip(u, 40); } };
  const stripQuotes = (s) => String(s || '').replace(/^["'`]+|["'`]+$/g, '');

  const SHELL = new Set(['Bash', 'PowerShell', 'Shell', 'shell', 'bash', 'powershell', 'run_shell_command', 'BashOutput']);
  const FILES = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS', 'list_files']);
  const BROWSER = new Set(['navigate', 'open_tab', 'click', 'click_at', 'type_text', 'press_key', 'scroll', 'hover', 'drag', 'fill_form', 'read_page', 'find', 'screenshot', 'go_back', 'go_forward', 'reload', 'switch_tab', 'close_tab', 'list_tabs', 'read_tabs', 'wait', 'wait_for', 'upload_file', 'handle_dialog', 'run_script', 'get_console', 'get_network', 'annotate', 'group_tabs', 'ungroup_tabs', 'batch', 'run_macro', 'verify_changes', 'read_urls', 'read_pdf', 'video_overview', 'video_frames', 'analyze_posts']);
  const bare = (name) => String(name || '').replace(/^mcp__lumen__/, '');
  const surfaceOf = (name) => {
    const n = String(name || '');
    if (SHELL.has(n)) return 'shell';
    if (FILES.has(n)) return 'shell';
    if (/^mcp__lumen__/.test(n)) return BROWSER.has(bare(n)) ? 'browser' : null;
    return BROWSER.has(n) ? 'browser' : null;
  };

  // ---- shell commands -> a short phrase. `ctx` carries t.
  const SCRIPT_EXT = /\.(?:ps1|py|js|mjs|cjs|ts|sh|bat|cmd|rb|pl|php|lua|r|jl|go|rs|java|cs|vbs)$/i;
  const INTERP = /^(?:python3?|py|node|nodejs|bun|deno|tsx|ts-node|ruby|perl|php|bash|sh|zsh|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?|cscript|wscript|java|go run|dotnet|lua|Rscript)$/i;

  // The first command of a pipeline/chain that does the work: leading `cd`, `export`, `set`, `source`, `echo`-only steps are skipped.
  function splitChain(command) {
    const out = [];
    let cur = '';
    let q = '';
    const s = String(command || '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = ''; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) { out.push(cur); cur = ''; i++; continue; }
      if (c === ';' || c === '\n') { out.push(cur); cur = ''; continue; }
      if (c === '|') { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  }
  // Words of one command, quotes removed (a quoted argument stays one word).
  function words(cmd) {
    const out = [];
    const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
  }
  const isFlag = (w) => /^-{1,2}[\w-]+$/.test(w) || /^\/[A-Za-z?]$/.test(w);
  const lastFileArg = (ws) => { for (let i = ws.length - 1; i > 0; i--) { const w = stripQuotes(ws[i]); if (w && !isFlag(w) && !/^\d+$/.test(w) && /[\\/.]/.test(w) && !/^s[/|#,]/.test(w)) return base(w); } return ''; };

  function summarizeCommand(command, t) {
    const T = (k, v) => t(k, v);
    const raw = String(command || '');
    const chain = splitChain(raw);
    const heredoc = /^\s*cat\s+(?:>>?|-\s*>)\s*("[^"]+"|'[^']+'|\S+)\s*<<-?\s*['"]?\w+/s.exec(raw) || /^\s*(?:tee|cat\s*>>?)\s+("[^"]+"|'[^']+'|\S+)\s*<<-?/s.exec(raw);
    if (heredoc) return clip(T('step.cmd.write', { name: base(stripQuotes(heredoc[1])) }));
    const redirect = /^\s*(?:echo|printf|Set-Content|Out-File)\b.*?(?:>>?|-Path|-FilePath)\s*("[^"]+"|'[^']+'|[^\s|;&]+)\s*$/is.exec(chain.find((c) => !/^(?:cd|pushd|set-location)\b/i.test(c)) || '');
    if (redirect && !/^\s*echo\s*$/.test(raw)) return clip(T('step.cmd.write', { name: base(stripQuotes(redirect[1])) }));
    const work = chain.filter((c) => !/^(?:cd|pushd|popd|set-location|export|set|source|\.|chcp|clear|cls|\$ErrorActionPreference|\$ProgressPreference|\[Console\]|\[System\.Console\]|echo\s*["']?\s*["']?$)\b/i.test(c));
    const first = (work.length ? work : chain)[0] || '';
    const ws = words(first);
    const prog = base(stripQuotes(ws[0] || '')).replace(/\.exe$/i, '');
    const lc = prog.toLowerCase();
    const rest = ws.slice(1);
    const hasPipeTo = chain.length > 1;
    // sed / awk in place: "Editing <file>"
    if (lc === 'sed' && rest.some((w) => /^-[a-z]*i/.test(w) || w === '--in-place')) { const f = lastFileArg(ws); return f ? clip(T('step.cmd.edit', { name: f })) : T('step.cmd.editFiles'); }
    if (lc === 'sed' || lc === 'awk' || lc === 'grep' || lc === 'rg' || lc === 'findstr' || lc === 'select-string' || lc === 'ag') {
      const pat = rest.find((w) => !isFlag(w) && !/[\\/]/.test(w) && w.length > 0);
      return pat ? clip(T('step.cmd.search', { what: clip(stripQuotes(pat), 30) })) : T('step.cmd.searchFiles');
    }
    if (['cat', 'type', 'head', 'tail', 'less', 'more', 'get-content', 'gc', 'bat', 'nl'].includes(lc)) { const f = lastFileArg(ws); return f ? clip(T('step.cmd.read', { name: f })) : T('step.cmd.readFiles'); }
    if (['ls', 'dir', 'tree', 'get-childitem', 'gci', 'find', 'fd', 'where', 'locate'].includes(lc)) { const f = lastFileArg(ws); return f && lc !== 'find' ? clip(T('step.cmd.list', { name: f })) : T('step.cmd.listFiles'); }
    if (['mkdir', 'md', 'new-item'].includes(lc)) { const f = lastFileArg(ws) || base(stripQuotes(rest.filter((w) => !isFlag(w))[0] || '')); return f ? clip(T('step.cmd.create', { name: f })) : T('step.cmd.createFolder'); }
    if (['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri'].includes(lc)) { const f = lastFileArg(ws) || base(stripQuotes(rest.filter((w) => !isFlag(w))[0] || '')); return f ? clip(T('step.cmd.delete', { name: f })) : T('step.cmd.deleteFiles'); }
    if (['cp', 'copy', 'xcopy', 'robocopy', 'copy-item'].includes(lc)) { const f = lastFileArg(ws); return f ? clip(T('step.cmd.copy', { name: f })) : T('step.cmd.copyFiles'); }
    if (['mv', 'move', 'ren', 'rename', 'move-item', 'rename-item'].includes(lc)) { const f = lastFileArg(ws); return f ? clip(T('step.cmd.move', { name: f })) : T('step.cmd.moveFiles'); }
    if (lc === 'curl' || lc === 'wget' || lc === 'invoke-webrequest' || lc === 'iwr' || lc === 'invoke-restmethod' || lc === 'irm') { const u = ws.find((w) => /^https?:\/\//i.test(w) || /^[\w.-]+\.[a-z]{2,}\//i.test(w)); return u ? clip(T('step.cmd.fetch', { host: hostOf(u) })) : T('step.cmd.fetchSomething'); }
    if (lc === 'git') {
      const sub = rest.find((w) => !isFlag(w)) || '';
      const known = { status: 'step.cmd.git.status', diff: 'step.cmd.git.diff', log: 'step.cmd.git.log', commit: 'step.cmd.git.commit', push: 'step.cmd.git.push', pull: 'step.cmd.git.pull', fetch: 'step.cmd.git.fetch', checkout: 'step.cmd.git.checkout', switch: 'step.cmd.git.checkout', add: 'step.cmd.git.add', clone: 'step.cmd.git.clone', merge: 'step.cmd.git.merge', rebase: 'step.cmd.git.rebase', stash: 'step.cmd.git.stash', branch: 'step.cmd.git.branch', show: 'step.cmd.git.show', worktree: 'step.cmd.git.worktree' };
      return T(known[sub] || 'step.cmd.git.other');
    }
    if (lc === 'gh') return T('step.cmd.gh', { what: clip(rest.filter((w) => !isFlag(w)).slice(0, 2).join(' '), 30) });
    if (['npm', 'pnpm', 'yarn', 'bun', 'npx'].includes(lc)) {
      const sub = rest.find((w) => !isFlag(w)) || '';
      const arg = rest.filter((w) => !isFlag(w))[1] || '';
      if (lc === 'npx') return clip(T('step.cmd.run', { name: sub || lc }));
      if (['test', 't', 'tst'].includes(sub)) return T('step.cmd.tests');
      if (sub === 'run' || sub === 'run-script') { if (/^test(?::|$)/.test(arg)) return T('step.cmd.tests'); if (/^(lint|eslint)/.test(arg)) return T('step.cmd.lint'); if (/^build/.test(arg)) return T('step.cmd.build'); return clip(T('step.cmd.run', { name: `${lc} run ${arg}`.trim() })); }
      if (['install', 'i', 'ci', 'add'].includes(sub)) return T('step.cmd.install', { what: lc });
      if (sub === 'build') return T('step.cmd.build');
      if (sub === 'lint') return T('step.cmd.lint');
      if (sub === 'start' || sub === 'dev') return T('step.cmd.start');
      return clip(T('step.cmd.run', { name: `${lc} ${sub}`.trim() }));
    }
    if (['pip', 'pip3', 'uv', 'poetry', 'conda'].includes(lc) && rest.find((w) => !isFlag(w)) !== undefined && /^(install|add|sync)$/.test(rest.find((w) => !isFlag(w)))) return T('step.cmd.install', { what: lc });
    if (['pytest', 'jest', 'vitest', 'mocha', 'cargo', 'go', 'dotnet', 'mvn', 'gradle', 'make', 'tsc', 'eslint', 'prettier', 'ruff', 'cmake'].includes(lc)) {
      const sub = rest.find((w) => !isFlag(w)) || '';
      if (['pytest', 'jest', 'vitest', 'mocha'].includes(lc) || sub === 'test' || sub === 'check') return T('step.cmd.tests');
      if (['eslint', 'prettier', 'ruff'].includes(lc) || sub === 'lint' || sub === 'clippy') return T('step.cmd.lint');
      if (sub === 'build' || lc === 'tsc' || lc === 'make' || lc === 'cmake') return T('step.cmd.build');
      return clip(T('step.cmd.run', { name: `${lc} ${sub}`.trim() }));
    }
    if (lc === 'powershell' || lc === 'pwsh' || INTERP.test(lc) || INTERP.test(prog)) {
      // an interpreter: the script it runs; else -Command text is summarized on its own; else the program
      const iFile = rest.findIndex((w) => /^-{1,2}file$/i.test(w));
      const script = iFile >= 0 ? rest[iFile + 1] : rest.find((w) => !isFlag(w) && SCRIPT_EXT.test(stripQuotes(w)));
      if (script) return clip(T('step.cmd.run', { name: base(stripQuotes(script)) }));
      const iCmd = rest.findIndex((w) => /^-{1,2}c(?:ommand)?$/i.test(w) || /^\/c$/i.test(w));
      if (iCmd >= 0 && rest[iCmd + 1] && rest[iCmd + 1] !== raw) return summarizeCommand(rest.slice(iCmd + 1).join(' '), t);
      if (/^-{1,2}e(?:val)?$/.test(rest[0] || '') || /^-c$/.test(rest[0] || '')) return T('step.cmd.script', { what: lc.replace(/\d+$/, '') });
      return T('step.cmd.script', { what: lc.replace(/\.exe$/i, '') });
    }
    if (/^\.{0,2}[\\/]/.test(ws[0] || '') || SCRIPT_EXT.test(stripQuotes(ws[0] || ''))) return clip(T('step.cmd.run', { name: base(stripQuotes(ws[0])) }));
    if (['echo', 'write-host', 'write-output', 'printf'].includes(lc)) return T('step.cmd.print');
    if (['sleep', 'start-sleep', 'timeout'].includes(lc)) return T('step.cmd.wait');
    if (['pdftoppm', 'convert', 'magick', 'ffmpeg', 'pandoc', 'libreoffice', 'soffice', 'gs', 'tesseract', 'unzip', 'zip', 'tar', '7z', 'expand-archive', 'compress-archive'].includes(lc)) { const f = lastFileArg(ws); return f ? clip(T('step.cmd.process', { name: f })) : clip(T('step.cmd.run', { name: lc })); }
    if (/^\$/.test(ws[0] || '') || /^\[/.test(ws[0] || '')) return hasPipeTo ? T('step.cmd.script', { what: 'PowerShell' }) : T('step.cmd.script', { what: 'PowerShell' });
    if (/^[\w.-]+$/.test(prog) && prog) return clip(T('step.cmd.run', { name: prog }));
    return T('step.cmd.generic');
  }

  // ---- the label of one step
  function create(t) {
    const L = {};
    L.summarizeCommand = (c) => summarizeCommand(c, t);
    const shellName = (name) => (/^powershell$/i.test(String(name)) ? 'PowerShell' : 'shell');

    // A tool's own `description` (Bash / PowerShell / Task / Agent): the model wrote it for a person. Used as long as it reads as one phrase.
    const descOf = (name, input) => {
      const d = clip(input?.description, MAX);
      if (!d) return '';
      if (SHELL.has(String(name)) || name === 'Task' || name === 'Agent') return d.replace(/[.:]\s*$/, '');
      return '';
    };

    L.label = (name, input = {}) => {
      const n = String(name || '');
      const i = input && typeof input === 'object' ? input : {};
      const d = descOf(n, i);
      if (d) return d;
      if (SHELL.has(n)) return i.command ? clip(summarizeCommand(i.command, t)) : t('step.using', { name: shellName(n) });
      if (n === 'Read') return t('step.read', { name: clip(base(i.file_path || i.path) || t('step.file'), 50) });
      if (n === 'Write') return t('step.write', { name: clip(base(i.file_path || i.path) || t('step.file'), 50) });
      if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return t('step.edit', { name: clip(base(i.file_path || i.notebook_path || i.path) || t('step.file'), 50) });
      if (n === 'Glob' || n === 'Grep') {
        const folder = base(i.path || '') || '';
        const pattern = clip(i.pattern, 30);
        return folder ? clip(t('step.search.in', { pattern, folder })) : clip(t('step.search', { pattern }));
      }
      if (n === 'LS' || n === 'list_files') return t('step.list', { folder: clip(base(i.path) || t('step.folder'), 40) });
      if (n === 'WebFetch') return t('step.fetch', { host: i.url ? hostOf(i.url) : t('step.page') });
      if (n === 'WebSearch') return clip(t('step.webSearch', { query: clip(i.query, 40) }));
      if (n === 'TodoWrite') return t('step.plan');
      if (n === 'Task' || n === 'Agent') return t('step.subagent');
      if (n === 'Skill') return t('step.skill', { name: clip(i.skill || i.command, 40) });
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(n);
      if (mcp && mcp[1] !== 'lumen') return clip(t('step.mcp', { server: mcp[1].replace(/_/g, ' ') })); // (the server, never the tool's own name)
      return '';
    };

    // A tool with no label of its own (another program's tool, a Lumen tool that has no special line): what it is in plain words, with its main argument
    // ("Looking up a tool: calendar", "Using list files: Downloads"); never the generic "Using a tool" while the name is known.
    const KNOWN = { ToolSearch: 'toolSearch', BashOutput: 'bashOutput', KillShell: 'killShell', KillBash: 'killShell', ExitPlanMode: 'exitPlan', EnterPlanMode: 'enterPlan', AskUserQuestion: 'askUser', Monitor: 'monitor', TaskStop: 'taskStop', TaskOutput: 'taskOutput', ScheduleWakeup: 'wakeup', NotebookRead: 'notebookRead', list_files: 'listFiles', clipboard: 'clipboard', document: 'document', verify_changes: 'verify', generate_image: 'image', memory: 'memory', notes: 'notes', use_skill: 'skill', run_macro: 'macro', reading_list: 'readingList', connector: 'connector', desktop: 'desktop', read_pdf: 'readPdf', list_tabs: 'listTabs' };
    const ARGS = ['query', 'description', 'url', 'path', 'file_path', 'pattern', 'name', 'command', 'text', 'title', 'prompt', 'action', 'folder'];
    const humanize = (n) => String(n).replace(/^mcp__[^_]+(?:_[^_]+)*__/, '').replace(/([a-zd])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
    L.generic = (name, input = {}) => {
      const n = String(name || '').replace(/^mcp__lumen__/, '');
      const i = input && typeof input === 'object' ? input : {};
      let arg = '';
      for (const k of ARGS) { const v = i[k]; if (typeof v === 'string' && v.trim()) { arg = /^(?:file_path|path|folder)$/.test(k) ? base(v) : /^url$/.test(k) ? hostOf(v) : clip(v, 40); break; } }
      const text = KNOWN[n] ? t(`step.tool.${KNOWN[n]}`) : humanize(n) ? t('step.using', { name: humanize(n) }) : t('step.tool');
      return clip(arg && KNOWN[n] !== 'listTabs' ? t('step.withArg', { label: text, arg }) : text);
    };

    // What the engine's saved/shown label should be: the line above, else the engine's own `fallback`.
    L.labelOr = (name, input, fallback) => L.label(name, input) || fallback || String(name || '');

    // Consecutive steps with the same key are one row. { key, noun } or null (never grouped).
    L.groupInfo = (name, input, label) => {
      const n = String(name || '');
      const i = input && typeof input === 'object' ? input : {};
      if (n === 'Read') {
        const f = String(i.file_path || i.path || '');
        const ext = /\.([a-z0-9]+)$/i.exec(f)?.[1]?.toLowerCase() || '';
        return { key: `Read|${dirOf(f)}`, kind: 'read', pages: /^(?:png|jpe?g|gif|webp|bmp|tiff?|pdf)$/.test(ext) };
      }
      // Searches in a burst are one row: "Searching the web · 2 searches" (the queries are its members), whatever each one asked.
      const bare = n.replace(/^mcp__lumen__/, '');
      if (bare === 'web_search' || bare === 'WebSearch') return { key: 'search|web', kind: 'search', what: 'web' };
      if (bare === 'find_sources') return { key: 'search|sources', kind: 'search', what: 'sources' };
      if (bare === 'read_urls') return { key: 'search|urls', kind: 'search', what: 'urls' };
      if (SHELL.has(n) && !i.description && /^(?:Using |Running a command$)/.test(label || '')) return { key: `shell|${n}`, kind: 'shell', tool: shellName(n) };
      if (!label) return null;
      return { key: `${n}|${label}`, kind: 'same' };
    };
    // `running`: some member is still going ("Searching…") or all are done ("Searched…").
    L.groupLabel = (info, count, label, running = false) => {
      if (!info) return label;
      if (info.kind === 'search') return t(`step.group.${info.what}.${running ? 'running' : 'done'}.${count === 1 ? 'one' : 'other'}`, { n: count });
      if (info.kind === 'read') return t(info.pages ? 'step.group.pages' : 'step.group.files', { count });
      if (info.kind === 'shell') return t('step.group.tool', { tool: info.tool, count });
      return t('step.group.same', { label, count });
    };

    // A failed step. { text: "Couldn't read p2.png", why: "the file was empty" }
    // Each verb has its own whole sentence in en.json (step.failed.<verb>): no sentence is built from pieces, so a language can order it its own way.
    const VERBS = [[/^Reading /, 'read'], [/^Writing /, 'write'], [/^Editing /, 'edit'], [/^Running /, 'run'], [/^Searching /, 'search'], [/^Opening /, 'open'], [/^Installing /, 'install'], [/^Listing /, 'list'], [/^Creating /, 'create'], [/^Deleting /, 'delete'], [/^Copying /, 'copy'], [/^Moving /, 'move'], [/^Downloading /, 'download'], [/^Checking /, 'check'], [/^Using /, 'use'], [/^Building /, 'build'], [/^Processing /, 'process'], [/^Comparing /, 'compare'], [/^Committing /, 'commit'], [/^Pushing /, 'push'], [/^Pulling /, 'pull']];
    const cleanPaths = (s) => String(s || '').replace(/(?:[A-Za-z]:)?(?:[\\/][^\\/\s:"'<>|]+){2,}[\\/]?([^\\/\s:"'<>|]*)/g, (m, last) => last || base(m));
    L.reason = (error) => {
      const raw = String(error || '').replace(/\s+/g, ' ').trim();
      if (!raw) return '';
      if (/\bempty\b/i.test(raw)) return t('step.why.empty');
      if (/ENOENT|no such file|not found|cannot find|does not exist|could not find|is not recognized/i.test(raw)) return t('step.why.missing');
      if (/EACCES|EPERM|permission denied|access is denied|not permitted/i.test(raw)) return t('step.why.denied');
      if (/timed? ?out|ETIMEDOUT/i.test(raw)) return t('step.why.timeout');
      if (/too large|exceeds|too big|maximum/i.test(raw)) return t('step.why.large');
      if (/user (?:doesn't|does not) want|rejected|declined|denied by/i.test(raw)) return t('step.why.declined');
      const code = /exit(?:ed)?(?: with)?(?: code| status)?[: ]+(-?\d+)/i.exec(raw) || /code (-?\d+)/i.exec(raw);
      if (code) return t('step.why.exit', { code: code[1] });
      const first = cleanPaths(String(error).split('\n').map((l) => l.trim()).find(Boolean) || raw).replace(/^(?:error|exception|fatal)[:\s]+/i, '');
      return clip(first.charAt(0).toLowerCase() + first.slice(1), 60);
    };
    L.failure = (name, input, error, label) => {
      const l = label || L.label(name, input) || String(name || '');
      let text = '';
      for (const [re, verb] of VERBS) if (re.test(l)) { text = t(`step.failed.${verb}`, { what: l.replace(re, '').replace(/^\s+/, '') }); break; }
      if (!text) text = t('step.failed.generic', { label: l });
      return { text: clip(text.replace(/\s+$/, ''), 80), why: L.reason(error) };
    };

    // The user's request in about four words: "Can you please find the lab TA on Canvas?" -> "Find lab TA".
    L.taskName = (text) => {
      let s = skillText(text || '', null, 'task').replace(/https?:\/\/\S+/g, '').replace(/[\r\n]+/g, ' ').trim();
      s = s.replace(/^(?:hey|hi|hello|ok|okay|so|and|then|now)[,\s]+/i, '').replace(/^(?:please[,\s]+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?/i, '').replace(/^(?:i\s+(?:want|need|would like)\s+you\s+to|i'd like you to|i want to|i need to|let's|lets|go ahead and|please)\s+/i, '');
      const stop = new Set(['a', 'an', 'the', 'my', 'me', 'some', 'this', 'that', 'these', 'those', 'all']);
      let ws = s.replace(/[?!.,;:]+$/g, '').split(/\s+/).filter((w) => w && !stop.has(w.toLowerCase()));
      ws = ws.slice(0, 4);
      while (ws.length > 1 && /^(?:on|in|at|for|to|of|and|or|from|with|by|about|into)$/i.test(ws[ws.length - 1])) ws.pop();
      const out = ws.join(' ');
      return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
    };
    L.t = t;
    return L;
  }

  // Secrets in a command or output (tokens, keys, passwords in arguments, headers, urls or env assignments) become "••••" before the text is shown or saved.
  const MASK = '••••';
  const SECRET_NAME = '[\\w.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth(?:orization)?|bearer|cookie|session[_-]?id)[\\w.-]*';
  const SECRET_RES = [
    [new RegExp(`(-{1,2}${SECRET_NAME}[= ]+)("[^"]*"|'[^']*'|\\S+)`, 'gi'), `$1${MASK}`], // -Password hunter2, --token=abc
    [new RegExp(`(\\b${SECRET_NAME}\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s;&|,]+)`, 'gi'), `$1${MASK}`], // API_KEY=abc, password: abc
    [new RegExp(`(\\$env:${SECRET_NAME}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s;&|]+)`, 'gi'), `$1${MASK}`],
    [/((?:Authorization|Proxy-Authorization|X-Api-Key|Cookie)\s*:\s*)(?:Bearer\s+|Basic\s+|Token\s+)?[^\s"']+(?:\s+[^\s"']+)?/gi, `$1${MASK}`],
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`],
    [/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, `$1${MASK}@`], // https://user:pass@host
    [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, MASK],
  ];
  function redact(text) {
    let out = String(text ?? '');
    for (const [re, to] of SECRET_RES) out = out.replace(re, to);
    return out;
  }

  // What is kept of a step's input with the saved chat: only the parts that name it, each bounded, secrets masked. (Not the text typed into a page: it may be a password.)
  const KEEP = ['description', 'command', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'key', 'direction', 'name', 'tab_id', 'action'];
  function compactInput(name, input) {
    if (!input || typeof input !== 'object') return null;
    const out = {};
    for (const k of KEEP) {
      const v = input[k];
      if (typeof v === 'string' && v) { const r = redact(v); out[k] = r.length > (k === 'command' ? 600 : 240) ? `${r.slice(0, k === 'command' ? 599 : 239)}…` : r; }
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    for (const k of ['ids', 'tab_ids']) if (Array.isArray(input[k])) { const list = input[k].filter((n) => Number.isInteger(n) && n >= 0 && n < 1e9).slice(0, 8); if (list.length) out[k] = list; } // (tabs a step names: shown as chips)
    return Object.keys(out).length ? out : null;
  }

  // The line for read_urls: each site once ("Reading 2 pages on youtube.com in the background"), never the same host twice.
  const readUrlsLabel = (urls, signedIn = false) => {
    const list = (Array.isArray(urls) ? urls : []).map((u) => hostOf(String(u || ''))).filter(Boolean);
    const hosts = [...new Set(list)];
    const tail = signedIn ? ' (signed in, if you allow it)' : '';
    if (!hosts.length) return `Reading pages in the background${tail}`;
    if (hosts.length === 1) return `Reading ${list.length > 1 ? `${list.length} pages on ` : ''}${hosts[0]} in the background${tail}`;
    const shown = hosts.length > 3 ? `${hosts.slice(0, 2).join(', ')} and ${hosts.length - 2} more sites` : hosts.join(', ');
    return `Reading ${shown} in the background${tail}`;
  };
  // Surface of a step that has none of its own (the card it starts): a web search or page read is "web" (the Browser look, no preview), any other tool "tool".
  const WEBISH = /^(?:(?:mcp__lumen__)?(?:web_search|read_urls|find_sources|read_pdf|video_overview|video_frames)|WebSearch|WebFetch)$/;
  const weakSurfaceOf = (name) => (WEBISH.test(String(name || '')) ? 'web' : 'tool');

  const api = { skillText, hasSkill, create, summarizeCommand, surfaceOf, weakSurfaceOf, readUrlsLabel, compactInput, redact, clip, base, dirOf, hostOf, SHELL, FILES, BROWSER, bare };
  if (typeof module === 'object' && module.exports) {
    // Node: the English strings (main's labels for the saved chat; the units).
    const table = require('../locales/en.json');
    const fmt = (text, vars) => (vars ? String(text).replace(/\{(\w+)\}/g, (w, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : w)) : String(text));
    api.en = (key, vars) => fmt(Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key, vars);
    api.defaults = create(api.en);
    module.exports = api;
  } else {
    root.stepLabels = api;
    if (typeof root.t === 'function') api.defaults = create((k, v) => root.t(k, v));
  }
})(this);
