# UX audit: first run, new-tab page, widgets

Scope: the new-tab page (`src/renderer/newtab*.js`, `newtab.html`), its cards, the Edit layout / Add widget flow, and the setup forms. Walked as a new user (fresh profile) and a returning user (12 seeded cards) in off-screen windows at 1280x860 and 800 wide, light and dark. Screenshots are in `docs/ux-audit/shots/` (`before-*` and `after-*`; `seeded` = several cards, `fresh` = new profile, `scrollN` = the seeded page scrolled N px).

Overall: the page is in good shape. Focus rings, reduce-motion, skeleton loading, per-card labels and keyboard moving/resizing are all there, and light and dark match. The problems are in what cards say when they cannot show anything.

## Findings, by user impact

Status: FIXED here (round 1, or round 2 for the items that were left for later).

1. **A card with no key or token says "Couldn't update" and offers "Try again". FIXED.**
   Where: Todoist, GitHub, Stocks (and any card whose error starts "Add your ... in Settings"). Shots: `before-seeded-scroll700.png`.
   Why it confuses: nothing is broken, a key is missing, and Try again can never help. The message says "in Settings" but there is no way to get there from the card (no button, and the pencil is hidden because these cards have no inline editor).
   Fix: heading "Needs setup", the same message, and one primary Open Settings button (the same `configure` action Gmail's card already uses). A real failure keeps Try again, and an expired token (error mentions Settings) gets Open Settings beside it. Shot: `after-seeded-scroll700.png`.

2. **"Updated just now" under a sign-in prompt. FIXED.**
   Where: Gmail signed out, Spotify / Apple Music signed out. Shots: `before-seeded-scroll700.png`, `before-seeded-scroll1400.png`.
   Why: the line reports a time for nothing the user can see, so it reads as noise (or as if the sign-in had been tried).
   Fix: the footer leaves it out while a sign-in button is showing. Shot: `after-seeded-scroll700.png`.

3. **Try again gives no feedback. FIXED.**
   Where: every failed card. When the retry fails the same way the card looks identical, so a click seems to do nothing.
   Fix: the button shows "Trying..." disabled (with a disabled style) for up to 4 seconds, then returns.

4. **The Edit layout tip is four sentences and sits on top of the Add widget list and the Privacy card. FIXED.**
   Where: Edit layout, bottom right. Shots: `before-fresh-picker-1280-light.png`, `before-fresh-editing-1280-light.png`.
   Why: the tip was cut off behind the list and covered content. Resizing the clock and search bar is already shown by their handles, so the tip need not explain it.
   Fix: one line ("Drag a card to move it, or focus it and use the arrow keys. Shift and arrows resize. Ctrl+Z undoes."); it hides while the list is open. Shot: `after-fresh-picker-1280-light.png`.

5. **The tip's dismiss x is about 15 px wide. FIXED.** Now at least 24x24.

6. **Gmail's button is announced "Sign in to Gmail for Gmail". FIXED (round 2).** The label is now "Sign in to Gmail", with the card's own title in brackets only when it differs from "Gmail" (so two Gmail cards stay apart). Pinned in `test/gmail-ui.js` and `test/newtab-states-ui.js`.

7. **"Couldn't update" followed by "Couldn't connect. Check your internet connection." repeats itself. FIXED (round 2).** Presentation only (`request()` and `freshFetch` are untouched): a message that already starts "Couldn't" or "Can't" is shown as the card's heading on its own; other failures keep "Couldn't update" above the message.

8. **Add widget is only visible in Edit layout once a page has cards. FIXED (round 2).** The Add widget button now sits in the bottom-right dock all the time, beside Edit layout. It opens the same list; nothing else about Edit layout changed.

9. **Todoist (and other kinds with no inline form) open Settings from the Add list with no visible message. FIXED (round 2).** Choosing one now shows a note on the page ("Opening Settings to set up Todoist. Paste your personal API token. Find it in Todoist under Settings, Integrations, Developer.") for 12 seconds, and Settings opens on that widget's new-widget form with the same sentence at the top. The words live in one place (`SETUP_NOTES` in `widget-summary.js`) for Todoist, GitHub, Stocks, Muse, Gmail, Slack, Spotify and Crypto.

10. **Add widget list has no search and mixes order. FIXED (round 2).** The list is grouped (Time and weather, Work and mail, Music, News and markets, More, then Show again; the Smart Stack stays first with no heading) and has a filter field, focused when the list opens, once there are more than 8 rows. Every word typed must match a name, line or group; empty groups hide; Arrow Down moves from the field into the list.

11. **Nothing says where Favorites come from. FIXED (round 2).** The Favorites heading has a tooltip, the empty state reads "Favorites are your bookmarks. Press Ctrl+D on any page to add it here." (Cmd on a Mac), and a short list (under 4) shows the same line beneath it.

12. **The greeting says "Good evening" from midnight to 5 am. FIXED (round 2).** Midnight to 5 am now says "Good night"; evening is 6 pm onward.

13. **Ask AI mode says "Ask Claude..." even before any AI is connected. FIXED (round 2).** With nothing connected the box reads "Connect an AI to ask questions", the hint says "No AI is connected yet." and a "Connect an AI" button (also Enter) opens Settings, API keys and sign-ins. When one is connected it uses that assistant's name (the hard-coded "Claude" fallback is now "AI").

14. **Small targets. FIXED (round 2).** Card icon buttons, the move grip, the gear, remove and stack buttons and the corner resize handle are 24 px (were 22 and 18); the card header grew 2 px and the grip's margins were adjusted so the title does not move.

## Checked and fine

- Focus rings on every control I enumerated (cards, buttons, tiles, mode switch, pickers); no control without an accessible name.
- Reduce motion: page arrival, skeleton shimmer, stacks, tiles and toolbars all respect it.
- Loading state: card skeleton with `role=status`. Dark theme: same structure and contrast as light.
- At 800 px the cards stack into one column in reading order (`before-seeded-800-light.png`).
- The setup form (`before-setup-Weather-1280-light.png`): labelled fields, example placeholder, clear primary button, inline errors that keep the form open.

## Tests

Round 2 added checks to `test/newtab-states-ui.js` (Gmail label, one clear error line, greeting hours, Favorites hint, Ask AI setup prompt, Add widget outside Edit layout with groups, filter and the Todoist note, 24 px targets), `test/widget-edit-units.js` (grouping, filter, setup notes) and updated `test/home.js`, `test/widgets.js` and `test/gmail-ui.js`.

`test/newtab-states-ui.js` (added to `scripts/test-all.js`): needs-setup heading and single Open Settings button for Todoist and GitHub, no "Updated" under Gmail's sign-in, Try again shows "Trying...", the edit tip is short, steps aside for the list and returns, and the x is 24 px.
