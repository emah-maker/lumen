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

The suites are Playwright scripts that launch Lumen. Run them one at a time with `node test/<name>.js`; `npm test` runs the core set and stops at the first failure.

- Tests use a throwaway profile: set `CLAUDE_BROWSER_TEST=1` and `CLAUDE_BROWSER_PROFILE=<empty temp folder>` (see `test/home.js`). Test mode only works when running from source, never in a packaged build.
- Close other Lumen or Electron windows first. Some suites (`ui`, `tabstrip`, `downloads`) depend on window focus.
- Add or update a test with every change. `test/units.js` is the place for logic that doesn't need a window.

## Pull requests

- One topic per pull request, branched from `main`.
- Keep commits focused, with messages that say what changed and why.
- Describe what you tested in the pull request.
- Match the style of the surrounding code: plain CommonJS, no build step, comments only where the reason isn't obvious.

## License

Lumen is licensed under GPL-3.0-or-later. By contributing, you agree that your contributions are licensed under the same terms.
