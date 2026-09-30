# Changelog

Notable changes to Lumen. Versions follow the tags on GitHub; downloads are on [Releases](https://github.com/emah-maker/lumen/releases).

## Unreleased

## 0.3.2 (2026-09-29)

- Security fix: AI research tabs now open only after a page was read, and only at an address the AI was allowed to load, so a redirect to a site you did not approve never loads in a tab. Research tabs are also kept away from extensions.
- Tab grouping by topic is much more accurate and is now the default: related tabs across different sites land in one group (a whole trip, course, job search or recipe plan), and unrelated tabs are rarely pulled in. On a set of realistic sessions, accuracy went from 0.59 to 0.88 and wrongly grouped tabs from 23% to 4%. A choice you made before is kept.
- Tabs organize themselves: a few seconds after your tabs change (Settings > Tabs > Organize after, 2 seconds to 1 minute, default 5), loose tabs are grouped on this computer with Undo. By default only when they are a mix of topics, so two related tabs next to an unrelated one become a group while a few tabs about one thing are left alone ("Only when topics are mixed").
- Organize with AI asks the model when groups look like pieces of one topic, gives it 8 seconds before keeping the quick grouping, keeps names you chose, and says what it did ("3 groups, 2 tabs left loose").
- New-tab grid rebuilt on a 12-column layout with 24px gutters: side widgets can be as wide at the top as lower down, the sections sit right under the search box, and a card dropped under another lands one gutter below it. The clock (Small to Extra large) and the search box width can be resized in Edit layout or in Settings > Home.
- Widgets look cleaner: no scrollbars unless there is more to see (lists show "+N more"), the weather card shows the place once and drops details before cutting rows, and every card shares the same padding, title and footer.
- Widget settings rewritten in plain language: a list with a summary of each widget, a page per widget with grouped sections, and account widgets with a clear connected / not connected line and a "Where do I get this?" link.
- Spotify: a Web player mode shows Spotify's own site in the card (sign in on Spotify, no developer setup, no user limit), and the Now playing card has a one-click "Log in with Spotify".
- Ctrl+Shift+K (Cmd+Shift+K) starts a new sidebar chat. Every Ask AI question, from the new-tab box or Alt+Enter in the address bar, opens a new chat; the previous one stays in the list.
- The new-tab box's Search / Ask AI choice no longer changes what the address bar does: the address bar always searches or opens the address.
- Background tasks are easier to follow and control. The Tasks panel shows each running task's current step, step count and time, and a queued task's place in line; anything waiting for you appears at the top with its approval card so you can answer from the list. Finished tasks you have not opened get a "New" marker and a dot on the Tasks button.
- Tasks interrupted by closing Lumen say so when it reopens and can be resumed from what they had done (or retried from the start). Edit and run again changes a task's request, name or sites; Copy result and a list of the pages a run visited were added; a run that fails before writing anything keeps the last good result. Repeating tasks now really are given the previous result to compare with.
- Notifications: one message per wait instead of one per question, a system notification only when Lumen is not the window in front, and a new option to skip the plain "finished" ones. Questions nobody answers are refused after 15 minutes to 4 hours (your choice) so a task no longer holds its place forever. New menu item: Run a Task in the Background.

## 0.3.1 (2026-09-29)

- Settings, redesigned like System Settings: a sidebar with search and eleven categories, one category per page in grouped lists, and deeper areas (skills, usage, MCP servers, site permissions, widgets, internals) as their own pages. Rarely used options moved under Advanced. No setting was removed and old `lumen://settings/...` links still open the right place.
- The AI now shows its research: pages it searches or reads open as background tabs in an "AI: <query>" group with a reading marker. These tabs use a separate memory-only session, so none of your cookies or logins reach those pages and nothing they set reaches your profile. Turn it off in Settings > AI and agents.
- Claude Code with no model picked now chooses Haiku, Sonnet or Opus per message by how hard the request looks; a model you pick is always used. Toggle in Settings > AI and agents.
- Faster agent tools: `navigate`/`open_tab` can return the new page's outline in the same call, clicks and typing can return only what changed, `read_page` can extract tables, links and lists as JSON, and `read_pdf` takes a `query` that finds which pages mention something in one call.
- PDFs zoom with Ctrl+Plus, Ctrl+Minus, Ctrl+0 and Ctrl+scroll.
- Organize tabs counts sleeping and not-yet-loaded tabs, and its "nothing to group" and error messages are a note that closes itself instead of a dialog.
- New-tab page: the clock and search stay centred at full size; widgets stay exactly where you drop them (packing is now opt-in) with a clear gap from the centre column and a narrower outer margin; the weather week lays out in a row on wide cards; the world clock and Favorites no longer show a scrollbar when everything fits.
- The sidebar's "working" line keeps animating under Reduce motion and Performance mode, no longer restarts with each streamed word, and hides while an approval waits for you.
- Security: the Organize undo message is now accepted only from Lumen's own interface, and one-shot Grok calls can't use the terminal.

## 0.3.0 (2026-09-29)

- The AI sidebar now floats over the new-tab page instead of squeezing it: opening it no longer narrows and re-wraps the cards and the search box; the sidebar simply covers the right side of the page. Web pages still make room for the sidebar beside them as before. The sidebar's own keyboard use, focus and Reduce motion behavior are unchanged.
- New-tab page: Edit layout is now a button on the page itself (bottom right, always there). Turn it on to drag, resize or hide any card, and the page's own sections too: the clock and greeting, the search box, Favorites, Frequently visited and Privacy behave like widget cards on the same grid. Nothing moves until you move something, and Reset layout puts every section back in the centre. An Add widget tile and picker put new widgets (or a hidden section) on the page without opening Settings; snap guides show what a card lines up with; removing a card, moving it or resetting can be undone (Undo button, Ctrl+Z, or the toast). Arrow keys move a focused card, Shift and arrows resize it, Ctrl+Alt and arrows snap it, and each step is announced to screen readers. It stays still with Reduce motion or Performance mode, and the page still never goes online.
- New-tab widget: Spotify. A now-playing card (title, artist, album art, live progress) with play, pause, next and previous. You bring your own Spotify Client ID and sign in once from Settings (OAuth with PKCE through a loopback address, no client secret); Lumen keeps the refresh token encrypted, does all the talking to Spotify itself, and gives the page only text and a small picture. Shows a calm message when nothing is playing or no device is active, renews expired sign-ins by itself, and backs off when Spotify says to slow down. Playback controls need Spotify Premium.
- New-tab Gmail widget (read-only): your unread count and the latest inbox senders, subjects and previews. It signs in with your own Google Cloud OAuth client (Client ID and secret from Settings, gmail.readonly only): Google's sign-in opens in your normal browser, a one-time listener on 127.0.0.1 receives the result, and the tokens stay encrypted in Lumen and never reach the new-tab page. A revoked or expired sign-in shows a Reconnect card, and rate limits back off. Google's limits for unverified apps apply (in Testing status only test users can connect, and the connection ends every 7 days). The sign-in code is a shared OAuth helper (PKCE, loopback redirect, token refresh) that other widgets can reuse.
- New Slack widget for the new-tab page (default 4x4): unread DM and mention counts and recent messages from up to four channels, read-only. You sign in with your own Slack app over OAuth (Slack requires an https redirect, so approving ends on a page you paste back into Settings), or paste a user token. Tokens, including Slack's rotating refresh token, are stored encrypted and never reach the page; rate limits back off and a refused sign-in shows a Reconnect button. The OAuth pieces (state, PKCE, redirect parsing, expiry, token storage) are in `features/oauth.js` for other sign-in widgets to reuse.
- New GitHub widget for the new-tab page: your review requests, issues and pull requests assigned to you, and your unread notification count. It uses a fine-grained read-only personal access token (stored encrypted, sent only to api.github.com, never shown to the page), waits out GitHub rate limits, and says so plainly when the token is rejected. Unread notifications need a classic token with the notifications scope; without one the card still shows the two lists. Titles from private repositories are shown on the card and kept in memory, so leave repositories out of the token to keep them off it.
- New-tab widget: Feed headlines. Pick Bloomberg (Markets, Technology, Politics), Hacker News or NPR, or paste any https RSS or Atom address; each headline shows its source and how long ago it was posted, and opens in a new tab. Lumen fetches and reads the feed itself with a small built-in reader that refuses custom XML entities, caps sizes, strips markup from titles and drops non-web links.
- New-tab World clock widget: up to eight places with a live clock, the date, how many hours ahead or behind you they are, and today's sunrise and sunset with a day or night icon. Search places in Settings (Open-Meteo, free, no account); Lumen fetches only the sun times, and the clocks tick on the page from time zone names with no network. 12/24-hour, optional seconds, and it matches the screen colors like the other cards.
- New-tab widget: Muse, Meta's model (Meta Model API, public preview). It answers a saved prompt on the card (a short daily brief by default, refreshed every six hours at most), you can type a one-off question in the card, and an option grounds answers with web search and shows https sources. Add your own key from dev.meta.ai in Settings; it is stored encrypted and never reaches the page or the settings file. Your prompt, questions and Meta's answers go to Meta and use the key's credit; answers are capped in length. 401 and 429 show as plain messages. Model defaults to `muse-spark-1.3` and can be changed.
- New-tab widgets: Stocks (Twelve Data, with your own free API key) and Crypto (CoinGecko, key optional). A compact price table with change, "as of" time and a Delayed/Live badge; offline they show the last prices dimmed and say so. Each has a Paper trading tab: a simulated portfolio (default $100,000) you buy and sell at the last shown price. Nothing is ever ordered anywhere, it is not investment advice, and the trades live only in the widget's settings. The watchlist symbols are sent to the data provider you chose.

## 0.2.13 (2026-09-29)

- New-tab widgets sit on a free grid: drag them anywhere (beside the search box too), resize from any edge, snap to a side or the top, and the others move out of the way. Edit widgets (or press and hold) wiggles them like a home screen. Existing widgets keep their order and sizes.
- Weather: several places, My location (asks first), hourly and by-day views. Todoist: choose the filter, grouping, sort and fields, undo completing, quick add. Calendar, weather and Todoist can match the screen colors.
- New-tab animated backgrounds (particles, stars, bubbles, snow) with color, amount, speed, size and pointer options; they stop when Reduce motion or Performance mode is on, and while the tab is hidden. Fixed the vertical bands that could show across the search box and cards while an effect ran.
- Background tasks now run on Claude Code and Grok Build too, each in its own process with the same approval cards and no shell access.
- A usage bar for Grok Build: how full the chat's context is, your own daily or weekly budget if you set one, and a "limit reached" state with the reset time. Grok doesn't publish plan limits, so the bar never claims plan usage.

## 0.2.12 (2026-09-29)

- Skills: saved prompts you run from the sidebar with a slash command (`/summarize`, `/explain`, `/reply` and more), editable in Settings, with import and export.
- Ask across your open tabs: type `@` in the sidebar to attach specific tabs or all of them, or ask "compare these tabs"; the AI can also read several tabs at once.
- The AI no longer goes wrong when you switch tabs while it is working: it stays on its own tab, and the sidebar shows "Working in: …" so you can see which.
- Translate a page with your connected AI (or Google Translate), a screenshot tool (Ctrl+Shift+S) with visible, full-page and select-area capture, and a QR code for the page or selected text.
- Dragging a tab out of the tab strip now opens its window at once and it follows your mouse; drop it on another window's strip to merge, or drag a window's only tab to move the window.
- Performance mode (Settings, System; Auto by default) turns on for slower PCs: tabs sleep sooner, caches are capped, and blur and animation are off. The install is about 60 MB smaller.
- Organize is faster and smarter: the local organizer applies at once and the AI only refines names and leftover tabs (a 200-tab session finishes in about 4 s instead of 6 s), with learning from your drags, a "Close duplicate tabs" item, and an optional idle organizer.
- On Mac, the Keychain's "Always Allow" for Lumen now survives updates (builds are signed with one stable certificate).
- The model menu no longer hides under the chat history list, and the usage panel says "this PC" on Windows.
- New-tab page widgets (weather, calendar, Todoist, web pages) that you can drag and resize.
- Background tasks: let the AI do a job on its own in a hidden tab while you keep browsing (the clock button next to Send, or `/background …`), on a schedule, or watch a page and get told when it changes or a condition holds (`/watch …`, or Watch This Page in the menu). Tasks live in a new Tasks panel with steps, results, cost, and approval cards; they ask before visiting sites you did not list and before buying, sending or submitting anything. Scheduled and watching tasks run only while Lumen is open.
- Automation (Playwright over CDP) on macOS no longer opens Chromium's debugging port: Lumen answers the protocol itself, and links opened from other apps keep working.

## 0.2.11 (2026-09-29)

0.2.10 was tagged but its build stopped at a failing test and was never published; its changes ship here.


- Open the sidebar chat as a full page (button in the sidebar, or Ctrl+Shift+L) with your saved chats alongside; the sidebar and the page share one chat.
- A downloaded update installs by itself when you quit Lumen, and one downloaded earlier is reused instead of fetched again.
- Auto organize is smarter: better topic groups and names, new tabs and sites are placed as you browse, groups with similar names merge, and Organize with AI falls back quietly if it fails.
- The sidebar AI is faster: independent page reads run at once, repeated reads of an unchanged page are skipped, replies render incrementally, and the Claude Code and Grok Build engines start quicker.
- Runs end cleanly: hitting a step limit gives a written summary and a Continue button instead of stopping silently. There is a new "Max steps per task" setting (default Unlimited), and scripts are a last resort for the AI.
- OpenRouter, OpenAI, Grok, Gemini and the Claude API now connect through the same network stack as the browser, so proxies and campus or VPN networks no longer cause connection errors; the error now says why.
- The usage panel no longer credits Lumen with plan usage from Claude Code you ran elsewhere.
- Outside agents no longer post a "connected" and "disconnected" line in the chat for every session.
- Google loads dark from the first frame in a dark theme.

## 0.2.9 (2026-09-29)

- macOS builds are now Widevine-signed, so sites that require production Widevine (Netflix, Disney+, Spotify) can play.

## 0.2.8 (2026-09-29)

- Updates install from inside Lumen on every install type: it downloads the release zip, checks it, and swaps it in when you restart. Per-machine installs, the portable exe and unwritable Mac apps still get a Download prompt.
- Drag a tab out of the tab strip to open it in its own window, drag it onto another window to join it, or use "Move tab to window" in the tab menu.
- The sidebar AI can read a PDF you have open, after you allow it for that file.
- A usage bar for Claude Code and Grok Build.
- The AI works faster and wastes fewer steps: a clearer prompt, cached prompts, trimmed tool results, and a guard that changes course after repeated failed actions.
- Google pages that ignore the dark theme are darkened, and the taskbar icon is re-applied after load.
- Release builds can be Widevine-signed when castLabs EVS credentials are set up.
- Includes the 0.2.7 changes below, which were never published on their own.

## 0.2.7 (2026-09-28)

- PDF viewer, opening YouTube videos, and browsing local files.
- Downloads panel, plan usage tracking, new themes, and a reworked tab strip.

## 0.2.6 (2026-09-28)

- Private windows (Ctrl+Shift+N): nothing is saved, and closing the window clears its data.
- Tab search (Ctrl+Shift+A), a speaker button to mute tabs, and Mute Site.
- Save Page As, View Source, Reader mode, and Picture in Picture from the video menu.
- Bookmarks page (Ctrl+Shift+O) with HTML import and export, a Downloads page (Ctrl+Shift+J), and clearing browsing data by time range.
- Chat history in the sidebar, Markdown export, and token and cost counts per chat.
- Turn AI off for a site, and undo the tab changes an AI reply made.
- Add your own MCP servers as tools for the sidebar AI; every call asks first.
- Organize Tabs with AI works through Claude Code or Grok Build, with no API key.
- Certificate warning page, and the lock shows when a secure page loads insecure content.
- Optional Google Safe Browsing (off by default; needs your own API key).
- Keyboard navigation in the tab strip, and UI text moved into `locales/` for translation.
- Windows: the taskbar and shortcuts show Lumen's icon. Adding an extension from the Chrome Web Store no longer closes Lumen.
- Grok Build: tool calls are checked by Lumen before they run, Lumen's tools are ready before the first turn, and `XAI_API_KEY` sign-in works.
- The browser window runs sandboxed.
- New docs: MCP tools, settings and architecture.

## 0.2.5 (2026-09-28)

- In-app updates from GitHub Releases. The installer build updates itself; the zip and the Mac app offer a download.
- The sidebar can pick the model for Claude Code and Grok Build.
- Automation (Playwright over CDP) goes through a private pipe on Windows and Linux, and the automation address needs a key.
- Tighter approvals for the sidebar AI: redirects, web searches, batch steps and scripts are checked against the chat's approved sites.
- Extension installs show the permissions the extension asks for.
- Grok Build is labelled experimental in the model picker.
- Release builds ship the license and third-party notices; macOS bundles pass codesign.

## 0.2.4 (2026-09-27)

- `navigator.webdriver` stays false while AI automation is on.

## 0.2.3 (2026-09-27)

- Sends Chrome's `Sec-CH-UA` client-hint headers, with the brand list built the way Chrome builds it.

## 0.2.2 (2026-09-27)

- Cross-site iframes and workers get the same Chrome identity as the page.

## 0.2.1 (2026-09-27)

- macOS apps are built from castlabs' Electron (Widevine), and keyboard shortcuts in `press_key` work on a Mac.
- Background tabs go to sleep after 2 minutes when memory runs low.
- The Electron binary is fetched on `npm install`.

## 0.2.0 (2026-09-27)

- First public release.
