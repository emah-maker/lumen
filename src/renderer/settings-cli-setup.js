// Settings → AI → Set up a coding agent: one card per command-line agent Lumen can use (Claude Code, Codex, Grok Build, Antigravity),
// each with its official install and sign-in docs, the install command for this computer (with Copy), and a short terminal-style
// animation of install → sign in → ready (HTML/CSS only; still with Reduce motion or prefers-reduced-motion).
// The data and the animation script are plain functions (window.lumenCliSetup, and module.exports for test/units/cli-setup-units.js).
// buildCliSetup(slot) is mounted by settings.js (BUILDS: 'ai-setup') and uses that file's h(), tr(), stackRow(), status() and flash().
// The install commands are the vendors' own and match the hints in ai/claude-code.js, ai/codex-locate.js, ai/grok-build.js and
// ai/antigravity.js (the unit test checks). Docs URLs checked 2026-11-16.
(function (root) {
  const PLATFORMS = ['win32', 'darwin', 'linux'];
  const GUIDES = [
    {
      id: 'claudecode', name: 'Claude Code', maker: 'Anthropic', bin: 'claude', setupId: 'setup-claude-code',
      needs: 'A Claude Pro, Max, Team or Enterprise plan, or an Anthropic Console account.',
      install: { win32: 'irm https://claude.ai/install.ps1 | iex', darwin: 'curl -fsSL https://claude.ai/install.sh | bash', linux: 'curl -fsSL https://claude.ai/install.sh | bash' },
      alt: 'npm install -g @anthropic-ai/claude-code',
      signIn: 'claude',
      signInHow: 'Run claude. A browser opens: sign in, then come back to the terminal. (Inside Claude Code, /login signs in again.)',
      docs: { install: 'https://code.claude.com/docs/en/setup', signIn: 'https://code.claude.com/docs/en/authentication' },
    },
    {
      id: 'codex', name: 'Codex', maker: 'OpenAI', bin: 'codex', setupId: 'setup-codex',
      needs: 'A ChatGPT plan, or an OpenAI API key.',
      install: { win32: 'npm install -g @openai/codex', darwin: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', linux: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
      alt: 'npm install -g @openai/codex',
      signIn: 'codex login',
      signInHow: 'Run codex login. A browser opens: choose Sign in with ChatGPT.',
      docs: { install: 'https://learn.chatgpt.com/docs/codex/cli', signIn: 'https://learn.chatgpt.com/docs/auth' },
    },
    {
      id: 'grokbuild', name: 'Grok Build', maker: 'xAI', bin: 'grok', setupId: 'setup-grok',
      needs: 'A SuperGrok or X Premium+ subscription.',
      install: { win32: 'irm https://x.ai/cli/install.ps1 | iex', darwin: 'curl -fsSL https://x.ai/cli/install.sh | bash', linux: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
      alt: '',
      signIn: 'grok',
      signInHow: 'Run grok. The first time, a browser opens: sign in with your xAI account.',
      docs: { install: 'https://docs.x.ai/build/overview', signIn: 'https://docs.x.ai/build/overview' },
    },
    {
      id: 'antigravity', name: 'Antigravity', maker: 'Google', bin: 'agy', setupId: 'setup-antigravity',
      needs: 'A Google account (it replaces Gemini CLI).',
      install: { win32: 'irm https://antigravity.google/cli/install.ps1 | iex', darwin: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', linux: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
      alt: '',
      signIn: 'agy',
      signInHow: 'Run agy. A browser opens: choose Google OAuth and sign in with your Google account.',
      docs: { install: 'https://antigravity.google/docs/getting-started?tab=cli', signIn: 'https://antigravity.google/docs/install?tab=cli' },
    },
  ];

  // navigator.platform ('Win32', 'MacIntel', 'Linux x86_64') or a Node platform -> 'win32' | 'darwin' | 'linux'.
  function platformOf(p) {
    const s = String(p || '').toLowerCase();
    if (s.startsWith('win')) return 'win32';
    if (s.startsWith('mac') || s === 'darwin') return 'darwin';
    return 'linux';
  }
  // Where the command is typed, and the prompt the animation draws.
  const shellOf = (platform) => (platform === 'win32' ? { name: 'PowerShell', prompt: 'PS>' } : { name: 'Terminal', prompt: '$' });
  const guideOf = (id) => GUIDES.find((g) => g.id === id) || null;
  const commandFor = (guide, platform) => (guide && guide.install[platformOf(platform)]) || '';

  // The animation as timed lines: { kind: 'cmd' | 'out' | 'ok' | 'note', key, text, vars, start, dur, n }. `start` and `dur` are ms;
  // a 'cmd' line types its text over `dur` in `n` steps. reduced: everything shown at once (start 0, dur 0).
  const TYPE_MS = 28; // per character
  const TYPE_MAX = 1600; // a long command still types in under 2 s
  function demoScript(guide, platform, { reduced = false } = {}) {
    if (!guide) return [];
    const plat = platformOf(platform);
    const lines = [
      { kind: 'cmd', text: commandFor(guide, plat) },
      { kind: 'out', key: 'settings.cliSetup.demo.installing', text: 'Installing {name}…' },
      { kind: 'ok', key: 'settings.cliSetup.demo.installed', text: '✓ {name} is installed' },
      { kind: 'cmd', text: guide.signIn },
      { kind: 'out', key: 'settings.cliSetup.demo.browser', text: 'Opening your browser to sign in…' },
      { kind: 'ok', key: 'settings.cliSetup.demo.signedIn', text: '✓ Signed in' },
      { kind: 'note', key: 'settings.cliSetup.demo.ready', text: 'Back in Lumen: pick {name} in the model menu.' },
    ];
    let at = 0;
    return lines.map((l) => {
      const n = l.kind === 'cmd' ? l.text.length : 0;
      const dur = reduced ? 0 : l.kind === 'cmd' ? Math.min(TYPE_MAX, n * TYPE_MS) : 0;
      const line = { ...l, vars: { name: guide.name }, start: reduced ? 0 : at, dur, n };
      if (!reduced) at += dur + (l.kind === 'cmd' ? 450 : l.kind === 'out' ? 900 : 600);
      return line;
    });
  }
  // How long one run of the animation takes (ms): the last line's start plus its typing.
  const demoLength = (script) => script.reduce((m, l) => Math.max(m, l.start + l.dur), 0);

  const api = { PLATFORMS, GUIDES, platformOf, shellOf, guideOf, commandFor, demoScript, demoLength };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.lumenCliSetup = api;
})(typeof window !== 'undefined' ? window : globalThis);

async function buildCliSetup(slot) {
  const C = window.lumenCliSetup;
  const platform = C.platformOf(navigator.platform);
  const shell = C.shellOf(platform);
  const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (w, k) => (k in vars ? String(vars[k]) : w));
  const reduced = () => document.documentElement.classList.contains('reduce-motion') || Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const STATUS = {
    claudecode: () => S.ai.claudeCodeStatus(),
    codex: () => S.ai.codexStatus(false),
    antigravity: () => S.ai.antigravityStatus(false),
  };

  const copyButton = (text, label) => {
    const b = h('button', { type: 'button', text: tr('settings.cliSetup.copy', 'Copy'), 'aria-label': label });
    b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(text).catch(() => {});
      b.textContent = tr('settings.cliSetup.copied', 'Copied');
      setTimeout(() => { b.textContent = tr('settings.cliSetup.copy', 'Copy'); }, 1400);
    });
    return b;
  };
  const command = (text, label) => h('div', { class: 'cli-cmd' }, h('pre', { class: 'mono code', text }), copyButton(text, label));

  // The terminal: drawn when it first scrolls into view (an animation that ran while the page was hidden would show only its end).
  const terminal = (g) => {
    const box = h('div', { class: 'cli-term', role: 'group', 'aria-label': tr('settings.cliSetup.demoLabel', 'Example: installing and signing in to {name}', { name: g.name }) });
    const play = () => {
      const script = C.demoScript(g, platform, { reduced: reduced() });
      box.replaceChildren(...script.map((l) => {
        const el = h('div', { class: `cli-line ${l.kind}` });
        el.style.setProperty('--start', `${l.start}ms`);
        if (l.kind === 'cmd') {
          const typed = h('span', { class: 'cli-typed', text: l.text });
          typed.style.setProperty('--n', String(l.n));
          typed.style.setProperty('--dur', `${l.dur}ms`);
          typed.style.setProperty('--start', `${l.start}ms`);
          el.append(h('span', { class: 'cli-prompt', 'aria-hidden': 'true', text: `${shell.prompt} ` }), typed);
        } else el.textContent = l.key ? tr(l.key, fill(l.text, l.vars), l.vars) : l.text;
        return el;
      }));
      box.classList.toggle('still', reduced());
    };
    if (typeof IntersectionObserver === 'function') {
      const seen = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { seen.disconnect(); play(); } });
      seen.observe(box);
    } else play();
    const replay = h('button', { type: 'button', class: 'plain cli-replay', text: tr('settings.cliSetup.replay', 'Replay'), 'aria-label': tr('settings.cliSetup.replayLabel', 'Replay the {name} example', { name: g.name }), onclick: play });
    return h('div', { class: 'cli-demo' }, box, replay);
  };

  const card = (g) => {
    const state = status(`cli-setup-${g.id}-status`);
    const cmd = C.commandFor(g, platform);
    const others = C.PLATFORMS.filter((p) => p !== platform && g.install[p] !== cmd);
    const OS = { win32: 'Windows (PowerShell)', darwin: 'macOS (Terminal)', linux: 'Linux (Terminal)' };
    const links = h('div', { class: 'controls' },
      h('button', { type: 'button', id: `cli-setup-${g.id}-docs`, text: tr('settings.cliSetup.installDocs', 'Install guide'), 'aria-label': tr('settings.cliSetup.installDocsLabel', '{name} install guide (opens {maker}’s docs)', { name: g.name, maker: g.maker }), onclick: () => S.openUrl(g.docs.install) }),
      g.docs.signIn !== g.docs.install ? h('button', { type: 'button', id: `cli-setup-${g.id}-signin-docs`, text: tr('settings.cliSetup.signInDocs', 'Sign-in help'), 'aria-label': tr('settings.cliSetup.signInDocsLabel', '{name} sign-in help (opens {maker}’s docs)', { name: g.name, maker: g.maker }), onclick: () => S.openUrl(g.docs.signIn) }) : null);
    const el = stackRow(g.name, tr(`settings.cliSetup.${g.id}.needs`, g.needs),
      state,
      h('p', { class: 'cli-step', text: tr('settings.cliSetup.step1', '1. Install: paste this into {shell}.', { shell: shell.name }) }),
      command(cmd, tr('settings.cliSetup.copyLabel', 'Copy the {name} install command', { name: g.name })),
      g.alt && g.alt !== cmd ? h('p', { class: 'note', text: tr('settings.cliSetup.alt', 'Or, with Node.js: {cmd}', { cmd: g.alt }) }) : null,
      h('p', { class: 'cli-step', text: tr('settings.cliSetup.step2', '2. Sign in: {how}', { how: tr(`settings.cliSetup.${g.id}.signIn`, g.signInHow) }) }),
      command(g.signIn, tr('settings.cliSetup.copySignInLabel', 'Copy the {name} sign-in command', { name: g.name })),
      h('p', { class: 'cli-step', text: tr('settings.cliSetup.step3', '3. Back here, choose {name} in the model menu. It shows up once it’s installed.', { name: g.name }) }),
      terminal(g),
      others.length ? h('details', { class: 'cli-other' }, h('summary', { text: tr('settings.cliSetup.otherSystems', 'On another computer') }),
        ...others.map((p) => h('div', {}, h('p', { class: 'note', text: OS[p] }), command(g.install[p], `${tr('settings.cliSetup.copyLabel', 'Copy the {name} install command', { name: g.name })} (${OS[p]})`)))) : null,
      links);
    el.dataset.cli = g.id;
    withKeywords(el, `${g.bin} ${g.maker} install setup sign in login terminal command docs`);
    const look = STATUS[g.id];
    if (look) {
      later(look).then((s) => {
        if (!s) return;
        state.textContent = !s.installed ? tr('settings.cliSetup.notInstalled', 'Not installed on this computer yet.') : s.signedIn === false ? tr('settings.cliSetup.signedOut', 'Installed, not signed in yet: do step 2.') : tr('settings.cliSetup.ready', 'Installed and ready.');
        state.className = `note${s.installed && s.signedIn !== false ? ' ok' : ''}`;
      }).catch(() => {});
    }
    return el;
  };

  slot.group(tr('settings.cliSetup.group', 'Coding agents on this computer'));
  slot.append(...C.GUIDES.map(card));
  slot.foot(tr('settings.cliSetup.foot', 'Each agent signs in with your own account; Lumen never sees the login. The commands are the makers’ own.'));
}
