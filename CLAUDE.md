# Sidekick

AI teammate for Microsoft Teams: personal project of Cody Scott. **Read `docs/PROGRESS.md` first** (status, code map, gotchas, next steps); full design is in `docs/BLUEPRINT.md`.

- App: Next.js 16.4 (React) in `app/`. Run with `npm --prefix app run dev`. Read `app/AGENTS.md` and the bundled Next docs before using Next APIs.
- Claude calls go only through `app/src/lib/claude.ts` (default `claude-opus-5-5`, per-feature override via env).
- Search goes only through `app/src/lib/search.ts` (local keyword index as source of truth/fallback; Azure AI Search hybrid when configured).
- Database calls go only through `app/src/lib/db.ts` (`await all/get/run/tx`, `?` placeholders). SQL must run on **both** SQLite and Postgres (`app/db/schema.postgres.sql` mirrors the SQLite schema); no SQLite-only syntax (`INSERT OR`, bare `day` alias, selecting non-grouped columns).
- Run `npm --prefix app test` before committing (168 tests, both engines, then a production `next build`; needs local Postgres: `brew services start postgresql@17`). The build step matters: the tests run `next dev`, which lets through errors that break `next build` and so the Azure deploy (e.g. a missing `<Suspense>` under cacheComponents). GitHub Actions runs the same suite on every pull request (`.github/workflows/test.yml`). Add tests for new behaviour.
- New kinds of work get a trace step: wrap it in `span(kind, name, fn, attrs)` from `app/src/lib/trace.ts` (timings/counts/models only, never document text) so it shows on the Activity page and the home orb.
- Nothing fails silently: API routes use `handle()`; pages use `api()` and `useReportError()` (never `.catch(() => {})`).
- Every data query must stay scoped to the user's org and workspace (`requireWorkspace`); extend the isolation test in `app/tests/api.test.mjs` when adding a new surface.
- Anything that answers people (portal, Teams, assistant) goes through `app/src/lib/guardrails.ts` (`screenQuestion` before, `cleanOutput`/`checkGrounding` after).
- Test with a separate data folder (`SIDEKICK_DATA_DIR`) so Cody's real local data is never touched.
- Documentation is part of every change (Cody wants it thorough, for shipping): each file gets a header comment, each exported function/type/route a doc comment explaining what it does, who may call it and the concepts involved; user-visible changes also update `docs/guide/`. Conventions in `docs/ARCHITECTURE.md`.

Ground rules: personal accounts and made-up sample data only (nothing from Accenture or real clients), keep the GitHub repo private, never ask for or handle passwords or API keys in chat (the Claude key lives in `app/.env.local`). Explain things in plain language; Cody prefers short, practical answers.
