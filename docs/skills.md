# Skills

A skill is a saved set of instructions for a task you do often. Type `/` in the sidebar or the full-page chat to run one (`/summarize`, `/translate French`), or right-click selected text on a page → **Run skill**. Manage them in Settings → AI and agents → **Skills**.

A skill is only text. Running it sends an ordinary chat message, so the usual approval cards apply. A skill can never turn approvals off or give the AI new permissions.

## SKILL.md: skills you can share with other agents

Lumen reads and writes the [Agent Skills](https://agentskills.io) format that Claude Code, Cowork and other agents use. A skill is a folder holding a `SKILL.md` file:

```markdown
---
name: export-csv
description: Export the table on the page as CSV.
---

Find the table with read_page, then give it as CSV with a header row.
```

- **Import SKILL.md…** (Settings → Skills) takes a skill folder or its `SKILL.md`. As with a JSON skills file, you see a review first: the full text, what it may do, and the files it leaves out. Nothing is saved until you click **Import selected**.
- **Export SKILL.md…** on a skill writes `<the folder you pick>/<name>/SKILL.md`. An existing `SKILL.md` there is never overwritten. Lumen's own options (title, what it may do, page contexts, model) go under `metadata` as `lumen-*` keys. Other agents ignore these keys, and Lumen reads them back when you import the file again.
- Lumen's command names are at most 32 characters. A longer name is shortened on import, and the review tells you.
- Instructions longer than 8,000 characters are refused on import.

**Instructions only.** A Lumen skill is text for the AI. Lumen reads only `SKILL.md`. Scripts (`scripts/*.py`, `.sh`, `.js` and so on), references and assets in the folder are never read and never run. The import review lists them as left out.

### Use my Claude Code skills

Settings → Skills → **Use my Claude Code skills** (off by default) lists the skills in `~/.claude/skills/<name>/SKILL.md` as read-only `/` commands. Claude Code's `$ARGUMENTS` becomes what you type after the command. Lumen reads each `SKILL.md` and nothing else in the folder. To change these skills, edit them in Claude Code. A skill whose name a Lumen skill or chat command already uses is left out, and Settings says so. Settings also lists any `SKILL.md` that could not be read, with the reason.

## The AI using skills on its own

You don't have to type a command. Tick **AI can use this on its own** in a skill's editor. When a new chat starts, its system prompt lists those skills with their name and one-line description. The list holds at most 20 skills and 2,000 characters. When your request matches one, the AI calls `use_skill` to load that skill's instructions and follows them. You see this as a step: "Using your skill …". Like custom instructions, the list is fixed for the whole chat, so a change applies from the next new chat.

- **Let the AI use skills on its own** (`skillsAutoUse`, on) is the master switch. Turn it off and skills run only from `/`.
- Built-in skills start with **AI can use this on its own** off. The AI already summarizes, explains and translates without them, and listing them would add to every chat's prompt for nothing. You can turn it on for any of them.
- Imported skills (JSON or SKILL.md) always start with it off.
- Claude Code skills are listed for the AI too, while **Use my Claude Code skills** is on.
- `use_skill` is offered to the sidebar's API chats (Claude by key, OpenAI, Gemini, Grok, OpenRouter). Claude Code, Codex, Grok Build, Antigravity and outside MCP clients have skills of their own and don't get it.
- A loaded skill only adds instructions. The AI still asks before acting on a new site, and sites with AI off stay off.

## Learning from what you do (opt-in)

Settings → Skills → **Offer to save and improve skills** (`skillsSuggest`, off) adds two small cards under a reply. Neither saves or changes anything until you click.

- **Save how I did this as a skill?** appears after a run that ended well and took 8 or more tool steps, if it didn't already use a skill. **Draft a skill** follows the same path as `/create-skill`, with the steps the run took. The model writes a draft, and the skill editor opens in Settings for you to review, edit and save.
- **Update the skill with what changed?** appears when you used a skill (by `/` or the AI's `use_skill`) and then corrected the result with a follow-up such as "no, shorter" or "use semicolons instead". **Show the change** asks the model for a revised prompt. Settings then shows the old and new text as a line diff with **Accept the change** and **Keep it as it is**. Accepting changes only the prompt, and nothing happens if the skill was edited in the meantime. Claude Code skills are read-only, so they are never offered an update.

Writing a draft or a revision is one model call to the AI you chat with (the same one as `/create-skill`). It receives the last exchange, the tool names and, for an update, the skill's prompt and your corrections.

## Where skills are kept

`skills.json` in the profile folder. Claude Code skills stay in `~/.claude/skills` and are only read.
