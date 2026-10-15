# Sidekick: progress & handoff

> Last updated: October 15, 2026. Read this first in any new session, then `docs/BLUEPRINT.md` for the full product design.

## Where we are

| Area | Status |
|---|---|
| Blueprint (v0.10) | Done: `docs/BLUEPRINT.md` |
| Clickable mockups | Done: `docs/sidekick-dashboard.html` (neutral), `docs/sidekick-dashboard-accenture.html` (pitch theme, local only) |
| **Product step 1**: client dashboard + AI brain | **Built, tested, on GitHub `main`** |
| **Owner Console** (operator dashboard) | **Built, tested, merged into `main`** |
| Azure account (personal) | Created, $25 budget alert set |
| Microsoft 365 test org "Sidekick Labs" (Business Basic trial) | Created but **cancelled by mistake** (turning off recurring billing on a *trial* cancels it). Needs Reactivate (may take 15–30 min), Microsoft support, or a fresh trial. **Leave recurring billing ON**; cancel before Nov 14, 2026 if not keeping it (worst case $8.40 for one month) |
| Teams custom-app upload | Not done yet; needs the M365 subscription active first |
| **Product step 2**: Sidekick in Teams | **Bot built and tested locally in Agents Playground** (branch `feat/teams-bot`). Next: Azure Bot registration, manifest, dev tunnel, real Teams |
| Product step 3: live voice in meetings | Later |

Repo: `github.com/ScottyP1/side_kick` (private). Local: `~/Desktop/sidekick`. Branch `main` holds everything.

## Ground rules (from the owner)
- Personal project on Cody's **own Mac, own GitHub, own Claude key**; nothing linked to Accenture. Use **made-up sample data only** (see `samples/`). Repo stays **private**.
- Cody will pitch Sidekick to Accenture (IT consulting / software engineering). Advised to check the employment agreement (IP / invention assignment) with a lawyer before pitching.
- Product decisions: **no corrections** of people (Sidekick answers, recalls and asks; raises a *virtual* hand); Microsoft-native Teams app; **all-Azure** for production (Claude via Microsoft Foundry, Azure AI Speech, AI Search, Postgres, Blob); client workspaces walled off; pricing not decided.
- Never ask for or handle passwords/API keys in chat. The Claude key lives in `app/.env.local` (git-ignored, chmod 600).

## How to run
```bash
npm --prefix app run dev
```
- Client portal: http://localhost:3000 (first visit = organization setup)
- Owner Console: http://localhost:3000/owner (first visit = owner account, localhost only)
- Demo script: `README.md`

