# UX audit: first run, new-tab page, widgets

Scope: the new-tab page (`src/renderer/newtab*.js`, `newtab.html`), its cards, the Edit layout / Add widget flow, and the setup forms. Walked as a new user (fresh profile) and a returning user (12 seeded cards) in off-screen windows at 1280x860 and 800 wide, light and dark. Screenshots are in `docs/ux-audit/shots/` (`before-*` and `after-*`; `seeded` = several cards, `fresh` = new profile, `scrollN` = the seeded page scrolled N px).

Overall: the page is in good shape. Focus rings, reduce-motion, skeleton loading, per-card labels and keyboard moving/resizing are all there, and light and dark match. The problems are in what cards say when they cannot show anything.

## Findings, by user impact

Status: FIXED here, or LATER (left for another change).

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

6. **Gmail's button is announced "Sign in to Gmail for Gmail".** Left as is: an existing test pins the label and it disambiguates two Gmail cards. LATER: use the account email as the suffix.

7. **"Couldn't update" followed by "Couldn't connect. Check your internet connection."** on the same card repeats itself. LATER: owned by the network-error change in `widgets.js` (`request()` / `netError`); once that lands, drop the heading when the message already starts "Couldn't".

8. **Add widget is only visible in Edit layout once a page has cards.** A returning user who wants one more card has to find "Edit layout" first. The toggle's tooltip says "add", so it is discoverable but not obvious. LATER: show a quiet "+" beside Edit layout.

9. **Todoist (and other kinds with no inline form) open Settings from the Add list with no visible message.** The announcement is for screen readers only. LATER: a short toast ("Opening Settings to set up Todoist").

10. **Add widget list has no search and mixes order** (Smart Stack, Weather, Apple Music, Spotify, GitHub, World clock, Todoist...). With 20+ kinds it is a long scroll. LATER: group (Time and weather, Music, Work) and add a filter.

11. **Favorites come from bookmarks, but only an empty list says so.** Nothing on the page tells a new user how to change them (bookmark a page, Ctrl+D). LATER: a tooltip on the Favorites heading.

12. **The greeting says "Good evening" from midnight to 5 am.** Minor; LATER.

13. **Ask AI mode says "Ask Claude..." even before any AI is connected.** The first-run welcome sidebar is owned by the sidebar area; noted for them.

14. **Small targets.** Card icon buttons (refresh, edit, move grip) are 22 px, resize handles 18 px. They are secondary and keyboard reachable, so left alone. LATER: 24 px minimum.

## Checked and fine

- Focus rings on every control I enumerated (cards, buttons, tiles, mode switch, pickers); no control without an accessible name.
- Reduce motion: page arrival, skeleton shimmer, stacks, tiles and toolbars all respect it.
- Loading state: card skeleton with `role=status`. Dark theme: same structure and contrast as light.
- At 800 px the cards stack into one column in reading order (`before-seeded-800-light.png`).
- The setup form (`before-setup-Weather-1280-light.png`): labelled fields, example placeholder, clear primary button, inline errors that keep the form open.

## Tests

`test/newtab-states-ui.js` (added to `scripts/test-all.js`): needs-setup heading and single Open Settings button for Todoist and GitHub, no "Updated" under Gmail's sign-in, Try again shows "Trying...", the edit tip is short, steps aside for the list and returns, and the x is 24 px.
