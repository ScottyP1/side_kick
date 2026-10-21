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
| `lib/db.ts` | The async query API (`all`, `get`, `run`, `tx`) over SQLite (laptop) or Postgres (`DATABASE_URL`); SQLite schema + migrations. Every table with client data has `org_id` and usually `workspace_id` |
| `db/schema.postgres.sql` | The Postgres schema, mirroring the SQLite one |
| `lib/auth.ts` | Sessions, roles, `requireUser` (also blocks everything but the password change while a temporary password is pending), `requireWorkspace` (the workspace wall), audit log |
| `lib/login-limit.ts` | Sign-in rate limit: failed password sign-ins per email and per IP, stored in `login_failures` (works across several app copies) |
| `lib/security.ts` | Small security checks with no I/O, unit-tested: one-time setup rule (`SIDEKICK_SETUP_CODE` in production), the cross-site request (CSRF) check `handle()` runs on every change, Word "zip bomb" size check, prompt tag escaping |
| `lib/flash.ts` | One-time messages from a server redirect to the page (Microsoft sign-in errors), in a short-lived cookie instead of the address |
| `lib/entra.ts` | Microsoft (Entra ID) sign-in: the round trip to Microsoft (PKCE, state, nonce) and ID-token verification (issuer checked per tenant; single-tenant mode also checks the tenant) |
| `lib/tenants.ts` | Single- vs multi-tenant mode (`TENANT_ID`), which Sidekick org a Microsoft tenant belongs to, `tieOrgToTenant` (also for the sign-up flow) |
| `lib/directory.ts` | The customer's Microsoft 365 directory via Microsoft Graph (app permission `User.Read.All`): admin-consent round trip, search, import as Microsoft-sign-in people |
| `lib/plans.ts` | The plans (Starter/Team/Business for sale, Enterprise set up by the team: made-up per-person prices and every limit: people, groups, tracked chats, meeting hours, documents, connectors, monthly AI credit), trial/grace lengths, `accessFor` (full or read-only), `limitState`, `parseCustomLimits`, `transcriptMinutes`. Pure, shared by pages and server, unit-tested |
| `lib/limits.ts` | Plan limits: effective limits (plan + the Sidekick team's custom terms in `org_terms`), what's used, `assertCanAdd` (402 `kind: "limit"`) called where each thing is created, `limitReport` (near / over), `saveTerms` |
| `lib/credit.ts` | The monthly AI credit: this month's cost vs the plan's credit (+ top-ups), 30-second cache updated by every call, 80% notice, 100% "essentials only" (`creditGate`: cheaper models for answers/checks/short notes, `FeatureOffError("credit")` for the extras), `skipCredit` opt-out, `grantTopUp` |
| `lib/rate-limit.ts` | Per-person rate limits stored in `rate_events` (works across app copies): questions per hour in `ask()` |
| `lib/ops.ts` | What the app knows about itself for the Owner Console: health facts (as `/api/health`), build and release (`SIDEKICK_COMMIT`, `SIDEKICK_RELEASED_AT`), releases seen (`app_releases`) |
| `lib/billing.ts` | Subscriptions (`subscriptions` table) behind a billing provider: `mock` (test mode, no payment details ever) now, Stripe later (documented in the file). Pay, change plan, cancel, simulate a failed payment, operator changes; `readOnlyRefusal` (used by `handle()`) |
| `lib/signup.ts` | Self-service sign-up: org + Org Owner + trial in one transaction, the `signup` switch (**off by default**; opened in the Owner Console or with `SIDEKICK_SIGNUP_OPEN=true`, see `flagDefault` in lib/owner.ts), per-IP limit (`signup_attempts`), the hook for "Sign up with Microsoft" |
| `lib/entra.ts` | Microsoft (Entra ID) sign-in: the round trip to Microsoft (PKCE, state, nonce) and ID-token verification |
| `lib/owner.ts` | Owner Console sign-in, kill switches (`assertEnabled`), operator log |
| `lib/trace.ts` | Traces and steps (spans) for every request and Teams message; feeds the Activity page and the home orb |
| `lib/api.ts` | `handle()` wrapper: JSON responses, `HttpError` → `{ error }`, reference codes + `app_errors` log for unexpected errors |
| `lib/extract.ts` | Files → text (PDF, Word, Teams .vtt) and text → passages |
| `lib/search.ts` | Indexing and search. **All search goes through here**: local keyword index (source of truth, fallback) plus Azure AI Search when configured |
| `lib/azure-search.ts` | Azure AI Search index, embeddings and hybrid (keyword + vector) queries |
| `lib/claude.ts` | **All Claude calls go through here**: model per feature, the AI credit check (`creditGate`), retries with backoff (`withRetry`, `AiBusyError`), the cached system prompt, structured output, metering, and the Batch API for non-urgent work (`queueStructured`, `runBatches`, handlers such as the daily reminder digest). The hook for a second route (Claude in Azure AI Foundry) is `aiClient()` |
| `lib/assistant.ts` | The in-app assistant on the home page: answers questions about Sidekick and proposes role-limited actions that only run when the person presses Confirm |
| `lib/sidekick.ts` | The AI features: answers with sources, meeting notes, knowledge map |
| `lib/guardrails.ts` | The firm's guardrails: locked floor + org-wide switches, per-workspace extra switches (stricter only) and custom rules (save-time loosening check, versioned) merged by `getGuardPolicy`, the question check (quick local check, then Claude feature `guard`), the answer check (grounding, masking), and `guard_events` counts |
| `lib/guard-text.ts` | The quick guardrail text checks with no I/O (slurs, jailbreaks, swearing, loosening and too-broad rules, masking contact details but not dates), unit-tested in `tests/db.test.mjs` |
| `lib/excerpt.ts` | Plain-text source excerpts for answers, taken from the part of a passage that matches the question |
| `lib/workspaces.ts` | Unique workspace names, renaming, and deleting a workspace with everything scoped to it (both engines, plus Azure search) |
| `lib/teams/bot.ts`, `cards.ts` | Teams bot (Teams SDK 2.1) and its Adaptive Cards; tenant check, waiting chats |
| `lib/teams/install.ts` | Who may add Sidekick to a chat (Team Leads/admins), and Sidekick leaving chats through Graph (refused installer, 7 days unassigned, removed in the portal) |
| `lib/teams/members.ts` | `@Sidekick add` / `remove @name`: who may, who can be added, auditing |
| `lib/reminders.ts` | Per-chat settings (notes, tracking, reminders), saving tracked chat messages, building reminder digests (items picked in code, worded by Claude feature `remind`, every point with a source) and their card buttons |
| `lib/reminder-rules.ts` | Plain rules for chat settings and reminder timing (defaults, validation, time zones, quiet days); no I/O, unit-tested |
| `instrumentation.ts` | Starts the in-app timer that calls `POST /api/reminders/tick` every 5 minutes (off with `SIDEKICK_SCHEDULER=off`) |
| `components/` | Portal and Owner Console frames, shared UI |
| `app/(app)/*/view.tsx` | Client portal pages; `app/owner/(console)/*/view.tsx` Owner Console pages |

## Three flows worth knowing

**Asking a question** (portal or Teams)
1. Route checks the user and workspace (`requireUser`, `requireWorkspace`), or the Teams conversation's link.
2. `ask()` runs the guardrail check (`screenQuestion`: local check, then Claude `guard`) **at the same time as** the search. A refused question returns a fixed reply with `blocked` set and is counted in `guard_events`; it isn't answered or saved as a gap.
3. `searchPassages()` finds up to 12 passages in that org + workspace (Shareable only if guests are present): Azure hybrid search when configured, otherwise local keyword search.
4. `structured("ask", …)` sends the numbered passages, the question and the org's rules (`answerRules`) to Claude, which must return `{ found, answer, source_ids }`.
5. `checkGrounding` turns a "found" answer with no real cited source into "I don't know"; `cleanOutput` masks swearing (and contact details if switched on) in the answer and excerpts.
6. The question is saved in `questions` (unanswered = knowledge gap); the cited sources are returned.

**Importing a meeting**
1. `POST /api/meetings` stores the transcript (`.vtt` converted to "[time] Speaker: text").
2. `processMeeting()` asks Claude for summary, decisions, action items, open questions and facts, saves them in one transaction, and indexes the transcript.
3. After the response is sent (`after()`), `postMeetingNotes()` posts the cards to the linked Teams conversations that take notes, then `remindAfterMeeting()` posts a reminder to the chats that want one after meetings.

**A daily reminder**
1. The timer (`instrumentation.ts`) calls `POST /api/reminders/tick` with its secret; `runDueReminders()` finds chats whose local time is past their reminder time (not a quiet day).
2. `sendReminder()` claims the chat's slot for that day in `reminder_runs` (unique, so never twice), then `gatherReminders()` picks items **in code**, within the workspace and, for guest chats, Shareable only.
3. `buildDigest()` has Claude (`remind`) word them; points naming unknown items are dropped, sources are attached by code, `cleanOutput` cleans the text. The card goes out through `postCard()`; its buttons come back to `reminderAction()`.

**Signing up and paying (test mode)**
1. `/signup` → `POST /api/signup` → `signUp()` (lib/signup.ts): switch on? per-IP limit, fields, unique email; then in one transaction `createOrgWithOwner()` (lib/auth.ts) and `startTrial()` (lib/billing.ts). Audited, operator-logged, traced (`billing` step); the route starts the session and returns the provider's checkout URL.
2. `/checkout` → **Pay (test mode)** → `POST /api/billing {action:"pay"}` → `pay()` → `provider().completeCheckout()` → `recordPayment()` (status active). A Stripe provider would instead return its own checkout URL and call `recordPayment` from a signed webhook.
3. Access: `accessFor()` (lib/plans.ts) turns the subscription into full or read-only. Read-only is enforced in `handle()` (changes → 402 via `readOnlyRefusal`, except auth, billing, owner, sign-up, Teams endpoints) and in `assertEnabled()` (lib/owner.ts: new AI work, so Teams and reminders stop too). `/api/me` returns it so the portal shows the notice banner.

**Plan limits and the AI credit**
1. Creating something counted by the plan (person, group, tracked chat, meeting, document) first calls `assertCanAdd(orgId, key, amount)` (lib/limits.ts): effective limit (plan, overlaid with `org_terms`) vs current use; past it → `LimitError` (402, `kind: "limit"`, `limit`). Nothing is deleted when a limit shrinks; `limitReport` shows "over".
2. Every `structured()` call runs `creditGate(feature, orgId)` (lib/credit.ts) after `assertEnabled`: the month's cost (cached 30 s, bumped by every recorded call) vs the credit. Below 100% nothing changes (80% writes a one-time audit notice and the portal banner reads `/api/me` `credit`). At 100%: `ask`/`guard` and short `extract` get a cheaper model; `remind`, `insights`, `assist` and long `extract` throw `FeatureOffError("credit")` (503, a notice, not an app error). `ctx.skipCredit` skips the check (for work Sidekick pays for itself, such as the coming support assistant).
3. Every live call is retried on 429/529/5xx with exponential backoff and jitter (Retry-After honoured); a call that stays busy throws `AiBusyError` (503, "very busy, try again in a minute"). Daily reminder digests are queued with `queueStructured` and sent as one Message Batch per timer tick; `runBatches` collects ended batches on later ticks and hands results to the registered handler (half price). Things people wait for stay live.
4. `ask()` also takes one hit from the per-person rate limit (lib/rate-limit.ts, 429 past it), for the portal and Teams alike.
5. Model and provider names stay out of the portal (`/api/me` says `ai.working`, Usage has no models, Activity drops `model` from step details); the Owner Console client page shows AI use by model.

**A Teams message**
1. Teams → Azure Bot Service → `POST /api/messages` with a Microsoft-signed token.
2. The Teams SDK verifies the token and routes the activity to a handler in `bot.ts`.
3. `tenantGate`: in multi-tenant mode an activity from a Microsoft tenant no Sidekick org is tied to gets the sign-up card and nothing is stored.
4. Unlinked conversation in a tied tenant (channel/group chat): on install the installer must be a Team Lead/admin (else Sidekick leaves, install.ts); it then waits to be assigned in the portal, and Sidekick reads, saves and answers nothing there (mentions get the "not set up yet" notice). Elsewhere (untied tenant, 1:1) the link-code card. Assigned via the picker → every message is tracked. Linked → `add`/`remove @name` commands (members.ts), or typing indicator now and the answer card after the request returns.
5. A channel/group message that doesn't mention Sidekick (delivered thanks to the manifest's resource-specific consent) is saved only if the chat is tracked (`recordChatMessage`), otherwise ignored; never answered.

