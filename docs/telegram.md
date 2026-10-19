# Phone (Telegram)

Send requests to Lumen's AI from your phone, through a Telegram bot of your own. Each message runs as a [background task](../README.md#the-ai-in-the-sidebar) on your computer, and the result comes back to the chat. Off by default.

Lumen has no servers. While it is open, it asks Telegram for new messages to your bot itself (the Bot API's `getUpdates`, over HTTPS). When Lumen is closed, nothing runs: messages sent meanwhile are not run later (Lumen replies that they arrived while it was closed).

## Set it up

1. In Telegram, message **@BotFather**, send `/newbot`, pick a name and a username. BotFather gives you a token like `123456789:AA…`.
2. In Lumen, open **Settings → AI and agents → Phone (Telegram)** and turn on **Take requests from my Telegram bot**.
3. Paste the token under **Bot token** and press **Save token**. Lumen checks it with Telegram, then stores it encrypted with your OS keychain. It is never shown again, never logged, and only ever sent to Telegram (`api.telegram.org`).
4. Press **Pair**. Lumen shows a 6-digit code for 10 minutes. Send `/pair <code>` to your bot from your Telegram account. Lumen replies **Paired**, and Settings shows the chat's name.

Only that one chat can use the bot. Messages from anyone else are ignored, with one polite reply an hour at most, and group chats are never answered. A chat that sends five wrong codes can't pair with that code any more; twenty wrong codes from all chats together end the pairing. Press **Pair** again for a new code.

**Unpair** forgets the chat. To pair a different chat, press **Unpair** first: **Pair** is only offered while no chat is paired, so a new pairing never replaces yours. **Remove bot** forgets the token and the pairing and stops listening.

## Using it

- Send a request in plain words: "find the cheapest flight from Boston to Lisbon in May on google.com/travel". Lumen answers **Working on it…**, runs it as a background task with your default model, and sends the result when it is done. Long results come in several messages (Telegram allows 4096 characters each).
- Forwarded messages are never run, since their words are someone else's. Type the request yourself.
- `/status` lists the tasks you started from Telegram that are still running. `/stop` stops the latest one. `/help` lists the commands.
- The task also shows in the sidebar's **Background tasks** panel, like one you made in Lumen.

## What the task may do

Exactly what a background task you make in Lumen may do:

- It works in its own hidden tab, never in yours.
- It starts with no allowed sites. Every site it wants to open asks on the phone first, even one your message names (in Lumen, the create card shows you the sites before you confirm; a Telegram message has no such preview). Allow lets it in for that step.
- Steps that buy, send, post or submit something ask every time.
- A question comes to the chat as a message with **Allow** and **Deny** buttons. Allow lets that one step through, the same as **Allow once** in the Tasks panel; it never allows a site for good. You can also answer in Lumen's Tasks panel; the phone's message then says it was answered there.
- A question nobody answers is denied after the wait set in the Tasks panel (an hour unless you changed it), and the task finishes with what it has.
- **Use my sign-ins in these tasks** (off by default) gives the task's tab your cookies, like **Use my sign-ins** on a background task. Off, it works signed out.
- **Bypass in background tasks and routines too** applies to these tasks the same way it applies to other background tasks.

## Privacy

Your messages to the bot, the results, and the approval questions (which name the site and what the AI wants to do there) pass through Telegram's servers. Use it only for requests you are fine sending through Telegram. The token is encrypted on your computer; the paired chat's id and name and the bot's username are kept in `settings.json`. See [PRIVACY.md](../PRIVACY.md).

## When it doesn't answer

Settings shows what Lumen is doing:

- **Listening for messages.** All is well. Lumen only answers while it is open.
- **Offline.** Lumen waits for the connection to come back.
- **Couldn't reach Telegram.** Lumen tries again, waiting longer each time (up to 5 minutes).
- **Another program is reading this bot's messages.** A webhook or another app is using the same bot. Telegram lets only one reader at a time; give Lumen a bot of its own.
- **Telegram didn't accept the bot token.** The token was revoked or is wrong. Paste a new one from @BotFather.