## What step 1 + Owner Console contain (code map)
- `app/src/lib/db.ts`: SQLite (`node:sqlite`, built into Node 26) schema + small migrations. One file: `app/data/sidekick.db`. `SIDEKICK_DATA_DIR` overrides the folder (used for test copies).
- `app/src/lib/auth.ts`: client users, scrypt passwords, session cookie `sk_session`, roles (Org Owner/Admin, Billing Admin, Member, Viewer), workspace walls (`requireWorkspace`), audit log, suspended-org check.
- `app/src/lib/owner.ts`: Owner Console auth (separate cookie `sk_owner`, first owner only from localhost), kill switches (`assertEnabled`), operator log.
- `app/src/lib/claude.ts`: all Claude calls. Default model `claude-opus-5-5` (override per feature with `SIDEKICK_MODEL_ASK/EXTRACT/INSIGHTS`), structured outputs via `betaZodOutputFormat`, server-side fallback `"default"`, prompt caching, usage + cost + errors metered into `usage_events`.
- `app/src/lib/search.ts`: keyword search (SQLite FTS5/BM25), always filtered by org + workspace, guest mode excludes `internal` docs. **To be replaced behind the same functions by Azure AI Search (hybrid keyword + vector) in step 2.**
- `app/src/lib/extract.ts`: PDF (unpdf), Word (mammoth), text, Teams `.vtt` → text; chunking.
- `app/src/lib/sidekick.ts`: Ask (RAG with cited sources, unanswered questions logged as gaps), meeting processing (summary/decisions/action items/open questions/facts), knowledge map (topics + coverage + gaps).
- `app/src/lib/teams/bot.ts`: Teams bot (Microsoft **Teams SDK 2.1**, `@microsoft/teams.apps`). A small adapter plugs the SDK into the Next.js route `app/src/app/api/messages/route.ts` instead of its own Express server. Handles `install.add` (link code), `message` (@Sidekick → `ask()`, answered via `after()` so Teams isn't kept waiting), `card.action` (Assign / Done / Reopen on action items) and `postMeetingNotes()` (proactive notes + action-item cards to linked conversations; in channels the items go in the notes thread).
- `app/src/lib/teams/cards.ts`: the Adaptive Cards (answer + sources, link code, help, meeting notes, action item), plain JSON.
- `teams_conversations` table: every Teams channel/chat Sidekick was added to, with its service URL, link code (24 h) and, once linked, `org_id` + `workspace_id` + `guests`. `app/src/app/api/teams-links/route.ts`: list / link by code / guests toggle / unlink (Org Owner/Admin only, audited). UI: Workspaces page → “Teams channels and chats”.
- API routes: `app/src/app/api/**` (client) and `app/src/app/api/owner/**` (owner).
- UI: client pages in `app/src/app/(app)/*/view.tsx`, owner pages in `app/src/app/owner/(console)/*/view.tsx`; shells in `app/src/components/`.

## Gotchas learned
- **Next.js 16.4 with Cache Components**: client-rendered pages need a server `page.tsx` wrapper exporting `instant = false` and re-exporting `./view`. Read `app/node_modules/next/dist/docs/` before using Next APIs; `middleware` is now `proxy.ts`.
- zsh treats `[id]` in paths as a glob: quote paths in shell commands.
- Test against a **separate copy** so the owner's real data is untouched: `SIDEKICK_DATA_DIR=<tmp> NEXT_DIST_DIR=.next-test npx next dev --port 3100` (then revert any `tsconfig.json` include lines Next adds, delete `.next-test`).
- Teams bot auth: `PLAYGROUND_MODE` (no token check) needs `TEAMS_LOCAL_PLAYGROUND=true`, is off whenever `NODE_ENV=production`, and only accepts localhost requests with a localhost service URL. `dangerouslyAllowUnauthenticatedRequests` is always passed explicitly so the SDK's own env var can't switch auth off. The SDK reads `CLIENT_ID` / `CLIENT_SECRET` / `TENANT_ID` itself.
- Teams users are not portal users yet: in a linked conversation they act as a Member of that one workspace (`teams:<aad id>` in `questions.user_id`, “Name (Teams)” in the audit log). Map them to real users with Entra ID sign-in later.
- `npm --prefix app run dev:teams` + `npm --prefix app run playground` = local Teams test on port 3100 with `app/.playground-data` (see README). Playground writes `app/devTools/` logs (git-ignored).
- Teams dev: Microsoft 365 Developer Program sandbox **denied** ("don't currently qualify"), the normal outcome in 2026. Business Basic trial used instead.
- Production media bot (step 3) **must be hosted in Azure** on Windows (C#/.NET). Graph has **no raise-hand API**, so use a virtual hand-raise (chat card + side panel).

## Next: product step 2 plan (Sidekick in Teams)
1. ~~Teams bot endpoint `/api/messages` (Teams SDK 2.1)~~ Done.
2. ~~@Sidekick answers via `ask()` for the linked workspace, Adaptive Card with sources~~ Done.
3. ~~Link Teams channels to workspaces (table + Workspaces page UI)~~ Done (link code flow).
4. ~~Post meeting notes + action-item cards (Assign / Done) after import~~ Done.
5. ~~Test locally with Microsoft 365 Agents Playground~~ Done (answers, notes, Assign/Done, workspace wall checks).
6. ~~Teams app manifest (v1.30) + icons + `teams:package` script~~ Done (`teams/`, passes 62 Agents Toolkit checks). Still to do with the trial active: create the Entra app **in the Sidekick Labs tenant** + free **Azure Bot** (single tenant); dev tunnel `sidekick` (steps in README “Sidekick in real Teams”); upload as a custom app to the Sidekick Labs Teams (after custom apps are allowed). Put `CLIENT_ID` / `CLIENT_SECRET` / `TENANT_ID` in `app/.env.local` and run the normal `dev` (not `dev:teams`): over a tunnel Playground mode refuses requests anyway. Manifest bot scopes: `personal`, `team`, `groupChat`. Set `SIDEKICK_PUBLIC_URL` for the card links.
7. Later in step 2: Microsoft (Entra ID) sign-in, Azure-hosted Claude (`AnthropicFoundry`), Azure AI Search, Postgres.
