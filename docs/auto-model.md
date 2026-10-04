# Auto model

**Auto** is the first row of every model picker (the sidebar, the full-page chat, Settings and the skill and background-task pickers). Pick it and Lumen chooses the model for each message, instead of you pinning one. A model you pick yourself is always used exactly as picked. Each provider's group in the picker also has an **Auto** of its own that chooses only among that provider's models: see [Auto for one provider](#auto-for-one-provider).

Everything happens on your computer. The router (`src/ai/auto-model.js`) is a pure function: it makes no model call and no network request, reads no page, and logs nothing about what you wrote. It sees only the shape of a request (how long the message is, whether it holds images, which words it uses, how long the chat is) and the list of models you have connected.

## What Auto covers

| Surface | What Auto does |
|---|---|
| Sidebar chat, full-page chat, per-tab chats | One pick (`auto`) saved with the chat and in Settings. Every message is routed afresh; the chat's pick stays Auto. |
| Claude Code | Routes to `claudecode:haiku` / `sonnet` / `opus` / `fable`, passed as `claude --model <alias>`. The engine's own **Claude Code** row (no model chosen) already did this per message (`src/features/model-route.js`, Settings → "Pick the Claude Code model for me"); both use the same scoring. |
| Grok Build | Routes among the models `grok models` lists, passed as `grok --model <id>`. With no list, its own `default` row is used (no flag: Grok chooses). |
| Antigravity | Routes among the slugs `agy models` lists, passed as `agy --model <slug>`. With no list, its `default` (no flag). |
| Codex CLI | Not a sidebar engine today: Lumen only adds itself to Codex over MCP (Codex connect), and Codex has no model list in the picker, so there is nothing to route. If its models are ever listed in the picker's options they join Auto with no change (an option's `tier` wins over the name-based tier; `gated: true` keeps a plan-gated model out), as tested in `auto-model-units`. |
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
   - **/think** and **/deep** at the start of a message ask for the strongest model for that message; **/fast** asks for the quickest. The command is removed before the message goes anywhere. They work only on Auto: with a model picked, the command asks you to pick Auto first, and a message typed that way goes as typed (Claude Code has a `/fast` of its own).
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

## Auto for one provider

Each provider's group in a model picker (Claude Code, Grok Build, Antigravity, and Claude, OpenAI, Grok, Gemini and OpenRouter) starts with its own **Auto** row. It is the same router with its choice limited to that provider's models, so you can say "use OpenAI, but pick the model for me".

