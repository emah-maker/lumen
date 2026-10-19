# UX audit: AI sidebar and chat

Walked in a hidden window with a throwaway profile and a stubbed model. Screenshots in `docs/ux-audit/shots/`, named `before-<light|dark>-<state>.png` and `after-...`. States: `empty-360`, `empty-with-page`, `answer-360`, `tools-approval-360`, `approval-interact`, `fallback`, `error`, `history`, `picker-full`, `slash-full`, `more`, `helpers`, `perm`, `wide-560`, `narrow-300`, `window` (no AI connected). Note: the "dark" shots did not render dark in the hidden test window (a test harness limit), so dark was judged from the CSS tokens, not the pictures.

## Fixed in this PR

1. **Starter chips looked like plain grey text** (`before-light-empty-360`). Nothing said they were clickable. Now bordered pills with a pointer and a focus ring (`after-light-empty-360`).
2. **"Allow on all sites" on an approval card** (`before-light-tools-approval-360`) reads like a one-time grant for this request; it really turns Auto-allow on everywhere. Now "Always allow, any site", and its second click says "Click again to confirm".
3. **"AI off here" in the page chip** (`before-light-helpers`) read as a status. It is a button. Now "Turn off AI here" / "Turn on AI here".
4. **Repeated fallback lines** ("Couldn't reach X, switched to Y" three times in a row, `before-light-error`) said one thing three times. A run of them now keeps the newest only (`after-light-error`).
5. **Slash menu and model picker descriptions were cut off with an ellipsis** (`before-light-picker-full`, `before-light-slash-full`). They now wrap to two lines (`after-light-slash-full`).
6. **/think, /deep, /fast** show in the menu for every model but do nothing unless Auto is picked; the old text said "Ask Auto for..." without saying it was required. Now short and explicit: "Needs Auto".
7. **Stop button** had the tooltip "Stop" only. Now "Stop (Esc)", matching the real shortcut.
8. **The clock button** was titled "Chats" while the panel is the chat history. Now "Chat history".

## Findings from round 1: status after round 2

1. **Five icon-only header buttons: fixed.** The header now has four buttons: the permissions bolt (which names its level, "Auto" or "Bypass", beside the icon while it is not "Ask", and whose accessible name is "Permissions: <level>"), Chat history, New chat and More. Helpers, Background tasks and the Research board moved into the More menu as labelled rows: Helpers is a checkbox row that reads "On" or "Off" in words (it no longer looks selected with no label), and the two panels show their running/finished count in the row. A dot on the More button (accent while tasks run, amber when one waits for you) keeps the old badge from being lost. 300 and 360 px both fit (`after-light-empty-300`, `after-light-perm-on-300`, `after-light-more`).
2. **Two usage lines: fixed.** One line under the header: "This chat: 1.5k tokens · ~$0.01". The meter strip above the composer no longer repeats tokens and cost next to a context percent; today's total is in its tooltip (and Settings > Usage). Where there is no context percent (nothing else to show), the strip says "4.5k tokens · $0.04 today" in words.
3. **Model picker: fixed.** With models from one provider only, the second Auto under the provider's heading is dropped (it was the same choice as the top Auto). With several providers, a provider's own Auto is named for it ("Auto · OpenAI", "Grok Build · Auto"), so no two rows read "Auto". A provider whose models all need a sign-in shows a "sign in" tag on its heading, not only on each row.
4. **Approval card names: fixed.** Same words everywhere: "Allow once" means this one action (tool card, terminal card, Tasks card); "Allow site for this chat" (was "Allow for this chat") on the site card and "Allow commands for this chat" on the terminal card say what they cover; "Always allow..." is the standing setting; the refusal is "Don't allow" in chat cards and in the Tasks panel (was "Deny").
5. **Tool steps: elapsed time fixed; per-step Stop not done.** Each step shows its time at the end of its row: ticking from 3 s while it runs, final when it ends (nothing under a second; tooltip "Took 2.4s"). Steps restored from history carry no time (it is not saved). A per-step Stop is not cheap: a run is one agent loop in main and a tool call has no abort handle, so Stop stays the whole run. What was cheap: the composer's stop square now has the word "Stop" beside it.
6. **History titles: fixed, no model call.** Titles are made by `src/features/chat-title.js`: a greeting alone ("hi") is skipped for the next real message; lead-ins and sign-offs ("Hey, can you please ... thanks") are trimmed; internal markup (a `<screen_capture ...>` block a screenshot adds, or any other Lumen tag, even cut off) never shows: the real text after it is the title, a message that was only a capture is "Screen capture", and older chats saved with markup in their title are re-titled when History lists them (the saved chat is untouched; a rename always wins); a long address shows as its host; "Summarize this page" is titled with the page ("Summarize this page · Lumen docs"); long titles end at a word. A generated topic from a model was not added: it would be a paid call per chat and needs its own setting.
7. **Test-site artifact: not changed.** Needs a normal (non-test) profile to verify; the test hook is unchanged.
8. **Tasks, Research, Routines and the full chat page: walked, see below.**

## Round 2 walk: Tasks, Research, Routines, chat page

Screenshots: `after-light-tasks`, `after-light-routines`, `after-light-research`, `after-light-history`, `after-light-chat-page`.

Fixed:
- **Tasks empty text said "press the clock button next to Send"**; the clock is Chat history. The button is the » "Run in the background" button. Now says so.
- **"Open Tasks to resume it" (notifications)** pointed at a button that is now in the More menu; they say where it is.
- **Tasks panel "Settings" disclosure** is "Task settings" (it is not the app's Settings).
- **Panel title "Chats"** did not match the button, "Chat history"; the panel and the chat page's list are "Chat history".
- **Research board's citation-style menu** ("APA 7") had no visible label; it now has a tooltip.
- **Tasks' approval card said "Deny"**, chat cards "Don't allow": one wording now.

Left as is:
- The Routines tab reads clearly (note, New routine, templates); no change.
- The chat page has no Helpers, Tasks or Research entries (they are sidebar-only); the permissions bolt and AI settings there are icon-only with tooltips. Its history row says "In 2 tabs: New Tab (home), This tab", where "This tab" is the chat page itself; confusing, but it comes from the shared row code and needs a design decision about chat-page tabs.
- **Empty-state title** ("Ask anything, or give <name> a task") named "AI" when Auto was picked: it now names the connected assistant, and says Lumen when Auto (no single assistant) is picked, on the sidebar and the full chat page alike.
