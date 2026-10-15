# Sidekick

AI teammate for Microsoft Teams: personal project of Cody Scott. **Read `docs/PROGRESS.md` first** (status, code map, gotchas, next steps); full design is in `docs/BLUEPRINT.md`.

- App: Next.js 16.4 (React) in `app/`. Run with `npm --prefix app run dev`. Read `app/AGENTS.md` and the bundled Next docs before using Next APIs.
- Claude calls go only through `app/src/lib/claude.ts` (default `claude-opus-5-5`, per-feature override via env).
- Search goes only through `app/src/lib/search.ts` (keyword today; Azure AI Search later behind the same functions).
- Every data query must stay scoped to the user's org and workspace (`requireWorkspace`).
- Test with a separate data folder (`SIDEKICK_DATA_DIR`) so Cody's real local data is never touched.
- Documentation is part of every change (Cody wants it thorough, for shipping): each file gets a header comment, each exported function/type/route a doc comment explaining what it does, who may call it and the concepts involved; user-visible changes also update `docs/guide/`. Conventions in `docs/ARCHITECTURE.md`.

Ground rules: personal accounts and made-up sample data only (nothing from Accenture or real clients), keep the GitHub repo private, never ask for or handle passwords or API keys in chat (the Claude key lives in `app/.env.local`). Explain things in plain language; Cody prefers short, practical answers.