| Provider | Id | Chooses among |
|---|---|---|
| Claude Code | `claudecode:auto` | Haiku, Sonnet, Opus and Fable (passed as `claude --model <alias>`). Its own **Claude Code** row (no model chosen) keeps working as before. |
| Grok Build | `grokbuild:auto` | the models `grok models` lists (passed as `grok --model <id>`) |
| Antigravity | `antigravity:auto` | the slugs `agy models` lists (passed as `agy --model <slug>`) |
| Claude (API) | `anthropic:auto` | the Claude models of the API key |
| OpenAI | `openai:auto` | the OpenAI models listed for the key (for example GPT-5.6 and GPT-5.6 mini) |
| Grok (xAI) | `xai:auto` | the Grok API models listed for the key |
| Gemini | `gemini:auto` | the Gemini models listed for the key (for example Pro and Flash) |
| OpenRouter | `openrouter:auto` | the OpenRouter models in the short list and your recent picks (not "More models…" and not OpenRouter's own router) |

Codex is not a chat engine (see above), so it has none.

- **How it works.** The pick is saved with the chat and in Settings as `<provider>:auto`, exactly like `auto`; the chat's pick stays that Auto and each message is routed again among that provider's models, with the same rules (tiers, what the message needs, escalation). The model that answers is always concrete: the CLIs and APIs never receive "auto", and the usage log, context bar, history labels ("Grok Build:") and the AI status card name the real model.
- **The reply.** Labelled like the main Auto (**Auto · OpenAI · GPT-5.6 mini**); the tooltip names the provider and the reason ("Auto (OpenAI): GPT-5.6 mini for a quick question"). The provider's row in the picker says what it chose last in the open chat.
- **/think, /deep, /fast.** They work with any Auto row selected and pick that provider's strongest or quickest model for that message.
- **Out of usage.** Models of the provider that are cooling down after a limit or outage, or refused for your plan, are skipped. If none is left, it behaves like a model you picked that ran out: with **Switch models automatically** on, the same vendor's other route answers first (Grok Build then the Grok API, Claude Code then the Claude API, Antigravity then Gemini), then any connected model, and the chat says "OpenAI is unavailable right now, so Auto uses …". The next message tries the provider again. With the setting off the message fails with "Auto: no OpenAI model is available right now".
- **One model.** A provider that has only one model to choose between (for example only Grok 4 on the xAI key, or a CLI that lists no models) has no Auto row: there is nothing to choose. If a chat is already on it, the row stays and uses the one model (a CLI that lists nothing is left to choose its own default, no `--model`).
- **Auto may use** (Settings → AI). A provider you turned off there is left out of the main Auto, but its own Auto still uses it (you picked it by name). A single model turned off for Auto (`autoExclude` holds its id) is skipped by both.
- **Warm processes.** A kept Claude Code process is tied to the model it was started with (and the chat's session): when Auto picks another model for the next message a new process starts with that `--model` and the old one ends, so a process is never used for a different model. A kept Grok Build process is set to the model of each message (and a new Grok session starts when the model changes, as it does when you change the model by hand). A chat that has not been routed yet warms its CLI with no model (Claude Code: with its own guess from the first words).
- **Background tasks and routines.** The task and routine model lists show each provider's Auto too (API providers, Claude Code and Grok Build; Antigravity has no background tasks). Each run is routed among that provider's models when it starts; a Claude Code or Grok Build run never leaves its CLI.

## Settings

| Setting | Key | Default | What it does |
|---|---|---|---|
| Model | `model` | `auto` on a fresh profile with more than one model connected | The picker's first row is **Auto**. A saved choice is never changed: profiles that already chose a model keep it. A profile with **no** saved choice at all (a new install) starts on Auto once two or more models are connected; with one model it starts on that one, as before. A saved model that has disappeared (a key removed) falls back as before, not to Auto. |
| Auto may use | `autoExclude` | `[]` | Providers (or single models) Auto never chooses: ids such as `openai`, `claudecode`, `claude-opus-5`. Settings → AI lists a tick per connected provider. A provider that is ticked off is left out of the main Auto but still used by its own Auto; a single model listed here is skipped by both. |
| (internal) | `autoHome` | none | The model you were on when you chose Auto; its provider is preferred when two would do. |

The per-chat pick is kept in the chat's settings: `autoFrom: 'auto'` (or the provider's own, `'openai:auto'`) while Auto is the pick (the concrete model of the last message is in `model`, and the label and reason in `autoLast`).

## Where it lives in the code

- `src/ai/auto-model.js`: tiers (`tierOf`), the request's needs (`needFor`), candidate filtering (`candidatesOf`), the choice (`route`), escalation (`escalate`, `failureOf`), the refused-model memory (`createDenied`), `/think` hints (`hintOf`) and the picker row (`pickerEntry`). Provider Auto: the ids (`scopeOf`, `isAuto`, `autoIdOf`), `route`'s `scope`, the provider's rows (`withProviderAutos`, `routableOf`) and the fallback when the provider has nothing left (`routeOrFallBack`). Pure; tested by `test/auto-model-units.js` and `test/auto-provider-units.js`.
- `src/ai/cli-utils.js` (`engineModel`): `claudecode:auto` and the like read as "no model" until Auto has chosen, so a CLI is never asked for a model named "auto".
- `src/ai/agent.js` ("[auto model]"): `routeAuto` at the start of each turn, `escalateFor` in the model loop and the CLI-engine path, and the restore of the pick at the start of the next turn (`autoFrom`).
- `src/main.js` ("[auto model]"): `autoRoute`, `autoEscalate`, `pickerOptions` (Auto first, no heading, then each provider's own Auto leading its group), `effectiveModel` (the default rule), `autoConcrete` (one-shot jobs), `autoProviderList` (Settings).
- `src/features/background-runner.js` and `background-agents.js`: Auto for background tasks (the main Auto: API models only; a provider's own Auto, including Claude Code's and Grok Build's, `runCli`).
- Tests: `auto-model-units` (router), `auto-engines-units` (what each CLI and provider receives), `auto-agent-units` (the turn, restore, escalation, fallback), `auto-provider-units` (provider Auto: ids, router per provider, picker rows, the turn, warm specs, background list), `grok-warm-units` (a kept Grok process and a changed model), `test/acceptance/chat-auto-provider.js` (real Agent and engines with fake CLIs: `--model`, warm Claude Code processes), `auto-model` (the real app: pickers, persistence, labels, hints, provider Auto).

## Limits

- A chat on Auto that Auto sends to a CLI engine counts as an API chat for the "chats working at once" slots; the router leaves CLI engines out while another chat is running, so two CLI turns never overlap.
- A chat restored after a restart shows the concrete model of each earlier reply but not the reason (the reason is kept for the last message only).
