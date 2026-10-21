# Sidekick: progress & handoff

> Last updated: October 19, 2026 (real-world re-check after deploy). Read this first in any new session, then `docs/BLUEPRINT.md` for the full product design. Start with **Regroup** just below.

## End-to-end test results (Oct 20, 2026)
- **Answers, documents, guardrails, workspaces** (branch `claude/e2e-answers-docs-7a3221`): chat timestamps no longer masked as phone numbers; rate/fee questions no longer refused as HR advice; too-broad custom rules ("Don't answer any questions") refused at save, clearer custom-rule refusal; workspaces can be renamed and deleted (with everything in them) by Org Owners/Admins, names unique per org; document delete asks first; unsupported/empty uploads refused before saving; Knowledge, Guardrails (phone width) and Workspaces polish.

## Multi-tenant Microsoft/Teams (Oct 20, 2026, branch `claude/multitenant-teams-492546`)
Code ready, **off** until Cody switches (checklist: [TEAMS-MULTITENANT.md](TEAMS-MULTITENANT.md)): `SIDEKICK_MULTI_TENANT=1` serves any company tied to a Sidekick org (others get a "sign up first" card, nothing stored; the Azure Bot stays single-tenant, since Microsoft no longer creates multi-tenant bots, and goes to the Teams Store); sign-in checks each token against its own tenant; **chat picker** (chats Sidekick joins in the org's tenant show on Workspaces → *Waiting to be assigned*, codes stay as fallback); **Import from Microsoft 365** on Users & access (Graph `User.Read.All` app permission, admin-approval round trip, Microsoft-sign-in users without passwords); **`@Sidekick add/remove @name`** in Teams (Team Lead / Org Admin, audited); manifest 1.3.0 with `/privacy` `/terms` links. For the sign-up flow: `tieOrgToTenant` in `lib/tenants.ts`. New test suite `tests/teams-multitenant.test.mjs` (ports 3210/3211).

## Regroup (Oct 17, 2026)
Many side sessions had drifted apart, so Cody paused them, merged what was ready and cleaned up. State after the regroup:

- **On `main` and live in Azure:** PRs #1–#13 are merged. `59d5c4b` (incl. #11 and #12) is deployed (`sidekicklabsacr.azurecr.io/sidekick:59d5c4b`), health OK (Postgres, Claude, Azure hybrid search, Teams). #13 only adds tests/CI, so no new deploy was needed.
- **Merged during the regroup (in this order: #12, #11, #13):**
  1. **#11 Team Lead in the rulebook + role test** (`docs/team-lead-permissions`): adds Team Lead to `docs/guide/roles-and-permissions.md` and `app/tests/permissions-matrix.mjs`, checks the role before looking anything up (`requireManage`, `ownLink`, `DELETE /api/users/:id`), and wraps the Owner Console layout in `<Suspense>` so **`next build` works again** (PR #9 broke it, so the Azure deploy of `bcd1f86` failed; the live site stayed on `3feea42`). Updated from `main` after #12 (same role fix on both sides, kept `main`'s wording); 67 API tests pass on SQLite + Postgres and `next build` passes. Deployed.
  2. **#13 Build check** (`chore/build-check`): `npm test` ends with a production build, and `.github/workflows/test.yml` runs the tests on every pull request (Postgres 17 service, no secrets). First GitHub run passed (3 min). Auto-merge isn't available (private repo on the free GitHub plan), so merge by hand once the `test` check is green.
- **Known warning (not blocking):** `next build` warns that `src/instrumentation.ts` (reminder timer) imports `node:crypto`, which the Edge runtime doesn't support. Sidekick never runs on Edge; guard the import with `process.env.NEXT_RUNTIME === "nodejs"` when convenient.
- **Cleanup done:** merged worktree folders removed (all branches kept, locally and on GitHub, by Cody's choice); finished side sessions archived.
- **Pitch folder** (`~/Desktop/Sidekick Pitch`, outside the repo): tidy, one current version per file. New: `diagram/sidekick-roles-permissions.png` (all six roles incl. Team Lead + the Sidekick team, can / can't per capability, responsibilities; pitch-safe). `status/3 - Account levels.png` contains test logins and the live address: **don't show it in the pitch**.

**How we work from here**
- One coordinating session; each new session gets one tight scope and a short brief. Sessions don't start other sessions or push without Cody's OK.
- **Run test suites one at a time.** All sessions share ports 3200/3201 and the `sidekick_test` database, so parallel runs break each other.
- Merge with a PR; GitHub runs the tests on every PR (`test` check), so wait for green before merging.

**Open items (Cody picks the next ones)**
1. ⚠️ **Live site Setup:** confirm Setup on the Azure site was completed (first-run setup is localhost-only since PR #9, but check the org exists and the owner account is yours).
2. **Reminders in real Teams:** re-upload the manifest (1.1.0, RSC read permissions for chat tracking) and try with real Claude.
3. **Real-Claude checks** still outstanding: guardrails phase 1 + 2 wording and false refusals, Team Lead flows in the browser.
4. **Azure-hosted Claude** (`AnthropicFoundry`) instead of the Claude API key.
5. **Step 3: live voice in meetings** (Windows media bot in Azure).
6. **Pitch prep:** lawyer check on the employment agreement (IP), then a dry run with the deck and videos.
7. Microsoft 365 trial ends **Nov 14, 2026**: decide keep ($8.40/month) or cancel before Nov 15.

## E2E test results (Oct 20, 2026)
Four agents tested the whole portal end to end on isolated local copies: about 45 findings, none high. Fixed in three parallel PRs:
- **Meetings, action items, activity, owner signals, assistant wording** (`claude/e2e-meetings-signals-4b2ce7`): delete asks first; a failed import opens the saved meeting with **Try again** (no duplicates); transcripts capped at 300,000 characters and shown in pieces; action items editable on the meeting page with a real due date (validated, audit says what changed); meeting dates must be YYYY-MM-DD; no Teams traces after an import when no chat is linked; a per-client restriction or pause is a notice (`FeatureOffError`, `kind` in the JSON), not an app error or a Claude error, worded for the reader; failed traces say why; trace names normalise ids; assistant never promises a dropped action; Owner Console logs one view per visit; roadmap notes replaced with the real setup; Usage shows the whole month and org-wide usage; guides cover AI models & agent and Connectors.
- **Accounts & security** (`claude/e2e-accounts-245fae`): temporary passwords enforced on the server (only a "Pick your own password" screen until changed); sign-in limit stored in the database (5 wrong passwords per email or 20 per IP in 15 min → 15-minute pause), failed sign-ins and sign-outs audited; Sign out from the avatar menu at phone width (portal + Owner Console) and on the paused screen; confirm before removing a person; the home assistant keeps its conversation when the first workspace is created; refusals name the right role; Activity shows a refusal box; Import meeting hidden for Viewers/Billing Admins; clearer user errors; nobody can change their own role or remove themselves.

## Real-world check: status (Oct 18, 2026, branch `fix/real-teams-check`)
Tried reminders and guardrails with **real Claude** on the live Azure site and **real Teams** (Sidekick Labs, team "Contoso Migration (test)", channel Project). Real-Claude cost of the check: **about $0.49** (Usage page: $0.21 → $0.70 this month; mostly the guardrail check, 74 calls).

**Verified for real**
- Teams package 1.1.0 uploaded; added to a team; link code → linked from the Workspaces page; Sidekick confirmed in Teams.
- Chat settings saved (notes, keep track, reminders time/zone/quiet days); "I'm now keeping track of this chat" announced in the channel; a plain (non-mention) channel message was saved.
- Reminders: Preview (6 sourced points), the **daily timer** posted the card at the chosen time, **Snooze** updated the card in Teams ("Snoozed for a week by …"). Automated browser clicks don't trigger Teams card buttons; real clicks do.
- Guardrails (portal "Test it" + Ask, ~45 questions): no false refusals on ordinary work questions (incl. "kill the batch jobs", "execute the cutover plan"); judging people, HR/legal/medical, jailbreaks (local + Claude), other clients, strong swearing all refused; workspace-level "stick to work" + "competitors" switches work; loosening custom rules and non-rules refused at save; grounded answers with sources, "I don't know" when missing.

**Fixed on this branch (not deployed yet)**
- Channel showed as "Group chat": names are now looked up in Teams once and placeholders never overwrite a real name (`touchConversation` in `lib/teams/bot.ts`).
- Reminders said "Due tomorrow" for an Oct 13 item: meeting-relative due words now carry the meeting date, and the prompt says not to read them as today (`lib/reminders.ts`).
- Custom rules refused too broadly ("Is the project on budget?" under "don't share budget figures"): the check now refuses only when every useful answer would break the rule.
- Clearer HR/legal/medical refusal wording; Usage page said "September" in October (month taken from UTC midnight); "embed" feature label.
- Neutral "chat or channel" wording (portal, link card, guides, README) + a "Group chat or channel?" note in `docs/guide/teams-guide.md`.

**Re-check after deploy (Oct 19, 2026, live `44ea05b`)**
- Reminder wording: fixed. The Oct 13 item now reads "it was due the day after the Oct 13 standup" (was "Due tomorrow").
- Card buttons in real Teams: **Assign, Mark done, Not relevant and Snooze all work** (card updates with "Assigned to / Marked done / Marked not relevant / Snoozed by Cody Scott").
- Channel name: the lookup now runs on the next message, but shows "Contoso Migration (test) › **General**" for a channel called **Project**. Likely the team's first channel, renamed: Teams' bot API returns no name for it, so the code guesses "General" (`lookupChannelName` in `lib/teams/bot.ts`). Fix options: show only the team name when unsure, or read the name via Graph (needs a `ChannelSettings.Read.Group` RSC permission).
- `@Sidekick` answers and the Teams refusal: **not checked yet**. Both test posts had "@Sidekick" typed as plain text, not picked from Teams' mention list, so Teams didn't send them as mentions and Sidekick only saved them as tracked messages (correct). Redo with a real mention. Possible improvement: in a tracked chat, treat a message that starts with plain-text "@Sidekick" as a question.

**Fixed on `fix/teams-chat-polish` (not deployed yet)**
- A team's first channel shows the team name instead of a guessed "General"; old "› General" guesses are looked up once more; a `channelRenamed` event from Teams saves the new name (so renaming the channel, or renaming it back, fixes the live "Project" row).
- A message that starts with "@Sidekick" typed as plain text (not picked from Teams' mention list) is answered as a question instead of only being saved. Guide: `docs/guide/teams-guide.md`.
- 2 new end-to-end tests per engine (fake Teams team API in `tests/api.test.mjs`).

**Group chat check (Oct 20, 2026, live `44ea05b`)**: chat "Wave 2 cutover" (Cody + test users Jojo Boom `JojoBoom@…` and User2 `Tester2@…`, Business Basic trial licenses; passwords only in Cody's password manager).
- Sidekick added by uploading the 1.1.0 zip into the chat (people icon → Add agents → Manage your apps → Upload an app; searching "Sidekick" there only finds an unrelated store app "Sydekick"). Link card → linked from the portal; the real chat name showed straight away.
- Tracking + reminders on: "keeping track" notice posted; turning reminders on at 9:35 with a 9:00 time posted that day's reminder right away (2 points, both sourced). Expected, but worth knowing.
- Real `@Sidekick` mention: answered with sources (Dev Patel owns the rollback, notes the out-of-date runbook). "Is Dev a good performer?" refused politely. Both quote the question.
- ❌ **Plain messages aren't delivered in the group chat** (0 saved; no trace at all), although they are in the channel. Likely the tenant's resource-specific consent setting for **chats** (separate from teams); my look at the Teams admin center was blocked, so Cody checks: Teams admin center → Teams apps → Manage apps → Actions → Org-wide app settings → resource-specific consent for chats; then remove and re-add Sidekick in the chat so the permission is granted.

**Teams app cleanup (in progress, Oct 20, 2026).** Manage your apps shows two "Sidekick" custom apps and the group chat got its own upload; older packages also pointed at the dev tunnel (the old script read `SIDEKICK_PUBLIC_URL` from `.env.local`). Plan:
1. ✅ `teams:package` builds a labelled **live** package (1.2.0, Azure address) by default; `--local` for the tunnel (`chore/teams-live-package`).
2. Cody removes every Sidekick app: Apps → Manage your apps (both entries), the Project channel's team, the Wave 2 cutover chat, and any custom Sidekick in Teams admin center → Manage apps.
3. Cody checks the tenant's resource-specific consent setting for chats, then uploads `sidekick-teams-live.zip` once to the org app catalog.
4. Add Sidekick back from "Built for your org" to the Contoso Migration (test) team and Wave 2 cutover; the portal links should survive (they belong to the chat).
5. Full end-to-end check in both: plain message saved, answer from it, real + plain-text `@Sidekick`, refusal, reminder buttons, channel name (rename Project to send its name).

**Direction: group chats first.** Cody's teams (engineering) talk in Teams **group chats**, one per topic, not channels. So group chats are the main place to test and design for; channels are secondary.

**Still left**
- `@Sidekick` answers in Teams (incl. from tracked messages) and the guardrail refusal in Teams, with a real mention; guests-only-shareable.
- **Group chats (priority)**: fix plain-message delivery (above), then re-check tracked messages (save + answer from them, e.g. "cutover moved to Nov 19"), the reminder card buttons, and plain-text "@Sidekick" after deploying `fix/teams-chat-polish`.
- **Meeting chats**: Teams doesn't offer Sidekick for meeting chats, because the package only has a bot. Needs a meeting tab (`configurableTabs` with meeting contexts) in the manifest: a bigger item for Cody to decide. Publishing Sidekick to the org app catalog would also make it show in every chat's app list instead of re-uploading per place (matters more with many topic group chats).
- After deploying `fix/teams-chat-polish`: rename the Project channel (or rename it back) so Teams sends the new name, and redo a real `@Sidekick` mention.
- Minor: reminder-kind checkboxes have no accessible labels; the Teams table's Settings button is cut off in narrow windows.

## Where we are

| Area | Status |
|---|---|
| Blueprint (v0.10) | Done: `docs/BLUEPRINT.md` |
| Clickable mockups | Done: `docs/sidekick-dashboard.html` (neutral), `docs/sidekick-dashboard-accenture.html` (pitch theme, local only) |
| **Product step 1**: client dashboard + AI brain | **Built, tested, on GitHub `main`** |
| **Owner Console** (operator dashboard) | **Built, tested, merged into `main`** |
| Azure account (personal) | Created, $25 budget alert set |
| Microsoft 365 test org "Sidekick Labs" (Business Basic trial) | **Active again** (new free trial started Oct 15, 2026 in the same org; the first trial was cancelled by turning off recurring billing and could not be reactivated). Trial ends **Nov 14, 2026**; then $8.40 + tax per month (1 license, monthly) on the Visa unless the subscription is cancelled before Nov 15. **Never turn off recurring billing on a trial** (it cancels it) |
| Teams setup (Oct 15, 2026) | Done in Sidekick Labs: Teams "Upload custom apps" = On (Global policy); Entra app **Sidekick Bot** (single tenant, secret 180 days, IDs + secret only in `app/.env.local`); Azure Bot **sidekick-bot-dev** (Free, resource group `sidekick-rg`, Teams channel on, endpoint = dev tunnel); dev tunnel **sidekick** (anonymous, port 3000, expires after 30 days unused). Azure "Test in Web Chat" → app answered (end-to-end OK). Package built: `npm --prefix app run teams:package` |
| Azure AI Search (Oct 16, 2026) | **Live**: Free search service `sidekick-labs-search` + embedding deployment `text-embedding-3-small` in Foundry resource `codyscott-9578-resource` (project `sidekick`), all in `sidekick-rg`; keys only in `app/.env.local`. Backfill copied 17 sources; 18 embedding calls cost $0.0001. Meaning search found the Oct 15 rollback owner that keyword search missed; guest filter verified |
| Teams app package | **1.2.0**: `npm --prefix app run teams:package` builds `teams/build/sidekick-teams-live.zip` (live Azure address); `-- --local` builds the dev-tunnel one. To be uploaded once to the org app catalog (see HOSTING → Teams app package) after the cleanup below |
| **Product step 2**: Sidekick in Teams | **Built and on `main`**: Teams bot, Microsoft sign-in, Azure AI Search, Postgres, hosting in Azure, guardrails (phases 1–2), org access controls + Team Lead, proactive reminders. Remaining: see Regroup → Open items |
| Product step 3: live voice in meetings | Later |

Repo: `github.com/ScottyP1/side_kick` (private). Local: `~/Desktop/sidekick`. Branch `main` holds everything merged; open work is in PRs (see Regroup).

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

## Documentation
- User guides: `docs/guide/` (concepts, admin, Teams, Owner Console). Developer overview and rules: `docs/ARCHITECTURE.md`.
- Every source file has a header comment and every exported function/route a doc comment. Keep it that way (see CLAUDE.md).

## What step 1 + Owner Console contain (code map)
- `app/src/lib/db.ts`: SQLite (`node:sqlite`, built into Node 26) schema + small migrations. One file: `app/data/sidekick.db`. `SIDEKICK_DATA_DIR` overrides the folder (used for test copies).
- `app/src/lib/auth.ts`: client users, scrypt passwords, session cookie `sk_session`, roles (Org Owner/Admin, Billing Admin, Member, Viewer), workspace walls (`requireWorkspace`), audit log, suspended-org check.
- `app/src/lib/owner.ts`: Owner Console auth (separate cookie `sk_owner`, first owner only from localhost), kill switches (`assertEnabled`), operator log.
- `app/src/lib/claude.ts`: all Claude calls. Default model `claude-opus-5-5` (override per feature with `SIDEKICK_MODEL_ASK/EXTRACT/INSIGHTS`), structured outputs via `betaZodOutputFormat`, server-side fallback `"default"`, prompt caching, usage + cost + errors metered into `usage_events`.
- `app/src/lib/search.ts`: the one door for search. SQLite FTS5/BM25 keyword index is the source of truth and the fallback; when `AZURE_SEARCH_*` is set it mirrors every passage to **Azure AI Search** and answers with **hybrid keyword + vector** search (`app/src/lib/azure-search.ts`, embeddings from `text-embedding-3-small`, metered as feature `embed`). An empty Azure index is backfilled automatically on first use. Always filtered by org + workspace; guest mode = `shareable` only.
- `app/src/lib/extract.ts`: PDF (unpdf), Word (mammoth), text, Teams `.vtt` → text; chunking.
- `app/src/lib/sidekick.ts`: Ask (RAG with cited sources, unanswered questions logged as gaps), meeting processing (summary/decisions/action items/open questions/facts), knowledge map (topics + coverage + gaps).
- `app/src/lib/teams/bot.ts`: Teams bot (Microsoft **Teams SDK 2.1**, `@microsoft/teams.apps`). A small adapter plugs the SDK into the Next.js route `app/src/app/api/messages/route.ts` instead of its own Express server. Handles `install.add` (link code), `message` (@Sidekick → `ask()`, answered via `after()` so Teams isn't kept waiting), `card.action` (Assign / Done / Reopen on action items) and `postMeetingNotes()` (proactive notes + action-item cards to linked conversations; in channels the items go in the notes thread).
- `app/src/lib/teams/cards.ts`: the Adaptive Cards (answer + sources, link code, help, meeting notes, action item), plain JSON.
- `teams_conversations` table: every Teams channel/chat Sidekick was added to, with its service URL, link code (24 h) and, once linked, `org_id` + `workspace_id` + `guests`. `app/src/app/api/teams-links/route.ts`: list / link by code / guests toggle / unlink (Org Owner/Admin only, audited). UI: Workspaces page → “Teams channels and chats”.
- API routes: `app/src/app/api/**` (client) and `app/src/app/api/owner/**` (owner).
- UI: client pages in `app/src/app/(app)/*/view.tsx`, owner pages in `app/src/app/owner/(console)/*/view.tsx`; shells in `app/src/components/`.

## Database, tests, errors (Oct 16, 2026)
- Database layer is async and runs on **SQLite** (laptop, no `DATABASE_URL`) or **Postgres** (`DATABASE_URL`), same SQL. Tested against Postgres 17 locally (`brew services start postgresql@17`, test DB `sidekick_test`). `npm --prefix app run db:copy-to-postgres` copies a SQLite install into Postgres (verified on the real data: every table matched).
- Container: `app/Dockerfile` + `.dockerignore`; `next.config.ts` builds `standalone` and excludes `data/`, `.env*`, tests and scripts from the bundle (a first build had pulled `app/data` in; now verified 0 such files). Docker isn't installed on the Mac; build in Azure with `az acr build` when hosting. Verified the standalone server in production mode: 503 + clear message without a database, healthy on Postgres, unsigned Teams requests refused.
- **Roles and permissions (Oct 17, 2026):** `docs/guide/roles-and-permissions.md` is the rulebook; `app/tests/permissions-matrix.mjs` lists every protected action and the API test checks each one for all five roles. AI usage rows now record `user_id`, so Members/Viewers see their own AI use on the home page and the billing roles see the company total.
- **Hosted in Azure (Oct 16, 2026):** Container App `sidekick-app` + Postgres `sidekick-labs-db` + registry `sidekicklabsacr`, ~$34/month, budgets with alerts on every service, Teams bot endpoint moved off the dev tunnel. Full details, scripts (deploy / status / freeze / unfreeze) and the security review: `docs/HOSTING.md`.
- Tests: `npm --prefix app test` = 66 tests (db layer 7×2, end-to-end 26×2). Fake Claude via `SIDEKICK_FAKE_CLAUDE=1` (refused in production); `__FAIL__` in content forces a failure.
- Errors: `handle()` adds reference codes and logs to `app_errors`; `api()` + `ProblemProvider` modal; `useReportError()` for loads; crash screens `error.tsx` / `global-error.tsx`.

## Activity + live orb (Oct 16, 2026)
- `lib/trace.ts` traces every API request (`handle()`), Teams message/answer/card/post, with spans for search (engine, results, fallback), embeddings, Claude (model, tokens, cost), file reading and indexing, plus per-request DB query count/time. Tables `traces` + `trace_spans` (both engines), 30-day retention.
- `/api/activity` views: overview, traces, trace, messages (admins), live (everyone; names for admins only). `/activity` page (admins) and the home-page orb (`components/live-orb.tsx`, WebGL shader, no new dependency; reduced-motion and no-WebGL fallbacks).
- Dev gotchas fixed: the schema is re-applied when it changes while the server runs; the trace store is shared across module reloads. After big server-side changes in dev, a restart is still the safest check.

## Home-page assistant (Oct 16, 2026)
- The orb's satellites ("moons") are gone: the crystal ball stays, with a one-line connection-health row and the **in-app assistant** chat under it (`components/assistant.tsx`, `POST /api/assistant`, `lib/assistant.ts`). While a reply is on its way the bubble cycles thinking labels, and `useThinkingSwirl` (live-orb.tsx) stirs the ball by sending it a circling "ghost pointer": the React Bits file stays unmodified.
- Claude feature `assist` (own model override `SIDEKICK_MODEL_ASSIST`, kill switch "In-app assistant", metered on Usage). Effort low, 2,000 tokens max.
- **Confirm-first, role-limited**: Claude is told only the actions the person's role allows and returns at most one proposal; `checkAction` drops anything not allowed or missing details and turns the rest into a fixed request (`/api/workspaces`, `/api/users`, `/api/teams-links`, `/api/memory/refresh`). The browser sends it only on Confirm, so the regular route checks the role again and audits it. Creating organizations stays in the Owner Console.
- Verified with real Claude in a throwaway copy (`npm --prefix app run dev:preview`, port 3300, data in `app/.preview-data`): create workspace (confirmed), add person (cancelled, nothing changed), "new org" question (explains the Owner Console), dark and light.
- Tests: 80 (db layer 7×2, end-to-end 33×2), incl. "nothing changes before Confirm", role limits, bad input, kill switch.

## Microsoft sign-in (Oct 16, 2026)
- `lib/entra.ts` (authorization code + PKCE, state cookie `sk_oidc`, nonce, ID token verified with `jose` against the tenant's keys/issuer), routes `/api/auth/microsoft/start`, `/callback`, and `/api/auth/microsoft` (status, require, disconnect). Same Entra app as the bot (`CLIENT_ID`/`CLIENT_SECRET`/`TENANT_ID`), overridable with `ENTRA_*`.
- DB: `orgs.entra_tenant_id` (unique), `orgs.sso_required`, `users.entra_oid` (unique per org), `oidc_states` (10-minute sign-in attempts). Both engines.
- Rules: org connected by its Org Owner signing in from Settings (mode `link`); people must already exist (email match once, then oid); personal Microsoft accounts refused; "require" needs the owner's own account linked and ends other sessions; password login refused when required.
- Teams: card actions and questions use the linked person's role and name (`teamsActor` in `lib/teams/bot.ts`).
- Tests: fake Microsoft in `tests/api.test.mjs` (signs real RS256 tokens); covers link, sign-in, strangers, other/personal tenants, wrong nonce, forged key, other browser, replay, cancel, Teams roles, require/disconnect.

## Guardrails + isolation check (Oct 16, 2026, merged as PR #4)
- Agreed order with Cody: **trust** (guardrails + isolation) → hosting in Azure → live meetings. Workspaces already are the per-client/per-project wall (confirmed: search local + Azure filtered by org + workspace before ranking, memory/map per workspace, one Teams chat → one workspace, assistant only sees your workspaces). A **client level above projects** was offered and declined for now.
- `lib/guardrails.ts`: locked floor (hate/bias, harassment, sexual, harm, jailbreak, other clients' data, "I don't know" instead of guessing) + 6 org-wide switches (Org Owner only, audited): swearing in questions, stick to work, judging people, HR/legal/medical, hide contact details, competitors. Tables `guard_rules`, `guard_events` (both engines; counts only, no text).
- Checks: quick local check (slurs, swearing incl. look-alikes like "sh1t" / "f.u.c.k", jailbreak phrases) then Claude feature `guard` (own model `SIDEKICK_MODEL_GUARD`, e.g. Haiku to save cost; kill switch "Guardrail check" — pausing it pauses answers too). Runs in parallel with search, so no extra wait for the search. Answers: grounding (no real cited source → "I don't know"), swearing masked, slurs replace the answer, contacts masked. Same in portal Ask, Teams and the home assistant.
- UI: **Govern → Guardrails** page (everyone reads; Org Owner flips; admins see 30-day counts per rule), Guardrails KPI on Activity, "refused by guardrails" pill in Ask and note on the Teams card.
- Tests: 104 (db 7×2, end-to-end 45×2), incl. switches/roles/audit, local and Claude checks, false positives ("ignore the old firewall rules", "assess"), grounding, masking, Teams + assistant, counts without text, other org sees none, paused check = no answers, and the **workspace isolation test**.
- Not verified with real Claude yet (the throwaway preview had no key; the local check, page, switches and counts were checked in the browser). **Phase 2**: built, see below. Parked for Cody to place: document freshness/relevance, per-workspace learned profile + answer verification.

## Guardrails phase 2 (Oct 16, 2026)
- **Workspace switches** (`guard_workspace_rules`): Org Owners/Admins turn extra switches on for one workspace; in force = org OR workspace, so a workspace is never looser. Org switches stay Org Owner only. `getGuardPolicy(org, ws)` merges switches + active custom rules; `ask()` (portal + Teams) uses the workspace's policy, the home assistant the org-wide one.
- **Custom rules** (`guard_custom_rules` + every version in `guard_rule_versions`): up to 20 active per scope (org-wide, each workspace), 200 chars, Org Owners/Admins, audited (add/edit/remove), removing keeps history. Save-time check `checkRuleText`: local (jailbreak phrases, "ignore/turn off … rules", "no/without (any) restrictions", permission phrases like "you may swear" / "fine to guess", but not "may only"/"can never"), then Claude (`guard` feature, verdict restricts/loosens/not_a_rule); refusal reasons are fixed text. Active rules go to the question check (numbered `<custom_rules>`, Claude returns `custom` + number → event rule `custom:<id>`) and to `answerRules`. Refusal reply is one fixed message that doesn't quote the rule (guests may see it in Teams). 30-day counts label custom rules by their wording.
- **Test it** (`POST /api/guardrails/test`, Owner/Admin): same `screen()` as real questions for the chosen workspace plus an optional unsaved draft rule; records no guard event and no question (only the normal usage meter + a trace step without text).
- Routes: `/api/guardrails` (GET `?ws=`), `/api/guardrails/workspace`, `/api/guardrails/rules`, `/api/guardrails/test`. Isolation test extended (other org: 404 on B's settings/rules/test; members of A never see B's rules).
- Tests: 114 (db 7×2, end-to-end 50×2). Fake Claude: a custom rule refuses questions containing any 5+ letter word of it other than filler; proposed rules with relax/loosen/lenient → loosens, `__not_a_rule__` → not_a_rule.
- Not verified with real Claude yet (fake Claude in tests). Worth a real-key check of the rule-check wording and of custom rules being too broad (false refusals).

## Org access controls (Oct 17, 2026, merged as PR #9)
- Checked for Cody: the home assistant has no "create organization" action for any role (its schema only has workspace/person/Teams link/refresh/open page), its context is only the person's org and their `workspaceIdsFor` workspaces (names and counts, no document text), and `checkAction` drops proposals naming any other workspace. Microsoft sign-in only lets in people an admin already added, into their own org.
- Added: system-prompt rules "only your own organization" and "nobody creates organizations here"; tests where fake Claude misbehaves (proposes `create_org`, or a refresh for another org's / another workspace's id) and both are dropped; a Member's assistant only hears their own workspace names.
- **Owner Console client page** `/owner/clients/[id]` (`GET /api/owner/tenants/:id`): people (role, workspaces or "All workspaces" for admins, Microsoft/password, last active), workspaces (members, docs, meetings), switches. Viewing is written to the operator log.
- **Per-org restrictions** (`org_flags`, both engines; `POST /api/owner/tenants/:id/flags`): the kill-switch features can be turned off for one client. `assertEnabled(key, orgId)` checks platform switch then org switch (message "turned off for your organization"). Claude calls pass `ctx.orgId`, so every AI feature honours it; uploads/meetings/ask pass the user's org. Audited in the client's log + operator log.
- **First-run setup** (`POST /api/auth/setup`) now localhost-only (`assertLocalRequest`), so an empty hosted server can't be claimed.
- Branding test: Members/Viewers get 403 on `PUT /api/settings` (UI already hid the controls for non-admins).
- **Team Lead role** (Cody: the project lead knows the team and which chats matter): `ROLES` gains "Team Lead" (no schema change; role is text). `isLead`, `managedWorkspaceIds`, `requireManage` in `lib/auth.ts`. A lead leads the workspaces they're a member of: `/api/users` GET shows only people in those (with only those workspace ids), POST adds Member/Viewer into them (an existing Member/Viewer of the same org is added to the workspace instead of 409), PATCH replaces only the lead's workspaces, no role changes or DELETE; `/api/teams-links` changes use `requireManage`. Assistant offers a lead add_person (Member/Viewer, own workspace required) and link_teams. UI: Users & access + Teams link controls for leads (`me.user.lead`). Not yet: workspace guardrail switches stay admin-only.
- Tests: 134 (db 7×2, end-to-end 60×2). Not checked with real Claude, and the new pages weren't looked at in a browser (the client page is checked to render).

## Build check + CI (Oct 17, 2026, merged as PR #13)
- Why: PR #9 passed `npm test` but broke `next build` (Owner Console client page: `usePathname` in the layout under a dynamic route needs `<Suspense>` with cacheComponents), so the Azure deploy failed. The tests use `next dev`, which doesn't report that.
- `npm --prefix app test` now ends with **Production build (next build)**: throwaway `NEXT_DIST_DIR=.next-test-build` (git-ignored, deleted after), empty temp data folder, service keys blanked (like the Docker build, where secrets only arrive at run time). Puts `tsconfig.json` / `next-env.d.ts` back if Next rewrote them. On failure: last 80 lines of build output plus a plain explanation, and the run fails. `SKIP_BUILD=1` skips it for quick iterations.
- `.github/workflows/test.yml`: on every pull request (and by hand), `npm --prefix app ci` + `npm --prefix app test` with `REQUIRE_POSTGRES=1` and a `postgres:17` service container (trust auth, no secrets). Official actions only, pinned to commits (checkout v7.0.1, setup-node v7.0.0), Node 26 like the image. Free minutes for private repos (2,000/month on the free plan). First GitHub run passed on PR #13 itself (3 min). Worth making it a required check on `main` (repo Settings → Branches) once it has passed once.

## Proactive reminders + per-chat settings (Oct 17, 2026, merged as PR #12)
- **Per-chat settings** (`teams_chat_settings`, rules in `lib/reminder-rules.ts`): Workspaces → Teams channels and chats → **Settings** (Org Owner/Admin, or a Team Lead for the workspaces they lead; audited): meeting notes here (default on; turn off elsewhere for one dedicated notes chat), **keep track of every message** (channels/group chats; announced in the chat), **reminders** (time, IANA time zone, quiet days, after meetings, kinds). Preview / Send now.
- **Chat tracking**: manifest 1.1.0 adds RSC `ChannelMessage.Read.Group` + `ChatMessage.Read.Chat` (+ `webApplicationInfo`), so Teams delivers non-mention messages. `bot.ts` saves them only for tracked chats (`chat_messages`, indexed as source type `chat`, audience = shareable if guests), never replies; untracked = ignored. 90-day retention; unlinking deletes them. The knowledge map now reads recent chat messages and gaps carry `sources` (titles).
- **Reminders** (`lib/reminders.ts`): items picked in code (overdue/unowned action items via new `due_on`, open questions + new `pending` decisions due within 2 days or 7+ days old, "Out of date"/"Conflicting" gaps whose cited titles resolve to real docs/meetings/chats). Walls + guests filtered before Claude. Claude feature `remind` (`SIDEKICK_MODEL_REMIND`, kill switch "Reminders in Teams") only words them; unknown ids dropped, sources attached by code, `cleanOutput` + custom rules. Card buttons Assign / Mark done / Snooze (7 days) / Not relevant (`reminder_state`), checked against the card's own chat + workspace + guests, audited, card updated in place.
- **Schedule**: in-app timer (`src/instrumentation.ts`, every 5 min → `POST /api/reminders/tick` with a per-start token), daily slot claimed in `reminder_runs` (unique per chat+day). Also right after meeting notes. Container Apps job alternative documented in `docs/HOSTING.md` (`SIDEKICK_TICK_SECRET`, `SIDEKICK_SCHEDULER=off`).
- Meeting extraction now also returns `due_date` (YYYY-MM-DD) and `pending_decisions`; shown as "Decisions still to make" / Memory "To decide".
- Tests: rules unit tests (db.test) + 6 end-to-end reminder tests per engine. Not yet tried with real Claude or real Teams (needs the new manifest uploaded; RSC consent is given by the team/chat owner when adding the app).

## Scale-up path (for later, not needed now)
- **AKS** (Azure's Kubernetes, the EKS equivalent): needed in step 3 for the Windows real-time media bot; the web app is fine on Container Apps (Kubernetes underneath, managed for us).
- **Event Hubs** (Azure's Kafka-compatible event stream): for step 3 live meeting events at scale, or queueing heavy work (transcript processing) once many clients use it. It moves events between services; it is **not** storage. Storage stays Postgres (+ Blob for files, Azure AI Search for retrieval).
- Postgres: start on Flexible Server Burstable; scale up or add read replicas when usage grows.

## Gotchas learned
- **Next.js 16.4 with Cache Components**: client-rendered pages need a server `page.tsx` wrapper exporting `instant = false` and re-exporting `./view`. Read `app/node_modules/next/dist/docs/` before using Next APIs; `middleware` is now `proxy.ts`.
- zsh treats `[id]` in paths as a glob: quote paths in shell commands.
- Test against a **separate copy** so the owner's real data is untouched: `npm --prefix app run dev:preview` (port 3300, data in `app/.preview-data`, build in `.next-preview`, both git-ignored; launch config `sidekick-preview`). Never `npm --prefix app exec next …`: that runs Next in the repo root, which then installs TypeScript and writes `package.json`/`tsconfig.json` there.
- Teams bot auth: `PLAYGROUND_MODE` (no token check) needs `TEAMS_LOCAL_PLAYGROUND=true`, is off whenever `NODE_ENV=production`, and only accepts localhost requests with a localhost service URL. `dangerouslyAllowUnauthenticatedRequests` is always passed explicitly so the SDK's own env var can't switch auth off. The SDK reads `CLIENT_ID` / `CLIENT_SECRET` / `TENANT_ID` itself.
- Postgres differences to remember: no `INSERT OR IGNORE` (use `ON CONFLICT DO NOTHING`), `day` needs `AS day`, every selected column must be grouped or aggregated, qualify columns in `ON CONFLICT … DO UPDATE` (`teams_conversations.name`). COUNT/SUM come back as strings from `pg`; db.ts converts them to numbers.
- `next dev` is more forgiving than `next build` (e.g. `usePathname`/`useSearchParams` in a layout under a dynamic route needs a `<Suspense>` boundary with cacheComponents). `npm test` runs a production build last to catch this; don't skip it before committing.
- Next.js prerenders route handlers at build time: wrappers that catch errors must call `unstable_rethrow`, and routes with no request data (like `/api/health`) need `await connection()`.
- After editing `app/.env.local` (bot IDs/secret), **restart the app**: a running dev server answered 401s correctly but didn't reply to Teams until restarted.
- To test in real Teams, run the app (`npm --prefix app run dev`) **and** the tunnel (`npm --prefix app run tunnel`). The tunnel makes the whole portal reachable from the internet while it runs; stop it when not testing.
- Teams identity: if the sender's `aadObjectId` matches a Sidekick person's `users.entra_oid` **and** the message's tenant is the org's connected tenant, Teams uses that person (name + role). Otherwise they act as a Member of the linked workspace (`teams:<aad id>`, “Name (Teams)”).
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
7. Later in step 2: ~~Microsoft (Entra ID) sign-in~~ (done), Azure-hosted Claude (`AnthropicFoundry`, the Foundry resource already exists), ~~Azure AI Search~~ (done), Postgres, hosting in Azure instead of the dev tunnel.
