# Auto model

**Auto** is the first row of every model picker (the sidebar, the full-page chat, Settings and the skill and background-task pickers). Pick it and Lumen chooses the model for each message, instead of you pinning one. A model you pick yourself is always used exactly as picked.

Everything happens on your computer. The router (`src/ai/auto-model.js`) is a pure function: it makes no model call and no network request, reads no page, and logs nothing about what you wrote. It sees only the shape of a request (how long the message is, whether it holds images, which words it uses, how long the chat is) and the list of models you have connected.

## What Auto covers

| Surface | What Auto does |
|---|---|
| Sidebar chat, full-page chat, per-tab chats | One pick (`auto`) saved with the chat and in Settings. Every message is routed afresh; the chat's pick stays Auto. |
| Claude Code | Routes to `claudecode:haiku` / `sonnet` / `opus` / `fable`, passed as `claude --model <alias>`. The engine's own **Claude Code** row (no model chosen) already did this per message (`src/features/model-route.js`, Settings → "Pick the Claude Code model for me"); both use the same scoring. |
| Grok Build | Routes among the models `grok models` lists, passed as `grok --model <id>`. With no list, its own `default` row is used (no flag: Grok chooses). |
| Antigravity | Routes among the slugs `agy models` lists, passed as `agy --model <slug>`. With no list, its `default` (no flag). |
| Codex CLI | Not an engine of this branch: once its models are listed in the picker's options (`aiAgents.modelOptions()`), they join Auto with no change here, like any other option (an option's `tier` field, when the engine sets one, wins over the name-based tier; `gated: true` keeps a plan-gated model out). Its spawn flag stays the engine's own. |
| API providers: Anthropic, OpenAI, Grok (xAI), Gemini, OpenRouter (and any model reached through it) | Routes among the models listed for each key. The request carries the concrete model id. |
| Background tasks and routines | "Auto" is offered first in the task and routine model pickers. Each run is routed to one of the connected **API** models (a CLI engine's tools differ, so a CLI is picked by hand). |
| Page translation, tab-group naming, Organize, "create a skill from this chat" | These one-shot jobs use the cheapest fit (the `classification` / `quick` kind) when your pick is Auto. |
| Skills with their own model | A skill may be set to Auto too. |
| Muse widget (new tab) | Left out: it calls Meta's one model family with its own key, and its three versions are not tiers (the newest is already the default). |
| MCP tools (`mcp.js`, the automation server) | Left out: none of them takes a model; the outside agent brings its own. |

## Where the choice is shown

- The reply is labelled **Auto · Claude Haiku 4.5**; hover for the reason ("Auto: Haiku 4.5 for a quick question").
- The picker's Auto row says what Auto chose last in the open chat ("Auto · Haiku 4.5"), with the reason as its note. It stays selected.
- A quiet note appears when Auto changes model mid-message (see Escalation).
- The usage log, the context bar, the chat's cost line and the AI status card all record the **concrete** model that ran, never "auto".

## How Auto chooses

1. **Tier of each model.** Fast (Haiku, mini, nano, flash, lite), balanced (Sonnet, GPT-4o, an engine's own default), strong (Opus, Fable, GPT-5, o3, Pro, reasoning models). An option can carry its own `tier` (a catalog or engine that knows better); otherwise it is read from the model's name.
2. **What the request needs.**
   - A quick lookup, summary, translation, classification or title (the one-shot jobs name their kind): a fast model. A summary of a very long page: balanced.
   - A chat message is scored from its wording the way `model-route.js` always did: a greeting, "open this", "what time is it" is light; a typical request is standard; a multi-step brief, a stack trace, code, "refactor / debug / design / investigate" is heavy. Several attached tabs raise the score. A short follow-up ("continue", "yes", "fix it") never drops below the previous turn's tier, and inside a running CLI session the tier never goes down (a different model would lose the prompt cache).
   - A long conversation (over about 60,000 characters) lifts "fast" to "balanced"; a very long one (over about 240,000) lifts everything to "strong".
   - **/think** and **/deep** at the start of a message ask for the strongest model for that message; **/fast** asks for the quickest. The command is removed before the message goes anywhere, and it changes nothing when you picked a model by hand.
3. **Which models can answer.** Only models that are connected and signed in; not turned off for Auto (Settings → AI → **Auto may use**); not cooling down after a usage limit, rate limit or outage (the same cooldowns as [model fallback](settings.md#ai-and-agents)); not refused for this account this session ("not available on your plan", no access to the model: Opus-only plans, models gated by plan); able to use tools when the message needs them (chat-only models are skipped); able to see images when the message holds some; with a context window that holds the conversation. A CLI engine is left out while another chat is running, because the CLIs take turns.
4. **Choosing.** The candidate whose tier is nearest the need wins (a stronger model before a weaker one that may not manage it). Ties go to the provider already answering in the chat, then the one you were on before choosing Auto, then the cheaper (the catalog price when there is one), then the picker's order. The same inputs always give the same answer.
5. **Native defaults.** An engine's own `default` row (Claude Code's, Grok Build's, Antigravity's) is used only when the engine lists no models to choose from. Auto then defers to what the CLI picks: no `--model` flag is passed.

## Escalation and fallback

- **Escalation (once per kind of failure).** If the model Auto chose cannot take the request, the same turn goes on the next best model:
  - too long for it: a model with a larger context window (else a stronger one);
  - it takes no tools: one that does;
  - the account cannot use it ("not available on your plan", "do not have access"): another model at the same tier, and Auto leaves that model out for the rest of the session;
  - it declines the request: one try on a stronger model.
  
  Nothing runs twice: only the failed request is asked again, with the whole history, so tools that already ran are not run again.
- **Fallback.** A usage limit or an outage is handled by [model fallback](settings.md#ai-and-agents) as before (the failed model is left alone for a while and the turn goes on another). On Auto, the next message is routed afresh and the model that was limited is skipped until its reset.

## Settings

| Setting | Key | Default | What it does |
|---|---|---|---|
| Model | `model` | `auto` on a fresh profile with more than one model connected | The picker's first row is **Auto**. A saved choice is never changed: profiles that already chose a model keep it. A profile with **no** saved choice at all (a new install) starts on Auto once two or more models are connected; with one model it starts on that one, as before. A saved model that has disappeared (a key removed) falls back as before, not to Auto. |
| Auto may use | `autoExclude` | `[]` | Providers (or single models) Auto never chooses: ids such as `openai`, `claudecode`, `claude-opus-5`. Settings → AI lists a tick per connected provider. |
| (internal) | `autoHome` | none | The model you were on when you chose Auto; its provider is preferred when two would do. |

The per-chat pick is kept in the chat's settings: `autoFrom: 'auto'` while Auto is the pick (the concrete model of the last message is in `model`, and the label and reason in `autoLast`).

## Where it lives in the code

- `src/ai/auto-model.js`: tiers (`tierOf`), the request's needs (`needFor`), candidate filtering (`candidatesOf`), the choice (`route`), escalation (`escalate`, `failureOf`), the refused-model memory (`createDenied`), `/think` hints (`hintOf`) and the picker row (`pickerEntry`). Pure; tested by `test/auto-model-units.js`.
- `src/ai/agent.js` ("[auto model]"): `routeAuto` at the start of each turn, `escalateFor` in the model loop and the CLI-engine path, and the restore of the pick at the start of the next turn (`autoFrom`).
- `src/main.js` ("[auto model]"): `autoRoute`, `autoEscalate`, `pickerOptions` (Auto first, no heading), `effectiveModel` (the default rule), `autoConcrete` (one-shot jobs), `autoProviderList` (Settings).
- `src/features/background-runner.js` and `background-agents.js`: Auto for background tasks (API models only).
- Tests: `auto-model-units` (router), `auto-engines-units` (what each CLI and provider receives), `auto-agent-units` (the turn, restore, escalation, fallback), `auto-model` (the real app: pickers, persistence, labels, hints).

## Limits

- A chat on Auto that Auto sends to a CLI engine counts as an API chat for the "chats working at once" slots; the router leaves CLI engines out while another chat is running, so two CLI turns never overlap.
- A chat restored after a restart shows the concrete model of each earlier reply but not the reason (the reason is kept for the last message only).
