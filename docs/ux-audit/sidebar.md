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

## Findings left for later (ranked by user impact)

1. **Five icon-only buttons in the sidebar header** (helpers, bolt, tasks, research, history). Only tooltips explain them, and Helpers shows as "selected" blue with no label. A new user cannot tell what they do. Fix: group Tasks/Research/Routines under one labelled "Background" menu, or show labels at wide widths. Needs a design pass, not a tweak.
2. **Two usage lines** ("1.5k tokens - ~$0.01" under the header, "4.5k tokens - $0.04 today" in the composer) look alike but mean "this chat" and "today". Label the first "This chat".
3. **Model picker lists Auto twice** (top row and under Claude) and does not say which providers need sign-in until you hover; headings show a count only. Add a "Sign in" tag on providers without a key.
4. **Approval card button order**: the primary is "Allow for this chat" while tool cards say "Allow once"; the same decision has two names.
5. **Tool steps carry no timing and no per-step Stop**; only the composer's stop square ends a run, and the square has no label (tooltip only).
6. **History rows show the first message as the title**; two chats that start "hi" are indistinguishable. Show the page title or a generated topic.
7. **Test-site artifact**: the first attempt to ask on a localhost tab showed "AI off here" because localhost is treated as an AI-off site by default in test profiles; not verified on a normal profile.
8. Tasks, Research and Routines panels and the full chat page (chat-page.html) were not walked in this pass.
