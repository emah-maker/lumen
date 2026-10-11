# Lumen: notes for Claude Code

Lumen is a Chromium (Electron) browser with an AI sidebar. Plain CommonJS, no build step for the main code. The user guide is `README.md`, contributor rules are in `CONTRIBUTING.md`, and the code map is `docs/architecture.md`.

## Run and test

- `npm start` runs from source. `npm run test:units` runs the pure-Node suites; `node test/<name>.js` runs one suite; `npm test` runs the core set.
- Run Electron suites with `LUMEN_TEST_BACKGROUND=1` so test windows stay invisible and never take focus from a Lumen that is in use.
- `npm run lint` (ESLint) must pass with no errors.
- Main moves fast: `git fetch` and branch from a fresh `origin/main`. One topic per branch and PR.

## Docs: every change brings its documentation

A change isn't done until the docs say what it does. Before you finish a change that touches `src/`:

1. **CHANGELOG.md**: add a bullet under `## Unreleased`. Start with a bold sentence about what the user gets, then the details, the setting names and any new test files. Write for users, not for reviewers.
2. **New or changed setting**: add or update its row in `docs/settings.md` (Setting | Key | Default | What it does). The UI text goes in `src/locales/en.json`. A setting that ships off and that users would be sorry to miss gets an entry in `src/features/feature-offers.js` (asked once after an update).
3. **Something a user can see or do**: describe it in the README section for that area. If it needs more than a paragraph, write `docs/<topic>.md` and link it from the README's **Documentation** list.
4. **New `docs/*.md` page**: list it in `PAGES` in `site/docs.js` and add a card under Documentation in `site/index.html` (the GitHub Pages site renders the repo's Markdown, so nothing else needs copying). Notable features can also get a card in the site's feature grid.
5. **Data that leaves the computer, or privacy behavior**: update `PRIVACY.md`.
6. **Tests**: add or update one with every change (`test/<area>-units.js` for logic; a real-window suite registered in `scripts/test-all.js` for behavior).

`node scripts/check-docs.js` checks points 1, 2 and 4 against `origin/main`, and reminds about 3. It also runs as a Claude Code Stop hook (`.claude/settings.json`): if a turn ends with `src/` changes the docs don't cover, you are sent back once with the list. Either fix the docs or say why a point doesn't apply (an internal refactor needs no README text). `test/docs-units.js` fails CI when a new setting has no row in `docs/settings.md`.

## Writing style

The project writes plainly: short sentences, the user's words ("Settings → Privacy and security", not internal names), no hype. Match the surrounding text.
