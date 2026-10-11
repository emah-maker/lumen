# Contributing to Lumen

Thanks for helping. Lumen is a small project, so the process is light.

## Before you start

- For a bug, open an issue with the steps to reproduce it, what you expected and what happened. Include your OS and the Lumen version (**Settings → About Lumen**).
- For a feature or a larger change, open an issue first so we can agree on the approach before you write code.
- **Security problems:** don't open a public issue. Use GitHub's private vulnerability reporting (**Security → Report a vulnerability**) on this repository.

## Setting up

```
npm install
npm start             # run from source
```

See **Build from source** in the README for packaging and installing locally.

## Tests

The suites are Playwright scripts that launch Lumen. Run them one at a time with `node test/<name>.js`; `npm test` runs the core set one after another, keeps going past a failure and prints a pass/fail summary. `npm run test:units` runs just the pure-node suites (`test/units.js`, `test/*-units.js`, `test/cli-json.js`; no Electron needed), which is what CI runs on every pull request.

- Tests use a throwaway profile: set `CLAUDE_BROWSER_TEST=1` and `CLAUDE_BROWSER_PROFILE=<empty temp folder>` (see `test/home.js`). Test mode only works when running from source, never in a packaged build.
- Close other Lumen or Electron windows first. Some suites (`ui`, `tabstrip`, `downloads`) depend on window focus.
- Add or update a test with every change. `test/units.js` or a new `test/<area>-units.js` is the place for logic that doesn't need a window: `scripts/test-units.js` picks the file up by name, so nothing needs registering.

## Translations

Lumen's own text (toolbar, sidebar, menus, dialogs, Settings) lives in `src/locales/en.json`. Lumen follows the system language and falls back to English for any key a locale doesn't have.

To add a language:

1. Copy `src/locales/en.json` to `locales/<code>.json`, using a code Chromium reports, such as `de`, `fr` or `pt-BR`. `pt-BR` falls back to `pt.json`, then English.
2. Translate the values. Keep the keys, and keep `{placeholders}` as they are.
3. Leave out keys you haven't translated, rather than copying the English.
4. Check it: run `node test/a11y.js`, then start Lumen with `LUMEN_LOCALE=<code>` and `CLAUDE_BROWSER_TEST=1` to see it without changing your system language.

New UI text goes into `src/locales/en.json`: use `t('key')` in `src/main.js` and `src/renderer/*.js`, or `data-i18n` / `data-i18n-title` / `data-i18n-aria-label` / `data-i18n-placeholder` in HTML.

## Pull requests

- One topic per pull request, branched from `main`.
- Keep commits focused, with messages that say what changed and why.
- Describe what you tested in the pull request.
- Bring the docs along: a CHANGELOG bullet, the README or a `docs/` page for anything users see, and a `docs/settings.md` row for a new setting. `node scripts/check-docs.js` checks the branch; the full list is in `CLAUDE.md` under "Docs".
- Match the style of the surrounding code: plain CommonJS, no build step, comments only where the reason isn't obvious.

## License

Lumen is licensed under GPL-3.0-or-later. By contributing, you agree that your contributions are licensed under the same terms.
