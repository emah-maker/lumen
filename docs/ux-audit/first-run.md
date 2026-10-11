# UX audit: first run (fresh profile, nothing connected)

Walked hidden on a throwaway profile with every AI hidden: no key, and `LUMEN_CLAUDE_BIN`, `LUMEN_CODEX_BIN`, `LUMEN_GROK_BIN`, `LUMEN_AGY_BIN` pointing at files that are not there. Light and dark, 2000 px wide. Shots (gitignored) are in `docs/ux-audit/shots/fr-*` (`fr-light-welcome.png` / `fr-light-welcome2.png` are before / after; `fr-light-set-ai.png` / `fr-dark-set-ai2.png` the Settings page before / after; `fr-light-approval.png`, `fr-light-chips.png` the first chat).

## Found

1. **Settings, AI and agents showed an empty grey pill where the model picker goes.** `.picker-button` is `display: flex`, which beat its `hidden` attribute, so with nothing connected an empty dropdown with a chevron sat beside "No AI connected yet. Add a key or sign in under Accounts and keys below." The way in was a section further down the page.
2. **The toolbar button was a bare sparkle.** Its name ("Set up AI") only showed as a tooltip.
3. **The toolbar said "Set up AI" even when an AI was connected, if Auto was the pick.** Auto across providers (the default once two are connected) mapped to the "nothing connected" identity. Found in the first-chat shots: the sidebar was working while the button still asked for setup.
4. **The setup card put what needs an install first.** On a computer with nothing, a new user saw a greyed Claude Code row ("Not found... run claude once and type /login"), then an Antigravity row that only led to Settings, then OpenRouter and the API key. Codex and Grok Build were hidden when missing but Antigravity was not, so the list looked arbitrary.
5. **Codex could not be hidden in tests.** `LUMEN_CODEX_BIN` pointing at a missing file fell through to PATH and the registry, unlike the other three engines, so a "no AI" run on a machine with Codex was not possible.
6. `docs/settings.md` said Short, focused answers (ADHD mode) is off by default. The code and the README say on.

## Fixed

1. `src/renderer/picker.css` (a hidden picker button stays hidden); `src/renderer/settings.js`, `settings.css`, `en.json`: the Model row says "No AI connected yet." with a **Connect an AI** button that opens API keys and sign-ins.
2. `src/renderer/styles.css`: while nothing is connected the toolbar button shows its label ("Set up AI"); hidden under 760 px wide.
3. `src/renderer/chat-core.js`: Auto has its own neutral identity ("Lumen"), no "Set up AI".
4. `chat-core.js`, `index.src.html`, `styles.css`, `en.json` (bundles rebuilt): with no engine found, OpenRouter and API key come first, then Claude Code; Antigravity gets a row only when installed; one line ("Have Codex, Grok Build or Antigravity? Install it on this computer and it shows up here. See how") covers the rest.
5. `src/ai/codex-locate.js`: a set `LUMEN_CODEX_BIN` is the only Codex there is, like the other engines.
6. `docs/settings.md`.

Tests: `test/first-run.js` (new, in `scripts/test-all.js`), a check in `test/codex-units.js`.

## Checked and fine

- **First new tab** (`fr-light-newtab.png`): clock, greeting, search with the Search / Ask AI switch, eight Favorites, the Privacy card, a one-line tip and Add widget / Edit layout. No widgets by default, so nothing is empty or half loaded. Ask AI with nothing connected already reads "Connect an AI to ask questions" (earlier audit).
- **First chat**: five starter chips under "Ask anything, or give Lumen a task on this page."; the first approval card says what is asked ("Allow AI to interact with 127.0.0.1:56160?"), what it can do and for how long ("on this site until you start a new chat"), with Don't allow, Always allow any site, and a primary Allow site for this chat. Clear.
- **Import**: offered in the welcome (step 2, one button per browser found, a locked browser says to close it), and later in Settings, the Bookmarks page and the menu. Not run against the real Chrome profile here (it would read this machine's own data); the importer has its own suite (`test/import.js`).
- **What's new and feature offers**: a fresh install records the version and the offers as seen and shows neither (`whats-new.js decide`, `feature-offers.js plan`), so the welcome is the only first-run surface. On an update they run one after the other (notes, then at most one "Turn on?" card, currently one offer), not stacked.
- **Defaults**: ad and tracker blocking, fingerprint protection, GPC, tracking-parameter stripping and "ask before acting on a new site" are on; Safe Browsing, saving passwords, third-party cookie blocking and HTTPS-only are off (opt-in, with their cost explained in Settings). Short, focused answers is on by design (README) and described as "(ADHD mode)" in its row.

## Left

- Short, focused answers on by default is a product call, not a bug; it changes every new user's answers and is easy to miss. Worth a second look: a first chat is shorter than ChatGPT or Claude.ai users expect.
- Settings, AI and agents with nothing connected still lists the controls that only matter once connected ("Auto may use", "Use my Claude Code settings", image generation); an empty-state that folds them away would be a larger change.
- A chat on a test key showed "This chat: cost n/a" above the first message; not reproduced with a real key, so left.
- `test/setup.js` is stale (expects three setup options, a model list without Auto) and is not in `test-all`; `test/first-run.js` covers the same ground, so it was left alone.
