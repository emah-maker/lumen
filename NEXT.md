# projects-v2: state when paused

## Done (uncommitted before this WIP commit; nothing pushed, no PR)
- src/ai/project-context.js (index block, search, project_files tool logic), src/features/project-files.js (extract PDF/docx/pptx/eml/text/images, encrypted per-project store).
- chat-store: project links, defaults, projectSnapshot/restoreProject (Undo), adoptProject (sync); memory.js scoped by project (dropProject/restoreEntries).
- agent.js: PROJECT_TOOL (project_files), offered to API chats and to CLI runs via ai-agents.js runTools; project connector/MCP switches; plan-mode allows it.
- main.js: projectSettingsFor/projectBlockFor, IPC chats:project-get/files-add/file-remove/search/link/add-tab/memory-forget/defaults/undo, tab menu "Add to project", new-chat default model, chip data in chatView.
- Sync: projects + project-files providers (sync-providers/sync-folder/main).
- Renderer: chat-project-page.js/.css (lazy), chip + "Add this tab" in chat-page.js, "Open project" in chat-projects.js, plan default in plan-mode.js; en.json strings.
- Tests: test/project-workspace-units.js (passes), test/project-workspace.js (Electron; last run 6 failures, fixed by switching to UI "New chat here" helper + chat-page broadcast; NOT re-run).

## Left
1. Re-run test/project-workspace.js via e2e-lock (env LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1), fix any failures.
2. Run: chats, chatpage, memory, skills, sync units, hardening, perf-budget (module count <= 341), mcp-tokens-units, chat-prompt-budget (16493/16500 before), ui-consistency, node scripts/test-units.js, eslint on changed files.
3. node scripts/bundle-renderer.js (plan-mode.js changed) and commit bundles.
4. Screenshots (projects page, project chat) into scratchpad projects-v2/.
5. Docs: CHANGELOG, docs/ page + README, PRIVACY.md (files kept encrypted locally, text reaches the AI provider only when read), settings doc if needed.
6. Merge origin/main, push, PR, node scripts/land.js <pr>. Do not release.
7. Not built: lumen://projects URL (page lives inside lumen://chat), effort default (effort-picker not merged), file drag from outside via OS path.
