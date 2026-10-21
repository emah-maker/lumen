# Polish pass: AI surfaces around the chat

Walked hidden on a fresh profile with faked Claude failures (overloaded 529, network ENOTFOUND, 401, 400) and the model picker in dark. Shots (gitignored) `docs/ux-audit/shots/pai-*`.

## Found
1. Provider (OpenAI, Grok, Gemini, OpenRouter) connection errors showed a system code: "Could not reach OpenAI (ENOTFOUND)".
2. Provider errors without a special case read "OpenAI error 400: 400 <raw message>", sometimes with a JSON body.
3. The Auto row in the model menu was 3 lines and cut to 2 with an ellipsis.
4. Model button tooltip read "Auto · auto" (raw id repeated).
5. Claude API 400s show the raw JSON body ("The Claude API returned an error (400): {...}").

## Fixed
1 to 4: `src/ai/providers.js` (describeProviderError), `src/locales/en.json` (models.auto.detail), `src/renderer/picker.js`. Tests in `test/units/chat-images-units.js`.

Checked and fine: overloaded, offline, rejected key and expired sign-in messages (each says what to do, with a Set up AI / Settings action or Try again); chat notifications and task notifications use the humanized error and their click opens the chat or the Tasks panel (sidebar opened); picker and header in dark at 400 px; the "AI is using this tab" pill.

## Left
- Claude API 400 raw JSON: `src/ai/agent.js` describeError (about line 5430, the final `APIError` branch). Off limits; should use the body's `error.message` as providers.js now does.
- With no key but a Claude sign-in present on the machine, Auto runs on that sign-in (expected); the true "no key at all" card was not reachable on this machine.
- A per-step Stop remains not feasible (see sidebar.md).
