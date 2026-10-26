# How Sidekick's code fits together

For developers. User-facing guides are in [guide/](guide/README.md); status and next steps in [PROGRESS.md](PROGRESS.md); the full product design in [BLUEPRINT.md](BLUEPRINT.md).

## The pieces

```
Browser (client portal, Owner Console)        Microsoft Teams
            │  fetch /api/*                         │  Azure Bot Service
            ▼                                       ▼
   ┌──────────────── Next.js app (app/) ─────────────────────┐
   │  app/src/app/api/**/route.ts   app/src/app/api/messages │
   │        │                              │                 │
   │        ▼                              ▼                 │
   │  lib/auth.ts  (who, role, workspace wall)   lib/teams/bot.ts
   │        │                              │                 │
   │        ▼                              ▼                 │
   │  lib/sidekick.ts  ── ask / processMeeting / refreshInsights
   │     │                    │                              │
   │     ▼                    ▼                              │
   │  lib/search.ts        lib/claude.ts ──► Claude API      │
   │     │                    │                              │
   │     ▼                    ▼                              │
   │  lib/db.ts  (SQLite: app/data/sidekick.db)              │
   └─────────────────────────────────────────────────────────┘
```

| File | Job |
|---|---|
| `lib/db.ts` | The async query API (`all`, `get`, `run`, `tx`) over SQLite (laptop) or Postgres (`DATABASE_URL`); SQLite schema + migrations. Every table with client data has `org_id` and usually `workspace_id`. Also the org scope behind Postgres row-level security (`withOrg`, `asSystem`, `setScopeOrg`; see "Row-level security" below) |
| `db/schema.postgres.sql` | The Postgres schema, mirroring the SQLite one |
| `lib/auth.ts` | Sessions, roles, `requireUser` (also blocks everything but the password change while a temporary password is pending), `requireWorkspace` (the workspace wall), audit log |
| `lib/login-limit.ts` | Sign-in rate limit: failed password sign-ins per email and per IP, stored in `login_failures` (works across several app copies) |
| `lib/security.ts` | Small security checks with no I/O, unit-tested: one-time setup rule (`SIDEKICK_SETUP_CODE` in production), the cross-site request (CSRF) check `handle()` runs on every change, Word "zip bomb" size check, prompt tag escaping |
| `lib/flash.ts` | One-time messages from a server redirect to the page (Microsoft sign-in errors), in a short-lived cookie instead of the address |
| `lib/entra.ts` | Microsoft (Entra ID) sign-in: the round trip to Microsoft (PKCE, state, nonce) and ID-token verification (issuer checked per tenant; single-tenant mode also checks the tenant) |
| `lib/tenants.ts` | Single- vs multi-tenant mode (`TENANT_ID`), which Sidekick org a Microsoft tenant belongs to, `tieOrgToTenant` (also for the sign-up flow) |
| `lib/directory.ts` | The customer's Microsoft 365 directory via Microsoft Graph (app permission `User.Read.All`): admin-consent round trip, search, import as Microsoft-sign-in people |
| `lib/graph-permissions.ts` | Settings → Microsoft permissions: every Graph permission Sidekick asks for, what it unlocks, approved or not (Check now reads the app token's `roles` claim; recorded refusals) |
| `lib/plans.ts` | The plans (Starter/Team/Business for sale, Enterprise set up by the team), priced **per organization by groups**, with every limit (people, groups, tracked chats, meeting hours, documents, connectors, monthly AI credit); `EXTRA_GROUP` and `limitsWithExtras`/`monthlyPrice`; `groupOptions` (extra groups vs upgrade, cheaper first); trial/grace lengths, `accessFor` (full or read-only) and `withRolloff` (a pending deletion on top), `limitState`, `parseCustomLimits`, `transcriptMinutes`. Pure, shared by pages and server, unit-tested |
| `lib/brand.ts` | **The single brand setting**: product name, short name, tagline, support email, logo paths, accent. Every page title, shell, Teams card, notice, certificate, the help bot and the Teams manifest (`scripts/teams-manifest.mjs`) read it; no imports, safe anywhere. Code identifiers, tables, cookies, env vars and Azure names are not renamed by it |
| `lib/rolloff.ts`, `lib/rolloff-policy.ts` | Roll-off: a group ending (read-only via `requireWorkspace`, chats unlinked and relinked on cancel, not counted toward the limit) or an organization leaving (read-only grace via `orgAccess`), the scheduled deletion on the job queue (`runDueRolloffs`, claimed scheduled → running), `deleteOrganization` (`ORG_TABLES`), deletion certificates (counts only; text/PDF). The policy file holds the day counts for pages and the FAQ |
| `lib/export.ts`, `lib/zip.ts`, `lib/pdf.ts` | Data export as a zip (a group, or the whole organization), built with Node's zlib; a tiny text-PDF writer for certificates |
| `lib/request-scope.ts` | Whether the running API request changes something (set by `handle()`), so `requireWorkspace` keeps ending groups read-only for every route |
| `lib/limits.ts` | Plan limits: effective limits (plan + extra groups + the Sidekick team's custom terms in `org_terms`), what's used (ending groups not counted), `assertCanAdd` (402 `kind: "limit"`; for groups also `options` and `need` for the upgrade prompt) called where each thing is created, `limitReport` (near / over), `saveTerms`; plan features: `assertFeature` (402 `kind: "limit"` with `feature` and `plan`) where each is newly switched on, `orgFeatures`/`hasFeature`, `featureReport` (included / in use) |
| `lib/credit.ts` | The monthly AI credit: this month's cost vs the plan's credit (+ top-ups), 30-second cache updated by every call, 80% notice, 100% "essentials only" (`creditGate`: cheaper models for answers/checks/short notes, `FeatureOffError("credit")` for the extras), `skipCredit` opt-out, `grantTopUp` |
| `lib/firm-usage.ts` | **What a firm may see of its AI use**: activity counts (`activityCounts`: questions, meetings written up, documents, reminders sent, assistant replies), the AI allowance as a percent (`allowanceOf`), limit lines without the dollar AI credit (`firmLimits`, `withoutAiDollars`), trace attributes without models/tokens/cost (`firmAttrs`, `OPERATOR_ONLY_KEY`), and the usage CSV (`usageCsv`; `withCost` only for the Owner Console) |
| `lib/rate-limit.ts` | Per-person rate limits stored in `rate_events` (works across app copies): questions per hour in `ask()` |
| `lib/ops.ts` | What the app knows about itself for the Owner Console: health facts (as `/api/health`), build and release (`SIDEKICK_COMMIT`, `SIDEKICK_RELEASED_AT`), releases seen (`app_releases`) |
| `lib/billing.ts` | Subscriptions (`subscriptions` table, incl. `extra_groups`) behind a billing provider: `mock` (test mode, no payment details ever) now, Stripe later (documented in the file). Pay, change plan, extra groups, cancel (starts the organization's roll-off; paying again stops it), simulate a failed payment, operator changes; `orgAccess` (subscription + pending roll-off), `readOnlyRefusal` (used by `handle()`) |
| `lib/signup.ts` | Self-service sign-up: org + Org Owner + trial in one transaction, the `signup` switch (**off by default**; opened in the Owner Console or with `SIDEKICK_SIGNUP_OPEN=true`, see `flagDefault` in lib/owner.ts), per-IP limit (`signup_attempts`), the hook for "Sign up with Microsoft" |
| `lib/entra.ts` | Microsoft (Entra ID) sign-in: the round trip to Microsoft (PKCE, state, nonce) and ID-token verification |
| `lib/owner.ts` | Owner Console sign-in, kill switches (`assertEnabled`), operator log |
| `lib/trace.ts` | Traces and steps (spans) for every request and Teams message; feeds the Activity page and the home orb |
| `lib/api.ts` | `handle()` wrapper: JSON responses, `HttpError` → `{ error }`, reference codes + `app_errors` log for unexpected errors |
| `lib/extract.ts` | Files → text (PDF, Word, Teams .vtt) and text → passages |
| `lib/search.ts` | Indexing and search. **All search goes through here**: local keyword index (source of truth, fallback) plus Azure AI Search when configured. Searches one group **plus** its org's firm library (indexed once per org under workspace id `FIRM_SCOPE` = "firm"; firm documents limited to other groups are left out), with type and date filters; `moveIndexed` (a source to another scope); `sourceInfo` (each source's date, text hash, outdated flag); `findSources`, the answer pipeline (search ~30 → facts → `rerank` → best 10) |
| `lib/rank.ts` | Re-ranking for answers, pure and unit-tested: fit to the whole question, freshness, outdated down-ranking, firm-vs-group priority (`isPolicyQuestion`), summaries first, de-duplication (text hash, contained passages), at most 3 passages per source; `versionKey`, `contentHash` |
| `lib/firm.ts` | The firm library (`firm_docs`): upload (title, audience, effective date, replaces, **Applies to** all or chosen groups via `firm_doc_groups`), edit, delete; counts toward the document limit; indexed once per org |
| `lib/upload-guard.ts` | **Upload guard**: the wrong-client check (`checkWrongClient`, no AI: other groups' client names, group names, engagement codes; word boundaries; firm library = any mention), **held** documents (status `Held`, text in `held_text`, not indexed), `keepHeld` / `reviewHeld` / `moveDoc` (between groups, firm library → group; passages moved with `moveIndexed` in search.ts), `moveTargets`. UI pieces in `components/upload-guard.tsx`; kept ones feed the `misfiled_doc` watcher |
| `lib/connectors.ts` | Connectors to outside tools (Azure DevOps Boards, Jira), read-only: the OAuth round trip, tokens sealed with `secret-box` and refreshed, project links per group (`requireManage`), incremental sync with a cursor (`syncLink`; scheduled as queue jobs `connectors.schedule` → `connector.sync` in `job-kinds.ts`), health (`connectorHealth`; each sync reports to `connector-health.ts` for the broken-connector watcher; `connectorProblems` across orgs), work item links for citations and open items for the knowledge map and meeting notes. Tools in `connector-ado.ts` / `connector-jira.ts`, item text in `connector-text.ts`; fakes for tests and the demo in `scripts/fake-tools.mjs` |
| `lib/feedback.ts` | 👍/👎 on answers (`answer_feedback`, one vote per person per answer, walled to the answer's org and group); `feedbackSummary` for admins, `qualityTrends` for the Owner Console; counts only |
| `lib/azure-search.ts` | Azure AI Search index, embeddings and hybrid (keyword + vector) queries |
| `lib/claude.ts` | **All Claude calls go through here**: model per feature, the AI credit check (`creditGate`), retries with backoff (`withRetry`, `AiBusyError`), the cached system prompt, structured output, metering, and the Batch API for non-urgent work (`queueStructured`, `runBatches`, handlers such as the daily reminder digest). The hook for a second route (Claude in Azure AI Foundry) is `aiClient()` |
| `lib/assistant.ts` | The in-app assistant on the home page: answers questions about Sidekick and proposes role-limited actions that only run when the person presses Confirm |
| `lib/sidekick.ts` | The AI features: answers with sources (group + firm library, follow-ups, filters, conflicts), meeting notes (also indexed as a `notes` source, `<meeting id>:notes`), knowledge map |
| `lib/conversations.ts` | Conversations for the three assistants (in-app assistant, Help chat, public help bot) and for Ask (`ask`, per group and guests setting) and Teams answers (`teams`, per group and Teams thread or chat, 30 minutes in chats): the last few turns per person (or per browser on the website), never shared, expire 24 h after the last turn; `standaloneQuestion` rewrites a follow-up into a full question (Claude feature `followup`) before checking and searching; `priorSummary` for the prompt |
| `lib/support.ts` | Support tickets: portal, Help chat, public form and help bot tickets; who sees which (`listTicketsFor`, `visibleTicket`); thread, internal notes, attachments (type checked by first bytes, 5 MB, base64 in the database, always downloaded); unread flags (the dot) and the `notify` email hook; the Owner Console inbox, client context (plan, recent errors by reference code) and team actions, all audited |
| `lib/support-articles.ts` | Support articles at three levels (public / customer / internal), seeds, uses per article and the tickets that followed, Claude drafts from resolved tickets |
| `lib/knowledge.ts` | What the help assistants may answer from: public (guides, FAQ, plans, public articles) or customer (adds customer-level articles). Never client data, never internal articles. Ranked by `rankKnowledge` in lib/search.ts |
| `lib/support-assistant.ts` | The Help chat (support assistant): read-only setup checks, safe fixes behind Confirm within the role, grounding (sources or checks), paid by Sidekick (`payer: "support"`) with its own per-person limit |
| `lib/helpbot.ts` | The public "Ask about Sidekick" help bot and every rule it follows (see its header): public knowledge only, grounded, public-mode guardrails, masking, per-visitor/IP limits, daily budget then FAQ, unanswered list for the operator |
| `lib/guardrails.ts` | The firm's guardrails: locked floor + org-wide switches, per-workspace extra switches (stricter only) and custom rules (save-time loosening check, versioned) merged by `getGuardPolicy`, the question check (quick local check, then Claude feature `guard`), the answer check (grounding, masking), and `guard_events` counts |
| `lib/guard-text.ts` | The quick guardrail text checks with no I/O (slurs, jailbreaks, swearing, loosening and too-broad rules, masking contact details but not dates), unit-tested in `tests/db.test.mjs` |
| `lib/excerpt.ts` | Plain-text source excerpts for answers, taken from the part of a passage that matches the question |
| `lib/workspaces.ts` | Unique workspace names, renaming, and deleting a workspace with everything scoped to it (both engines, plus Azure search) |
| `lib/teams/bot.ts`, `cards.ts` | Teams bot (Teams SDK 2.1) and its Adaptive Cards; tenant check, waiting chats |
| `lib/meetings-graph.ts` | **Automatic meeting notes** from Microsoft Graph (no media bot): the per-org switch (`auto_meetings`), two kinds of call (`graph_meetings.kind`: scheduled `meeting`, or `adhoc` for Meet now, read through `adhocCalls` with `CallTranscripts.Read.All`), one transcript subscription per org and kind (validation-token handshake, client state, renewal a day ahead, recreate on 404 / `subscriptionRemoved`), notifications and lifecycle events, the polling fallback (`getAllTranscripts` per organizer and kind, `graph_poll_cursors`), `recordTranscript` (one `graph_meetings` row per transcript), `pickGroup` (meeting chat, else most people, ties wait), `fetchTranscript` (plan checks, saves a `source = 'teams'` meeting) and `writeNotes` (notes + one Teams post). Every step is a job (`meetings.*` in lib/job-kinds.ts) |
| `lib/meeting-group.ts` | **Which group a Teams meeting belongs to**, shared by automatic notes and automatic recording: `knownPeople` (account ids, else email through the org's own directory: `linkByDirectory`; never guests or other tenants), `matchGroup` (linked chat → most people ≥2 → title hint via `upload-guard.groupsNamedIn` → `tie`/`unclear` wait for a person → `none`), `pickGroup` (short form) |
| `lib/auto-record.ts` | **Meetings that record by themselves** (opt-in per org, `auto_meetings.auto_record`): reads group members' next 7 days of Teams meetings from their calendars, looks each up by join link and PATCHes `recordAutomatically: true` once (`meeting_autorecord`) when it's clearly one group's (`decide`; never with outsiders). Job `meetings.record.org`. Graph has no transcribe-only property, so Teams also records video |
| `lib/saved-items.ts` | **Save to knowledge**: a meeting item (decision, requirement, risk, fact, term) kept as group knowledge (`items.pinned`, `saved_by`, `saved_at`) and indexed as its own `notes` source `saved:<item id>`; from the Teams notes card, the meeting page and the Teams tab |
| `lib/teams/tab.ts` | **The Teams tab / personal app**: `tabUser` (Teams SSO bearer token → Sidekick user by tenant + Microsoft account id, no cookies, no email matching), `tabView` (groups, meetings, open action items, one meeting's notes), `tabAction` (done/reopen, save/unsave) |
| `lib/teams/install.ts` | Who may add Sidekick to a chat (Team Leads/admins), and Sidekick leaving chats through Graph (refused installer, 7 days unassigned, removed in the portal) |
| `lib/teams/members.ts` | `@Sidekick add` / `remove @name`: who may, who can be added, auditing |
| `lib/reminders.ts` | Per-chat settings (notes, tracking, reminders), saving tracked chat messages, building reminder digests (items picked in code, worded by Claude feature `remind`, every point with a source) and their card buttons |
| `lib/notes-chats.ts` | **Meeting notes go to**: which of a group's linked Teams chats get its notes (one, several or none; one default chat until the Team Lead chooses), the picker's API and the card footer; pure rules in `lib/notes-chat-rules.ts` |
| `lib/reminder-rules.ts` | Plain rules for chat settings and reminder timing (defaults, validation, time zones, quiet days); no I/O, unit-tested |
| `lib/jobs.ts` | **The job queue** (`jobs` table): `enqueue` (idempotency keys), `defineJob` (kinds), recurring jobs per time slot (`enqueueRecurring`), claims with a lease (Postgres `FOR UPDATE SKIP LOCKED` + compare-and-set; SQLite one writer), **fair between companies** (each company's oldest jobs first, at most `SIDEKICK_JOB_ORG_CONCURRENCY` running each), retries with backoff, dead letters, `runWorker` (the heartbeat's loop, `SIDEKICK_JOB_CONCURRENCY` jobs at once; every job run is a trace), `queueHealth` for the Owner Console |
| `lib/fair-limiter.ts` | A fair limiter (overall cap, per-key cap, round-robin between waiting keys, priority, give up after a wait). `lib/claude.ts` uses it per organization (`AI_LIMITS`) so one company can't use up Sidekick's Claude capacity |
| `lib/retention.ts` | How long growing records are kept (`RETENTION`: AI usage and audit 13 months, guardrail counts 6 months, errors 90 days, expired sign-in rows…; traces 30 days) and `pruneOldData`, the hourly batched clean-up (job `data.retention`). Client content is never pruned here |
| `lib/job-kinds.ts` | Every kind of background job (reminders, leaving unassigned chats, roll-off deletions, the watchers per organization, clean-up) and `heartbeat` (POST /api/jobs/tick). Add new kinds here (e.g. meetings from Microsoft Graph) |
| `lib/watchers.ts` | **Watchers**: cheap checks on the queue (unanswered questions, failed Teams posts, chats waiting or removed, overdue/unowned action items, stale documents, groups without a Team Lead or notes chat or with 2+ chats and no notes choice, broken connectors) that keep `findings` up to date (one row per problem, refreshed, auto-resolved); AI (feature `watch`) only for a stale-document candidate, once per pair; who sees and may snooze each finding (`findingsFor`, `actOnFinding`) |
| `lib/connector-health.ts` | **The connector hook**: `reportConnectorHealth({ orgId, workspaceId?, connector, label, ok, message?, fixHref? })` after each sync; broken rows become findings. `removeConnectorHealth` when disconnected on purpose |
| `instrumentation.ts` | Starts the job heartbeat: `POST /api/jobs/tick` every 30 seconds (off with `SIDEKICK_SCHEDULER=off`) |
| `lib/site.ts` | The public website's map: `PUBLIC_PAGES` (titles, descriptions, sitemap order), header links, `PRIVATE_PATHS` (robots.txt), page metadata helpers (`pageMetadata`, `NOINDEX`), `siteUrl` from `SIDEKICK_PUBLIC_URL`. Pure |
| `lib/pwa.ts` | **Installable web app**: start page (`/home`), scope (`/`, since portal pages share no folder), colors, icon folder, and the metadata that turns install on (`INSTALLABLE`: portal + sign-in layouts, iPhone tags) or off (`NOT_INSTALLABLE`: website and Owner Console layouts). No service worker, so nothing signed-in is cached on devices. Manifest in `app/manifest.ts`, hint in `components/install-app.tsx`, guide `docs/guide/install-app.md` |
| `lib/help.ts`, `lib/help-search.ts` | The help center: the public guides by name (fixed list, never file paths), link rewriting, the search index and matching. Pure |
| `lib/help-content.ts` | **Generated** copy of the public guides in `docs/guide/` (`npm --prefix app run help:sync`, `scripts/sync-help.mjs`; a test fails while it's stale). Needed because the Docker build only sees `app/` |
| `lib/markdown.ts` | Small Markdown reader for the guides: blocks and inline nodes as data (no HTML strings), rendered by `components/markdown.tsx` |
| `lib/changelog.ts` | The public changelog entries, newest first |
| `lib/faq.ts` | The FAQ: every question and answer in one data file (`/faq` shows all; Pricing, Security & trust and How it works show theirs via `faqFor`). Answers stay consistent with `docs/guide/`; `legalReview` marks draft wording. The future public chat should answer from this file and the guides |
| `components/dock.tsx`, `assistant-dock.tsx`, `helpbot.tsx`, `chat.tsx`, `support-chat.tsx` | The bottom-left assistant button (portal: in-app assistant + "I need help"; website: help bot; never in the Owner Console) and the chat pieces the three assistants share (`useConversation`, thread, confirm card) |
| `components/` | Portal, Owner Console and public-website frames (`public-shell.tsx` + `public-site.css`), the website's pictures (`site-art.tsx`: our own inline-SVG illustrations that follow light/dark; `product-shot.tsx`: real product shots in window/laptop/phone frames from `public/site/*.webp`, made by `scripts/site-shots/render.cjs` (chat cards) and `scripts/site-shots/demo-shots.cjs` (portal and phone shots from the demo world); `how-mocks.tsx`: small HTML/CSS screen mockups), shared UI |
| `app/(app)/*/view.tsx` | Client portal pages (home is `app/(app)/home`); `app/owner/(console)/*/view.tsx` Owner Console pages; `app/(public)/*` the public website |

## Routes

| Address | What | Sign-in |
|---|---|---|
| `/` | Website home for visitors. **Anyone with a portal session cookie is redirected to `/home`** by `src/proxy.ts`; sign-in and Microsoft sign-in still land on `/`, so they arrive at `/home` too | None |
| `/features`, `/how-it-works`, `/security`, `/pricing`, `/faq`, `/support`, `/changelog`, `/privacy`, `/terms`, `/signup` | Public website pages (`app/(public)/*`), one header and footer (`components/public-shell.tsx`) | None |
| `/docs`, `/docs/<guide>` | Help center: the public guides from `docs/guide/` (concepts, admin, Teams, roles) with search; any other name is a 404 | None |
| `/robots.txt`, `/sitemap.xml` | Generated per request (`app/robots.ts`, `app/sitemap.ts`) from `lib/site.ts`; addresses from `SIDEKICK_PUBLIC_URL` | None |
| `/manifest.webmanifest`, `/app-icons/*` | The installable app's manifest (`app/manifest.ts`, static) and icons (`public/app-icons/`, drawn by `scripts/app-icons.mjs`); public because browsers fetch them without cookies | None |
| `/login`, `/setup` | Portal sign-in and first-run setup (`noindex`) | None |
| `/checkout` | Pay for the plan (test mode) | Portal |
| `/home` and every other portal page (`app/(app)/*`) | The client portal (`noindex`); home moved here from `/` so the website can own `/` | Portal |
| `/owner/*` | Owner Console (`noindex`), own sign-in at `/owner/login` | Owner |
| `/teams/tab`, `/teams/config` | The Teams tab and its setup page (`app/teams/*`), framed only by Teams (their own `frame-ancestors` in `next.config.ts`; X-Frame-Options DENY everywhere else); skipped by the proxy | Teams SSO (bearer token to `/api/teams-tab`) |
| `/api/graph/notifications`, `/api/graph/lifecycle` | Microsoft Graph's change and lifecycle notifications for meeting transcripts (validation token echoed as text; client state checked) | None (Graph) |
| `/api/*` | API routes; each checks the session itself (the proxy skips them) | Per route |

**Public chat slot**: `components/site-chat-slot.tsx` (rendered at the end of every public page by `public-shell.tsx`) holds the "Ask about Sidekick" help bot (`components/helpbot.tsx`, `lib/helpbot.ts`). It is always shown (the pages are prerendered); when the "Public help bot" switch is paused or its daily budget is spent, it answers with FAQ entries and "Talk to a human".

Support routes: portal `/help` (Contact support, My tickets) and `/help/tickets/<id>`; public `/support` (form) and `/docs/articles/<slug>` (published public articles only); Owner Console `/owner/support`, `/owner/support/<id>`, `/owner/articles`, `/owner/helpbot`. APIs: `/api/assistant`, `/api/support/assistant`, `/api/help-bot` (POST a message; GET/DELETE `?conversation=`), `/api/support/tickets[/<id>]`, `/api/support/attachments/<id>`, `/api/support/unread`, `/api/support/public`, `/api/owner/support[/tickets/<id>|/articles|/helpbot]`.

Answers and the firm library: portal `/knowledge` (Ask with filters, follow-ups, New question, 👍/👎) and `/firm-library`; APIs `/api/ask` (POST a question; GET/DELETE `?ws=&guests=&conversation=`), `/api/firm[/<id>]`, `/api/feedback` (POST a vote; GET counts for admins); the Owner Console's answer quality is on `/owner/performance`.

Adding a public page: add it to `PUBLIC_PAGES` in `lib/site.ts` (sitemap, metadata) **and** to the proxy's `matcher` (a unit test checks both); adding a portal page: add its path to `PRIVATE_PATHS` (a unit test checks every `app/(app)` folder is listed). Later the website and portal can split into `sidekick.ai` and `app.sidekick.ai`; keeping the website under `(public)` and the portal under `(app)` keeps that a hosting change.

## Three flows worth knowing

**Asking a question** (portal or Teams): the retrieval pipeline
1. Route checks the user and workspace (`requireUser`, `requireWorkspace`), or the Teams conversation's link. Filters (`types`, `since`, `until`) are checked.
2. Conversation (lib/conversations.ts): the person's conversation in this group (and guests setting; in Teams this thread or chat) is found or started (`newQuestion` / "new question" starts afresh). `standaloneQuestion` rewrites a follow-up into a full question (only when there are earlier turns).
3. `ask()` runs the guardrail check (`screenTurn`: the quick check on what was typed, the full check on the standalone question) **at the same time as** the search. A refused question returns a fixed reply with `blocked` set, is counted in `guard_events` and saved as a refused turn (so its follow-ups are refused too); it isn't answered or saved as a gap.
4. `findSources()` (lib/search.ts): `searchPassages()` gets ~30 candidates from the org's group **and** its firm library (`workspace_id IN (group, "firm")`; Shareable only if guests are present; type and date filters), by Azure hybrid search when configured, otherwise local keyword search. `sourceInfo()` adds each source's date (document added, meeting held, chat sent, firm effective date), text hash, and outdated flag (firm "superseded by", or a newer group upload of the same document). `rerank()` (lib/rank.ts) scores fit to the whole question, freshness, firm-vs-group priority and notes-first, drops duplicates, keeps ≤3 per source and the best 10.
5. `structured("ask", …)` sends the numbered sources (with `origin`, `date`, `outdated`), a short `priorSummary` of earlier turns (context, not a source), the standalone question and the org's rules (`answerRules`) to Claude, which must return `{ found, answer, source_ids, conflict }`.
6. `checkGrounding` turns a "found" answer with no real cited source into "I don't know"; `cleanOutput` masks swearing (and contact details if switched on) in the answer and excerpts.
7. The standalone question is saved in `questions` (unanswered = knowledge gap) and its id returned as `questionId` for 👍/👎 (`answer_feedback`, lib/feedback.ts); the exchange is saved in the conversation; the cited sources (with origin "firm" = "Firm policy") are returned.

Quality check: `npm --prefix app run eval:answers` runs the accuracy test set (`samples/eval/contoso.json`) against the real Claude in a throwaway copy and prints a score and the cost (not in CI; the plumbing is tested with fake Claude).

**A Teams meeting ends (automatic notes)**
1. Graph notifies `/api/graph/notifications` (or the 15-minute poll finds the transcript): `recordTranscript` adds a `graph_meetings` row (unique per transcript) and enqueues `meetings.fetch`.
2. `fetchTranscript` reads the meeting, picks the group (`pickGroup`), downloads the `.vtt`, checks read-only plan / paused AI / meeting hours / AI credit, and saves a `meetings` row (`source = 'teams'`, status Processing), then enqueues `meetings.notes`. Throttling (429 Retry-After) makes the job retry no sooner than Graph asked.
3. `writeNotes` runs `processMeeting()` as Sidekick, then claims `notes_posted_at` and posts the notes card (with **Save to knowledge**) and action-item cards to the group's notes chats, then the after-meeting reminders.

**Adding a past or outside meeting** (importing a transcript)
1. `POST /api/meetings` stores the transcript (`.vtt` converted to "[time] Speaker: text").
2. `processMeeting()` asks Claude for summary, decisions, action items, open questions and facts, saves them in one transaction, and indexes the transcript and the notes (source type `notes`, id `<meeting id>:notes`, ranked before transcript passages). Meetings processed before notes were indexed are indexed on the first question after a server start.
3. After the response is sent (`after()`), `postMeetingNotes()` posts the cards to the linked Teams conversations that take notes, then `remindAfterMeeting()` posts a reminder to the chats that want one after meetings.

**A background job** (lib/jobs.ts)
1. The heartbeat (`instrumentation.ts`, every 30 s) calls `POST /api/jobs/tick` with its secret → `heartbeat()` (lib/job-kinds.ts) → `runWorker()`.
2. `enqueueRecurring()` adds each recurring kind once per slot (idempotency key `every:<kind>:<slot>`; the unique index makes every other app copy's insert a no-op). Other code enqueues one-off jobs with `enqueue(kind, { orgId, payload, key })`.
3. `claimNext()` picks the oldest due job (or a running one whose lease ran out) and claims it with one compare-and-set `UPDATE … WHERE id = ? AND <still claimable>` (on Postgres after `SELECT … FOR UPDATE SKIP LOCKED`); attempts + 1, `locked_by`, `locked_until`.
4. `runClaimed()` runs the kind's handler inside its own trace (channel "system", kind "job", the job's org), then `completeJob` (only if the lease is still ours) or `failJob`: back to `queued` after `backoffMs` (30 s doubling to an hour, jitter), or `dead` after `max_attempts`. Owner Console → Job queue shows backlog, stuck, failed, dead (Retry / Cancel) and per-company counts.

**The watchers** (lib/watchers.ts)
1. `watch.all` (every 15 minutes) enqueues one `watch.org` per active organization; each runs `runWatchers(orgId)` with one "watch" step per watcher.
2. Each watcher reads the database (and the local keyword index for stale documents) for the organization's groups that aren't ending, and returns `Fresh` findings with a dedupe key (kind + group + subject).
3. Upsert: new → `open`; known → text and counts refreshed (`last_seen_at`); resolved or past its snooze → reopened. Findings of that kind no longer found → `resolved`. A watcher that throws leaves its findings untouched.
4. The stale-document watcher asks Claude (feature `watch`, kill switch "Watchers' AI checks", the org's AI credit) only for a (document, newer decision) pair whose texts share enough words, once per pair (`watch_checks`), at most `MAX_AI_CHECKS` per run.
5. `GET /api/findings` filters by org, workspace walls and audience (members / managers / admins); `POST` snoozes (admins, the group's Team Lead). Home and the group's Overview tab show them (`components/findings.tsx`).

**A daily reminder**
1. The job queue runs `reminders.daily` every 5 minutes; `runDueReminders()` finds chats whose local time is past their reminder time (not a quiet day).
2. `sendReminder()` claims the chat's slot for that day in `reminder_runs` (unique, so never twice), then `gatherReminders()` picks items **in code**, within the workspace and, for guest chats, Shareable only.
3. `buildDigest()` has Claude (`remind`) word them; points naming unknown items are dropped, sources are attached by code, `cleanOutput` cleans the text. The card goes out through `postCard()`; its buttons come back to `reminderAction()`.

**Signing up and paying (test mode)**
1. `/signup` → `POST /api/signup` → `signUp()` (lib/signup.ts): switch on? per-IP limit, fields, unique email; then in one transaction `createOrgWithOwner()` (lib/auth.ts) and `startTrial()` (lib/billing.ts). Audited, operator-logged, traced (`billing` step); the route starts the session and returns the provider's checkout URL.
2. `/checkout` → **Pay (test mode)** → `POST /api/billing {action:"pay"}` → `pay()` → `provider().completeCheckout()` → `recordPayment()` (status active). A Stripe provider would instead return its own checkout URL and call `recordPayment` from a signed webhook.
3. Access: `accessFor()` (lib/plans.ts) turns the subscription into full or read-only. Read-only is enforced in `handle()` (changes → 402 via `readOnlyRefusal`, except auth, billing, owner, sign-up, Teams endpoints) and in `assertEnabled()` (lib/owner.ts: new AI work, so Teams and reminders stop too). `/api/me` returns it so the portal shows the notice banner.

**Plan limits and the AI credit**
1. Creating something counted by the plan (person, group, tracked chat, meeting, document) first calls `assertCanAdd(orgId, key, amount)` (lib/limits.ts): effective limit (plan, overlaid with `org_terms`) vs current use; past it → `LimitError` (402, `kind: "limit"`, `limit`). Nothing is deleted when a limit shrinks; `limitReport` shows "over".
   Switching on a plan feature (`FeatureKey` in lib/plans.ts: reminders, Team Leads, custom rules, Require Microsoft sign-in) first calls `assertFeature(orgId, key)`, only for *new* use (a chat whose reminders are already on, an existing Team Lead or rule keeps working after a downgrade); refused → `FeatureError` (402, `kind: "limit"`, `feature`, `plan`). GET /api/me sends `plan.features` so pages show "Not in your plan" (`featureNote`).
2. Every `structured()` call runs `creditGate(feature, orgId)` (lib/credit.ts) after `assertEnabled`: the month's cost (cached 30 s, bumped by every recorded call) vs the credit. Below 100% nothing changes (80% writes a one-time audit notice and the portal banner reads `/api/me` `credit`). At 100%: `ask`/`guard` and short `extract` get a cheaper model; `remind`, `insights`, `assist` and long `extract` throw `FeatureOffError("credit")` (503, a notice, not an app error). `ctx.skipCredit` skips the check (for work Sidekick pays for itself, such as the coming support assistant).
3. Every live call is retried on 429/529/5xx with exponential backoff and jitter (Retry-After honoured); a call that stays busy throws `AiBusyError` (503, "very busy, try again in a minute"). Daily reminder digests are queued with `queueStructured` and sent as one Message Batch per `reminders.daily` run; `runBatches` collects ended batches on later runs and hands results to the registered handler (half price). Things people wait for stay live.
4. `ask()` also takes one hit from the per-person rate limit (lib/rate-limit.ts, 429 past it), for the portal and Teams alike.
5. Cost internals stay out of the portal (Oct 25, 2026): no AI cost in dollars, tokens, response times or model names in any firm-facing API (`/api/usage` sends activity counts and `allowance` as a percent, `/api/billing` drops the AI credit line and the plans' AI dollars, `/api/overview` sends a count, Activity steps go through `firmAttrs`, the client audit log says "Added extra AI" without the amount, the assistant and Help chat get a percent). The Owner Console client page has all of it: AI use by model, totals with tokens and response time, cost per group and day, and a CSV with cost (`/api/owner/tenants/:id/usage-export`). tests/api.test.mjs ("no cost internals for firms") walks an Org Owner's responses for any such key.

**Roll-off and deletion**
1. Ending a group: `POST /api/workspaces/:id/rolloff` → `scheduleGroupRolloff` writes a `rolloffs` row (scope group, `delete_on`, the unlinked chat ids), unlinks its Teams chats and posts them a notice. From then on `requireWorkspace` refuses it (409) in any request that changes something (`isWriteRequest`, set by `handle()`), and `NOT_ENDING` leaves it out of the group count. `DELETE` cancels and relinks.
2. Leaving: `cancel()` (lib/billing.ts) or the operator schedules a scope-org row with `read_only_from` and `delete_on`; `orgAccess` → `withRolloff` makes the org read-only from that date with the banner; paying (`recordPayment`) or any non-canceled status from the operator cancels it.
3. The job queue (`rolloffs.run`, every 5 minutes) runs `runDueRolloffs`: each due row is claimed (scheduled → running), then `deleteGroupWithCertificate` (via `deleteWorkspace`) or `deleteOrganization` (every group, then sign-in data, then `ORG_TABLES`, then the org), and the certificate is written on the row (and, for a group, in the audit log). Failure → back to scheduled with `error`.
4. Exports (`/api/workspaces/:id/export`, `/api/export`) are GET, so they keep working while read-only.

**A message to one of the assistants** (in-app assistant, Help chat, public help bot)
1. Switch and limit checks (`assertEnabled`; the Help chat 30/person/hour; the help bot per visitor and per network, its daily budget, else FAQ mode).
2. `openConversation` finds the owner's conversation (same person in the same org, or the same browser on the website; unexpired) or starts one.
3. `standaloneQuestion` rewrites a follow-up into a full question (Claude feature `followup`, cheapest model; skipped when there are no earlier turns; paused = message as typed).
4. `screenTurn`: the quick check on what was typed, then the full check (`screen`, public mode for the help bot) on the standalone question. A refusal uses fixed wording and is saved as a refused turn, so a follow-up to it is refused too.
5. Context: the assistant's org snapshot (in-app assistant), the setup checks (Help chat), and the ranked help knowledge (`knowledgeFor` + `rankKnowledge`; public only for the help bot), plus `priorSummary` of the earlier turns.
6. Claude (`assist`; `support` / `helpbot` with `payer`, so no organization's AI credit is used); grounding (cited sources, or the checks for the Help chat), `checkAction`/`checkFix` for anything proposed, `cleanOutput`.
7. `addExchange` saves both turns (visitor text masked first) with what the browser shows again (sources, checks, "Following up on").

**A Teams message**
1. Teams → Azure Bot Service → `POST /api/messages` with a Microsoft-signed token.
2. The Teams SDK verifies the token and routes the activity to a handler in `bot.ts`.
3. `tenantGate`: in multi-tenant mode an activity from a Microsoft tenant no Sidekick org is tied to gets the sign-up card and nothing is stored.
4. Unlinked conversation in a tied tenant (channel/group chat): on install the installer must be a Team Lead/admin (else Sidekick leaves, install.ts); it then waits to be assigned in the portal, and Sidekick reads, saves and answers nothing there (mentions get the "not set up yet" notice). Elsewhere (untied tenant, 1:1) the link-code card. Assigned via the picker → every message is tracked. Linked → `add`/`remove @name` commands (members.ts), or typing indicator now and the answer card after the request returns.
5. A channel/group message that doesn't mention Sidekick (delivered thanks to the manifest's resource-specific consent) is saved only if the chat is tracked (`recordChatMessage`), otherwise ignored; never answered.

## Row-level security (the second lock)
The walls above live in application code. Behind them, Postgres itself refuses to hand out another org's rows
(details, measured overhead and the full list of system paths: `docs/security/2026-10-row-level-security.md`).
- **Scope**: every unit of work carries an org scope (AsyncLocalStorage in `lib/db.ts`). `handle()` opens one with
  no org; `currentUser()` (so `requireUser`) sets the person's org; it can't change to another org afterwards.
  Background work says what it is: `withOrg(orgId, fn)` for one org (each queued job with an `org_id`, a Teams
  answer, saving a trace) or `asSystem("reason", fn)` for named work across orgs (session and sign-in lookups,
  the job queue itself, the Teams bot's lookups, the Owner Console via `requireOwner` → `markRequestSystem`).
- **On the connection**: before each query `lib/db.ts` sets `app.org_id`, `app.bypass` and the role in one
  statement (session level, remembered per pooled connection; `SET LOCAL` inside `tx`). Org work runs as the
  role `sidekick_app`, which can't get around the policies; system work keeps the owner role with `app.bypass = 'on'`.
- **Tables**: every table with an `org_id` column, plus `orgs` and `workspace_members`, found automatically at
  start-up (`db/schema.postgres.sql`, end) and in `lib/db.ts` (`RLS_TABLES`). Group-level walls stay in the app.
- **Strict in tests**: `SIDEKICK_DB_STRICT=1` (set by `tests/run.mjs`) makes a query on an org table with no org
  and no system reason throw. In production it logs once and runs as system work.
- **SQLite** has no row-level security; the scope is still tracked there, so strict mode catches gaps on both engines.

## Rules every change must keep
- **Walls**: filter every query by `org_id`, and by a workspace id that went through `requireWorkspace` (or a linked Teams conversation). Never trust an id from the request on its own.
- **Org scope**: new background work, routes outside `handle()` or work before sign-in picks its scope explicitly: `withOrg(orgId, …)` when it's for one org (preferred), `asSystem("why", …)` only when it must span orgs. Never use `asSystem` to make a user-facing query "work"; a failing strict-mode test means the scope is missing.
- **Data, not instructions**: anything from documents, transcripts or users goes to Claude inside tags, and the system prompt says to ignore instructions in it.
- **Who pays for AI**: AI work goes through `structured()`; work Sidekick pays for itself (support assistant, help bot) passes `payer`, which skips and is left out of the organization's AI credit (`usage_events.payer`).
- **Guardrails**: anything that answers people (portal, Teams, assistant, Help chat, help bot) goes through `lib/guardrails.ts`: `screenQuestion` before, `cleanOutput` (and `checkGrounding` for sourced answers) after. Refusals use the fixed `MESSAGES`, never Claude-written text. `guard_events` stores rule/where/when only, never text.
- **Isolation test**: `tests/api.test.mjs` plants a secret in workspace B and checks it can't be reached from workspace A, another org, Teams or the assistant. New routes or surfaces that read workspace data belong in that test.
- **One path each**: Claude only via `lib/claude.ts`, search only via `lib/search.ts`, so Azure (Foundry, AI Search) can be swapped in later without touching callers.
- **Brand**: user-facing product name only via `BRAND` (lib/brand.ts); never hard-code it in new text.
- **New tables with client data**: add `org_id`, and add the table to `ORG_TABLES` in lib/rolloff.ts (the organization roll-off test fails otherwise); workspace-scoped tables also go into `deleteWorkspace`.
- **Scale** (docs/SCALE.md): a list that can hold every group of a big company (1,000+) needs an index on the column it filters by, in both schemas; check one group with `canSeeWorkspace`/`requireWorkspace` rather than listing them all; anything that grows every day gets a line in `lib/retention.ts`; check new queries with the load test (`npm --prefix app run load:test`).
- **Background work**: anything that runs later or on a clock is a job kind in `lib/job-kinds.ts` (never a new timer): payload = ids only, safe to run twice, a few counts as the result, an idempotency key where the same work could be asked for twice. AI in background checks only once a cheap check has fired.
- **Limits**: plan limits only in `lib/plans.ts`; enforce a new countable thing with `assertCanAdd` where it's created, and never delete data because of a limit. A new per-plan feature goes in `FEATURE_KEYS` and each plan's `includes`, with `assertFeature` where it's switched on (never where it's already used). AI work goes through `structured()` so the AI credit applies; pass `skipCredit` only for work Sidekick pays for itself.
- **Plain wording, no cost internals**: customers (every portal role, Org Owner included) see "AI answers", activity counts and their AI allowance as a percent; never model names, providers, keys, tokens, response times or what the AI costs. Those belong in the Owner Console ("Powered by Claude" is said on the public privacy page). New firm-facing data goes through `lib/firm-usage.ts` and stays covered by the "no cost internals" test.
- **Billing**: plans and prices only in `lib/plans.ts`; subscription changes only through `lib/billing.ts` (provider first, then the row and the audit log). Never add card, CVC or bank fields: a real provider collects them on its own page.
- **Audit**: access changes, deletions and anything Sidekick does on its own call `audit()` / `auditAsSidekick()`.
- **Parameters**: SQL values always go in `?` parameters, never into the SQL string.
- **Secrets**: only in `app/.env.local` (git-ignored). The Teams bot never runs without token checks in production.
- **Browser safety**: every change (POST/PUT/PATCH/DELETE) through `handle()` is refused if it came from another website; security headers (CSP, no framing) are set in `next.config.ts`. Don't put user or document text in a URL that a page displays; use `lib/flash.ts`.
- **Both databases**: SQL must run on SQLite and Postgres; `npm test` checks both.
- **No silent failures**: routes use `handle()`; pages use `api()` (opens the problem modal for network/server/paused problems) and `useReportError()` instead of empty catches; page crashes land on `error.tsx`.
- **Refusals aren't errors**: a feature paused (kill switch) or turned off for one client throws `FeatureOffError` (`assertEnabled` in `lib/owner.ts`). `handle()` answers 503 with `kind: "paused" | "restricted"`, without a reference code, an App errors row or a failed trace; check it before starting a Claude step so it never counts as a Claude error. Trace names replace ids with `:id` (`normalisePath` in `lib/api.ts`: add new `[id]` collections there).
- **Tests**: add or update tests in `app/tests/` with any behaviour change; `npm test` (which ends with a production `next build`) must pass before committing, and the same suite runs on every pull request in GitHub Actions.

## Documentation conventions
- Every source file starts with a header comment saying what it's for; library files explain the concepts they introduce.
- Every exported function, type and route has a doc comment: what it does, who may call it, what it returns or throws.
- Comments explain *why* and the concept, not what the next line literally does.
- User-visible behavior changes also update the matching guide in `docs/guide/`.
