# Meeting helper

A sidebar co-pilot that assists during and after web meetings (interviews, architecture discussions, and client calls) with real-time answers, saved agenda and resume context, stealth screen-share protection, and post-call summaries.

Open it with **Ctrl+Shift+E** (`Shift+Cmd+E` on macOS). A website that uses that key itself (Google Docs centres text with it) gets it first, so there (or anytime) use the sidebar's ⋯ (More) menu under **Meeting helper**. Ctrl/Cmd+Enter is no longer the Meeting helper's key: it always means "send what is in this box now" (and inside a web page it stays the page's own key).

## Live prompting

During a live meeting, press `Ctrl+Shift+E` to bring up the helper, type what was asked, and get high-value answers and talking points immediately:

- **Concise answers:** Formatted specifically for conversations: direct bullet points, no preamble, and actionable talking points.
- **Engine routing:** If you have an API key connected, the helper uses your fast model. With no API key, it routes through your local Claude Code CLI (`haiku`), with zero external configuration needed.

## Saved context per meeting

Keep your background materials ready in the **Context** tab so you never have to re-explain yourself mid-call:

- **Meeting agenda & goals:** The topics to cover, goals, or anticipated interview questions.
- **Resume & background:** Your past projects, leadership experience, architecture highlights, or metrics.
- **Notes & scratchpad:** Quick notes taken while listening.

Everything typed into the Context tab is automatically saved locally in your profile (`meeting-context.json`) and fed into every prompt.

## Screen-aware on request

Check **Include active tab** in the prompt box to give the assistant visibility into the current web page. This lets the AI read shared slides, design specs, or text chat from your call without requiring manual copy-pasting.

## Stealth mode (invisible to screen sharing)

When you share your screen in Google Meet, Zoom, Microsoft Teams, or Slack, click the **Stealth** pill in the helper header.

- Stealth mode activates operating-system-level window content protection (`setContentProtection` in Electron: `NSWindowSharingNone` on macOS, `WDA_MONITOR` on Windows).
- When active, screen recording and screen sharing software cannot capture the window: participants will see what is behind it instead. Your notes, resume context, and AI suggestions stay completely private.

## Live audio listener

Click **Listen** to activate the live audio listener. It records the microphone in 20-second pieces and turns each into text with Lumen's voice input (Settings → AI and agents → **Voice input**: your OpenAI or Gemini key), then adds it to the **Transcript** tab. Chromium's built-in speech recognition can't work in Lumen, so without one of those keys Listen says which key to add. Each piece goes to that provider only and is never saved; the microphone hears your side of the room, so use speakers (not headphones) if the other side should be heard too. Recent utterances are automatically supplied as context to subsequent prompts so the assistant understands the conversational flow.

## Post-meeting summaries and chat saving

After a call ends:

1. Switch to the **Summary** tab.
2. Click **Summarize Meeting** to produce a structured Markdown briefing containing an Executive Summary, Key Decisions, and Action Items with assignees.
3. Click **Save as Chat** to save the full meeting session (including agenda, prompt Q&A, and full transcript) directly into Lumen's sidebar chat list. You can review it later, search it, or ask follow-up questions anytime.