## Rules every change must keep
- **Walls**: filter every query by `org_id`, and by a workspace id that went through `requireWorkspace` (or a linked Teams conversation). Never trust an id from the request on its own.
- **Data, not instructions**: anything from documents, transcripts or users goes to Claude inside tags, and the system prompt says to ignore instructions in it.
- **Guardrails**: anything that answers people (portal, Teams, assistant) goes through `lib/guardrails.ts`: `screenQuestion` before, `cleanOutput` (and `checkGrounding` for sourced answers) after. Refusals use the fixed `MESSAGES`, never Claude-written text. `guard_events` stores rule/where/when only, never text.
- **Isolation test**: `tests/api.test.mjs` plants a secret in workspace B and checks it can't be reached from workspace A, another org, Teams or the assistant. New routes or surfaces that read workspace data belong in that test.
- **One path each**: Claude only via `lib/claude.ts`, search only via `lib/search.ts`, so Azure (Foundry, AI Search) can be swapped in later without touching callers.
- **Limits**: plan limits only in `lib/plans.ts`; enforce a new countable thing with `assertCanAdd` where it's created, and never delete data because of a limit. AI work goes through `structured()` so the AI credit applies; pass `skipCredit` only for work Sidekick pays for itself.
- **Plain wording**: customers see "AI answers", never model names, providers or keys; those belong in the Owner Console ("Powered by Claude" is said on the public privacy page).
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
