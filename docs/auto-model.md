# Auto model

**Auto** is the first row of every model picker (the sidebar, the full-page chat, Settings and the skill and background-task pickers). Pick it and Lumen chooses the model for each message, instead of you pinning one. A model you pick yourself is always used exactly as picked. Each provider's group in the picker (Codex's too) also has an **Auto** of its own that chooses only among that provider's models: see [Auto for one provider](#auto-for-one-provider).

Everything happens on your computer. The router (`src/ai/auto-model.js`) is a pure function: it makes no model call and no network request, reads no page, and logs nothing about what you wrote. It sees only the shape of a request (how long the message is, whether it holds images, which words it uses, how long the chat is) and the list of models you have connected.

## What Auto covers

| Surface | What Auto does |
|---|---|
| Sidebar chat, full-page chat, per-tab chats | One pick (`auto`) saved with the chat and in Settings. Every message is routed afresh; the chat's pick stays Auto. |
| Claude Code | Routes to `claudecode:haiku` / `sonnet` / `opus` / `fable`, passed as `claude --model <alias>`. The engine's own **Claude Code** row (no model chosen) already did this per message (`src/features/model-route.js`, Settings → "Pick the Claude Code model for me"); both use the same scoring. |
| Grok Build | Routes among the models `grok models` lists, passed as `grok --model <id>`. With no list, its own `default` row is used (no flag: Grok chooses). |
| Antigravity | Routes among the slugs `agy models` lists, passed as `agy --model <slug>`. With no list, its `default` (no flag). |
| Codex | Routes among the models Codex lists for your account (`codex exec -m <id>`), (`codex debug models`, else its cached list), or the documented ones (GPT-6.1 Sol, GPT-6 Astra, GPT-6 Luna, GPT-5.6 Sol) when it lists none. With no list, its `default` row is used (no flag: Codex chooses). |
| API providers: Anthropic, OpenAI, Grok (xAI), Gemini, OpenRouter (and any model reached through it) | Routes among the models listed for each key. The request carries the concrete model id. |
| Background tasks and routines | "Auto" is offered first in the task and routine model pickers. Each run is routed to one of the connected **API** models (a CLI engine's tools differ, so a CLI is picked by hand). |
| Page translation, tab-group naming, Organize, "create a skill from this chat" | These one-shot jobs use the cheapest fit (the `classification` / `quick` kind) when your pick is Auto. |
| Skills with their own model | A skill may be set to Auto too. |
| Muse widget (new tab) | Left out: it calls Meta's one model family with its own key, and its three versions are not tiers (the newest is already the default). |
| MCP tools (`mcp.js`, the automation server) | Left out: none of them takes a model; the outside agent brings its own. |

## Where the choice is shown

- The reply is labelled **Auto · Claude Haiku 5.5**; hover for the reason, which names the situation ("Auto: Sonnet 5.5 for a multi-step browsing task", "Auto: Haiku 5.5 for a quick reply").
- The picker's Auto row says what Auto chose last in the open chat ("Auto · Haiku 5.5"), with the reason as its note. It stays selected.
- A quiet note appears when Auto changes model mid-message (see Escalation).
- The usage log, the context bar, the chat's cost line and the AI status card all record the **concrete** model that ran, never "auto".

## How Auto chooses

1. **Tier of each model.** Fast (Haiku, mini, nano, flash, lite), balanced (Sonnet, GPT-4o, an engine's own default), strong (Opus, Fable, GPT-5, o3, Pro, reasoning models). An option can carry its own `tier` (a catalog or engine that knows better); otherwise it is read from the model's name.
2. **What the request needs: its situation first, then how hard it is.** Difficulty alone is a poor guide ("check out my cart" is short but must not misclick; "summarize this long page" is long but cheap), so each message is first sorted into one of twelve situations (see [By situation](#by-situation)) from its wording and what Lumen already knows (attached images and tabs, whether it is about the page in view, the chat so far). The situation sets a floor or ceiling; the wording score (the one `model-route.js` always used: length, steps, code words, stack traces, attached tabs) then moves the tier within it.
   - The one-shot jobs name their kind instead (`quick`, `lookup`, `summary`, `translation`, `classification`, `title`): a fast model. A summary of a very long page (over about 80,000 characters): balanced.
   - A short follow-up ("continue", "yes", "fix it") never drops below the previous turn's tier and keeps its situation; inside a running CLI session the tier never goes down (a different model would lose the prompt cache). A sign-off ("thanks") always goes to the smallest model, unless the CLI session is pinned.
   - A long conversation (over about 120,000 characters) lifts "fast" to "balanced"; a very long one (over about 240,000) lifts everything to "strong".
   - **/think** and **/deep** at the start of a message ask for the strongest model for that message (among the strong ones, the most capable rather than the cheapest); **/fast** asks for the quickest. The command is removed before the message goes anywhere. They work only on Auto: with a model picked, the command asks you to pick Auto first, and a message typed that way goes as typed (Claude Code has a `/fast` of its own).
3. **Which models can answer.** Only models that are connected and signed in; not turned off for Auto (Settings → AI → **Auto may use**); not cooling down after a usage limit, rate limit or outage (the same cooldowns as [model fallback](settings.md#ai-and-agents)); not refused for this account this session ("not available on your plan", no access to the model: Opus-only plans, models gated by plan); able to use tools when the message needs them (chat-only models are skipped); able to see images when the message holds some; with a context window that holds the conversation. A CLI engine is left out while another chat is running, because the CLIs take turns.
4. **Choosing.** The candidate whose tier is nearest the need wins (a stronger model before a weaker one that may not manage it), with two adjustments from the situation: a small model that is not a Haiku counts as one tier too weak for tool-driven work (browsing, research, background tasks), and research and long pages nudge toward the larger context window. Ties go to the provider already answering in the chat, then the one you were on before choosing Auto, then the cheaper (the catalog price when there is one, else the vendor's list price: Opus before Fable, Sonnet before an unknown mid-size model), then the picker's order. The same inputs always give the same answer.
5. **Native defaults.** An engine's own `default` row (Claude Code's, Grok Build's, Antigravity's) is used only when the engine lists no models to choose from. Auto then defers to what the CLI picks: no `--model` flag is passed.

## By situation

What Auto asks for, per situation, and what each engine or provider then gets. "Small / mid-size / strongest" are the tiers (`fast` / `balanced` / `strong`); the reasons are in [Research](#research).

| Situation (how it is recognised) | Tier | Claude Code / Claude API | Codex / OpenAI | Gemini / Antigravity | Why |
|---|---|---|---|---|---|
| **Quick chat, sign-off** ("thanks", "hi", "what time is it") | small | Haiku | GPT-6 Luna | 3.5 Flash-Lite | Nothing to read or do; the cheapest model is as good. |
| **Page question / summary** ("summarize this", a question about the page in view, an attached tab) | small, mid-size when the page is over ~80K characters or the wording is hard | Haiku (Sonnet) | Luna (Sol) | Flash-Lite (3.8 Flash) | Reading comprehension over supplied text is what small models do well; every current model holds 1M tokens, so size only matters for price. |
| **Rewrite / translate** (editing text you gave: "translate", "proofread", "make it friendlier") | small; mid-size above ~1,500 characters | Haiku (Sonnet) | Luna (Sol) | Flash-Lite (3.8 Flash) | Language work on given text, no tools. |
| **Writing new text** (write / draft / compose + email, post, bio, cover letter, essay, report, speech, proposal; a requested length like "1500 words" or "2 pages") | short pieces (an email, a post, a bio, up to ~300 words): small. Long-form or high-stakes (essay, report, article, story, cover letter, proposal, speech, statement, over ~300 words): mid-size. Deep long-form ("in depth", "thorough", "academic"): strongest | Haiku / Sonnet / Opus | Luna / Sol / Astra | Flash-Lite / 3.8 Flash / 3.1 Pro | A short note is easy for any model; what is read by a landlord, a recruiter or a teacher is worth the mid-size model's judgment and structure, and only a demanding piece earns the top tier. |
| **Compare / decide** ("compare", "versus", "pros and cons", "which phone should I buy") | mid-size | Sonnet | Sol | 3.8 Flash | Weighing options against criteria, often with web search; never the smallest. |
| **Browse, one step** ("open youtube", "search for pizza") | small *if reliable at tool use*, else mid-size | Haiku | Sol | 3.8 Flash | Haiku 5.5 is the one small model with a published computer-use score close to the big ones; the other small models step up one tier. |
| **Browse, multi-step** (two or more actions, "then", a form, payment, cart, several tabs) | mid-size | Sonnet | Sol | 3.8 Flash | One misclick in a chain costs more than the price gap; reliability beats size. |
| **Research** ("find sources", "what does the literature say", checking a value against a source: "double check the tables", "verify", "is this right", "look it up"; 3+ tabs) | mid-size; strongest when the wording is deep | Sonnet (Opus) | Sol (Astra) | 3.8 Flash (3.1 Pro) | Synthesis over many sources with tool use; larger window breaks ties. |
| **Code / debugging** (code words, a code fence, a stack trace) | mid-size; strongest for refactors, root causes, multi-file work | Sonnet (Opus) | Sol (Astra) | 3.8 Flash (3.1 Pro) | Sonnet 5.5 leads agentic coding per Anthropic's tables; Haiku is far behind on terminal tasks. |
| **Reasoning / maths** ("solve for x", "derive") | mid-size; strongest for proofs | Sonnet (Opus) | Sol (Astra) | 3.8 Flash (3.1 Pro) | Adaptive thinking models handle routine maths; proofs and olympiad-style problems get the top tier. |
| **Image attached** | small; mid-size for charts, forms, invoices, UI, equations | Haiku (Sonnet) | Luna (Sol) | Flash-Lite (3.8 Flash) | Models that cannot see are skipped; dense visuals need more than a caption. |
| **Picture request** ("draw a logo") | small | Haiku | Luna | Flash-Lite | The chat model only writes the prompt; the picture comes from the image router (`image-router.js`: Grok Build, then Grok, Gemini, OpenAI, OpenRouter). |
| **Background task / routine** | never the smallest | Sonnet | Sol | 3.8 Flash | Nobody is there to correct it. |
| **Anything else** | by the wording score | Haiku / Sonnet / Opus | Luna / Sol / Astra | Flash-Lite / 3.8 Flash / 3.1 Pro | The original behaviour. |

Grok Build and the xAI API follow the same tiers (`grok-4.7-build-fast` small, `grok-build` models mid-size, `grok-4.x` strongest); Antigravity uses the slugs `agy models` lists. OpenRouter models are tiered by name and price. Where several models share a tier, the cheapest wins; if its provider is out of usage or turned off for Auto, the next one answers, then a stronger tier, in the order: the chat's own provider, the one you were on before Auto, then the rest.

### The two kinds of Auto

Both use one classifier (`situationOf` in `model-route.js`) and one tier policy, so the same message is sorted the same way.

| | Cross-provider **Auto** (picker's first row) and each provider's own **Auto** (`openai:auto`, `codex:auto`, ...) | An engine's **Default** row with Settings → AI → "Pick the model for me when I choose an engine's Default" on |
|---|---|---|
| Claude Code | `claudecode:auto`: Haiku / Sonnet / Opus / Fable | `claudecode:default`: `model-route.js` TABLE (haiku / sonnet / opus aliases passed as `--model`) |
| Codex | `codex:auto`: the models `codex debug models` lists (Luna / Sol / Astra) | `codex:default`: the same router limited to Codex's listed models, passed as `-m <id>` |
| Grok Build | `grokbuild:auto`: the models `grok models` lists | `grokbuild:default`: the same, passed as `--model <id>` |
| Antigravity | `antigravity:auto`: the slugs `agy models` lists | `antigravity:default`: the same, passed as `--model <slug>` |
| Claude API, OpenAI, Gemini, Grok (xAI), OpenRouter | `<provider>:auto` | no Default row: a model is always named, or the provider's Auto is picked |

Claude Code's table is fixed because its aliases (`haiku`, `sonnet`, `opus`) are stable. Codex, Grok Build and Antigravity list their models per account and change them often, so they have no fixed table: a Default row asks the router for that engine's Auto each message, and the model ids always come from what the CLI itself lists. If the engine lists no model (or only its default), or all of its models are out of usage, the row is left on the CLI's own default exactly as before (no flag), and the usual model fallback applies. A model you pick is never routed. A running CLI session never goes to a lower tier (the chat remembers the last tier; a Claude Code session also stays on its model until a harder message).

## Research

Compiled 2026-10-09. Vendor pages were fetched that day; benchmark figures are the vendors' own launch tables (no independent cross-vendor benchmark of tool use for these models was found), so they are evidence for the floors above, not proof. Prices are per million input / output tokens.

| Engine | Model (id) | Best at | Speed class | Price in/out | Context | Tool use / vision |
|---|---|---|---|---|---|---|
| Claude Code, Claude API | **Haiku 5.5** (`claude-haiku-5-5`) | High-volume, latency-sensitive: classification, routing, extraction, sub-agent work. OSWorld 2.1 (offline subset) 72.4%, Terminal-Bench 4.0 39.2% | fastest | $0.10 / $0.50 (up to 100K prompt; $0.50 / $2.50 above) | 1M | Tools and vision; thinking adaptive, effort default medium |
| | **Sonnet 5.5** (`claude-sonnet-5-5`) | Everyday coding, agents, enterprise work. OSWorld 2.1 80.1%, Terminal-Bench 4.0 70.6% | fast | $2 / $10 | 1M | Tools and vision |
| | **Opus 5.5** (`claude-opus-5-5`) | Long-running agentic coding and knowledge work. OSWorld 2.1 81.8% | slower (fast mode, API only: ~2.5x tokens/s at $8 / $40) | $4 / $20 | 1M | Tools and vision |
| | **Fable 5.1** (`claude-fable-5-1`) | The most demanding reasoning and long-horizon agentic work; turns can run many minutes | slowest | $10 / $50 | 1M | Tools and vision |
| Codex, OpenAI | **GPT-6 Luna** (`gpt-6-luna`) | Focused, high-volume, cost-sensitive work. OSWorld 2.1 offline 48.9% (Anthropic's table) | fast | $0.10 / $0.50 | 1.05M | Tools and vision (image input) |
| | **GPT-6.1 Sol** (`gpt-6.1-sol`) | Complex work at lower cost than Astra: coding, agents | mid | $2 / $10 | 1.05M | Tools and vision |
| | **GPT-6 Astra** (`gpt-6-astra`) | Complex reasoning and coding, the most capable | slowest | $10 / $50 | 1.05M | Tools and vision |
| Gemini API, Antigravity | **3.5 Flash-Lite**, 3.1 Flash-Lite | Fastest, lowest-cost; high throughput | fastest | about $0.25 / $1.50 (3.1 Flash-Lite, third-party figure) | 1M | Multimodal |
| | **3.5 Flash**, 3.6 Flash | Routine throughput work; balanced multimodal agentic tasks | fast | about $0.50 to $1.50 in (third-party figures) | 1M | Multimodal |
| | **3.7 Flash, 3.8 Flash** | Complex coding, reliable multi-step agents; long-horizon autonomous work | fast | not confirmed | 1M | Multimodal |
| | **3.1 Pro (preview)** | Complex problem-solving, agentic coding | slower | about $2 / $12 (third-party figure; higher above 200K) | 1M | Multimodal |
| Grok Build, Grok API | **grok-4.7** (also 4.6, 4.5) | The most capable Grok | mid | $2 / $6 (cached $0.50) | 500K | not stated on the page; Lumen treats it as able to see |
| | **grok-4.7-build-fast**, grok-build-0.1 | Agentic coding in the Grok Build CLI | fast | grok-build-0.1: $1 / $2 | 256K | |
| | grok-4.3, grok-4.20 (reasoning / non-reasoning / multi-agent) | Earlier flagships, cheaper | mid | $1.25 / $2.50 | 1M | |
| OpenRouter | its catalog | whatever each model's vendor says | by name and price | catalog price | catalog | "chat only" models are skipped for tool work |

Sources and dates:

- Anthropic: the Claude API model table and model notes (cached 2026-10-06) for ids, prices, context, Haiku 5.5 / Sonnet 5.5 / Opus 5.5 / Fable 5.1 positioning, fast mode and effort defaults. Benchmarks as reported from Anthropic's launch tables by Vellum (Sonnet 5.5 benchmarks explained), officechai.com and aicatchup.com (Haiku 5.5), retrieved 2026-10-09.
- OpenAI: developers.openai.com/api/docs/models (2026-10-09) for ids, prices, 1.05M context, 128K output and image input; third-party summaries (datanorth.ai, llmgateway.io, codersera.com, origami.sa) for the Sol and Luna launch (2026-09-22) and positioning.
- Google: ai.google.dev/gemini-api/docs/models (2026-10-09) for the lineup and "best for" lines (it gives no prices or context per model); prices from third-party pages (morphllm.com, aguidetocloud.com, ai-toolbox.co), marked above. The 2.5 models are listed there as "access limited to past users".
- xAI: docs.x.ai/docs/models (2026-10-09) for ids, context and prices.

What is uncertain, honestly: speed is a class (what the vendor's size naming and price imply), not a measured latency, except Anthropic's fast mode multiplier. Tool-use reliability is documented for the Claude models only (Anthropic's own numbers); for GPT-6, Gemini and Grok the router assumes the vendor's "agents" positioning and treats only their smallest models as weaker, which is the one case with a published comparison (Haiku 5.5 vs Luna). The Gemini defaults Lumen uses when a key lists no models are `gemini-3.1-pro-preview` and `gemini-3.8-flash` (the 2.5 models are limited to past users); a model the key lists always wins over them. Claude models from Opus 4.6, Sonnet 4.6 and Haiku 5 on count as 1M-token windows; Haiku 5.5's history is still trimmed at about 100K tokens, where its price rises.

## Escalation and fallback

- **Escalation (once per kind of failure).** If the model Auto chose cannot take the request, the same turn goes on the next best model:
  - too long for it: a model with a larger context window (else a stronger one);
  - it takes no tools: one that does;
  - the account cannot use it ("not available on your plan", "do not have access"): another model at the same tier, and Auto leaves that model out for the rest of the session;
  - it declines the request: one try on a stronger model.
  
  Nothing runs twice: only the failed request is asked again, with the whole history, so tools that already ran are not run again.
- **Fallback.** A usage limit or an outage is handled by [model fallback](settings.md#ai-and-agents) as before (the failed model is left alone for a while and the turn goes on another). On Auto, the next message is routed afresh and the model that was limited is skipped until its reset.

## Auto for one provider

Each provider's group in a model picker (Claude Code, Grok Build, Antigravity, Codex, and Claude, OpenAI, Grok, Gemini and OpenRouter) starts with its own **Auto** row. It is the same router with its choice limited to that provider's models, so you can say "use OpenAI, but pick the model for me".

| Provider | Id | Chooses among |
|---|---|---|
| Claude Code | `claudecode:auto` | Haiku, Sonnet, Opus and Fable (passed as `claude --model <alias>`). Its own **Claude Code** row (no model chosen) keeps working as before. |
| Grok Build | `grokbuild:auto` | the models `grok models` lists (passed as `grok --model <id>`) |
| Antigravity | `antigravity:auto` | the slugs `agy models` lists (passed as `agy --model <slug>`) |
| Codex | `codex:auto` | the models Codex lists for your account (passed as `codex exec -m <id>`): Luna (fast), Sol (balanced), Astra (strong) by default. Its tiers come from the vendor's own size words; `/think` picks the strongest, `/fast` the quickest. |
| Claude (API) | `anthropic:auto` | the Claude models of the API key |
| OpenAI | `openai:auto` | the OpenAI models listed for the key (for example GPT-5.6 and GPT-5.6 mini) |
| Grok (xAI) | `xai:auto` | the Grok API models listed for the key |
| Gemini | `gemini:auto` | the Gemini models listed for the key (for example Pro and Flash) |
| OpenRouter | `openrouter:auto` | the OpenRouter models in the short list and your recent picks (not "More models…" and not OpenRouter's own router) |

- **How it works.** The pick is saved with the chat and in Settings as `<provider>:auto`, exactly like `auto`; the chat's pick stays that Auto and each message is routed again among that provider's models, with the same rules (tiers, what the message needs, escalation). The model that answers is always concrete: the CLIs and APIs never receive "auto", and the usage log, context bar, history labels ("Grok Build:") and the AI status card name the real model.
- **The reply.** Labelled like the main Auto (**Auto · OpenAI · GPT-5.6 mini**); the tooltip names the provider and the reason ("Auto (OpenAI): GPT-5.6 mini for a quick question"). The provider's row in the picker says what it chose last in the open chat.
- **/think, /deep, /fast.** They work with any Auto row selected and pick that provider's strongest or quickest model for that message.
- **Out of usage.** Models of the provider that are cooling down after a limit or outage, or refused for your plan, are skipped. If none is left, it behaves like a model you picked that ran out: with **Switch models automatically** on, the same vendor's other route answers first (Grok Build then the Grok API, Claude Code then the Claude API, Antigravity then Gemini, Codex then the OpenAI API when a key is set), then any connected model, and the chat says "OpenAI is unavailable right now, so Auto uses …". The next message tries the provider again. With the setting off the message fails with "Auto: no OpenAI model is available right now".
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

- `src/features/model-route.js`: the situation of a message (`situationOf`), what it asks of the tier (`applySituation`), the reason (`whyOf`) and the scoring (`tierFor`). `src/ai/auto-model.js`: tiers (`tierOf`), list prices (`costOf`), what a situation asks of a model beyond its tier (`fitCost`), the request's needs (`needFor`), candidate filtering (`candidatesOf`), the choice (`route`), escalation (`escalate`, `failureOf`), the refused-model memory (`createDenied`), `/think` hints (`hintOf`) and the picker row (`pickerEntry`). Provider Auto: the ids (`scopeOf`, `isAuto`, `autoIdOf`), `route`'s `scope`, the provider's rows (`withProviderAutos`, `routableOf`) and the fallback when the provider has nothing left (`routeOrFallBack`). Pure; tested by `test/auto-model-units.js` and `test/auto-provider-units.js`.
- `src/ai/cli-utils.js` (`engineModel`): `claudecode:auto` and the like read as "no model" until Auto has chosen, so a CLI is never asked for a model named "auto".
- `src/ai/agent.js` ("[auto model]"): `routeAuto` at the start of each turn, `escalateFor` in the model loop and the CLI-engine path, and the restore of the pick at the start of the next turn (`autoFrom`).
- `src/main.js` ("[auto model]"): `autoRoute`, `autoEscalate`, `pickerOptions` (Auto first, no heading, then each provider's own Auto leading its group), `effectiveModel` (the default rule), `autoConcrete` (one-shot jobs), `autoProviderList` (Settings).
- `src/features/background-runner.js` and `background-agents.js`: Auto for background tasks (the main Auto: API models only; a provider's own Auto, including Claude Code's and Grok Build's, `runCli`).
- Tests: `auto-model-units` (router), `auto-engines-units` (what each CLI and provider receives), `auto-agent-units` (the turn, restore, escalation, fallback), `auto-situations-units` (situations, what each engine gets, availability, fallback, pinning), `auto-provider-units` (provider Auto: ids, router per provider, picker rows, the turn, warm specs, background list), `grok-warm-units` (a kept Grok process and a changed model), `test/acceptance/chat-auto-provider.js` (real Agent and engines with fake CLIs: `--model`, warm Claude Code processes), `auto-model` (the real app: pickers, persistence, labels, hints, provider Auto).

## Limits

- A chat on Auto that Auto sends to a CLI engine counts as an API chat for the "chats working at once" slots; the router leaves CLI engines out while another chat is running, so two CLI turns never overlap.
- A chat restored after a restart shows the concrete model of each earlier reply but not the reason (the reason is kept for the last message only).
