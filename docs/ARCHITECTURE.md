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
| `lib/entra.ts` | Microsoft (Entra ID) sign-in: the round trip to Microsoft (PKCE, state, nonce) and ID-token verification |
| `lib/owner.ts` | Owner Console sign-in, kill switches (`assertEnabled`), operator log |
| `lib/trace.ts` | Traces and steps (spans) for every request and Teams message; feeds the Activity page and the home orb |
| `lib/api.ts` | `handle()` wrapper: JSON responses, `HttpError` → `{ error }`, reference codes + `app_errors` log for unexpected errors |
| `lib/extract.ts` | Files → text (PDF, Word, Teams .vtt) and text → passages |
| `lib/search.ts` | Indexing and search. **All search goes through here**: local keyword index (source of truth, fallback) plus Azure AI Search when configured |
| `lib/azure-search.ts` | Azure AI Search index, embeddings and hybrid (keyword + vector) queries |
| `lib/claude.ts` | **All Claude calls go through here**: model per feature, structured output, metering |
| `lib/assistant.ts` | The in-app assistant on the home page: answers questions about Sidekick and proposes role-limited actions that only run when the person presses Confirm |
| `lib/sidekick.ts` | The AI features: answers with sources, meeting notes, knowledge map |
| `lib/guardrails.ts` | The firm's guardrails: locked floor + org-wide switches, per-workspace extra switches (stricter only) and custom rules (save-time loosening check, versioned) merged by `getGuardPolicy`, the question check (quick local check, then Claude feature `guard`), the answer check (grounding, masking), and `guard_events` counts |
| `lib/guard-text.ts` | The quick guardrail text checks with no I/O (slurs, jailbreaks, swearing, loosening and too-broad rules, masking contact details but not dates), unit-tested in `tests/db.test.mjs` |
| `lib/excerpt.ts` | Plain-text source excerpts for answers, taken from the part of a passage that matches the question |
| `lib/workspaces.ts` | Unique workspace names, renaming, and deleting a workspace with everything scoped to it (both engines, plus Azure search) |
| `lib/teams/bot.ts`, `cards.ts` | Teams bot (Teams SDK 2.1) and its Adaptive Cards |
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

**A Teams message**
1. Teams → Azure Bot Service → `POST /api/messages` with a Microsoft-signed token.
2. The Teams SDK verifies the token and routes the activity to a handler in `bot.ts`.
3. Unlinked conversation → link-code card. Linked → typing indicator now, answer card after the request returns.
4. A channel/group message that doesn't mention Sidekick (delivered thanks to the manifest's resource-specific consent) is saved only if the chat is tracked (`recordChatMessage`), otherwise ignored; never answered.

## Rules every change must keep
- **Walls**: filter every query by `org_id`, and by a workspace id that went through `requireWorkspace` (or a linked Teams conversation). Never trust an id from the request on its own.
- **Data, not instructions**: anything from documents, transcripts or users goes to Claude inside tags, and the system prompt says to ignore instructions in it.
- **Guardrails**: anything that answers people (portal, Teams, assistant) goes through `lib/guardrails.ts`: `screenQuestion` before, `cleanOutput` (and `checkGrounding` for sourced answers) after. Refusals use the fixed `MESSAGES`, never Claude-written text. `guard_events` stores rule/where/when only, never text.
- **Isolation test**: `tests/api.test.mjs` plants a secret in workspace B and checks it can't be reached from workspace A, another org, Teams or the assistant. New routes or surfaces that read workspace data belong in that test.
- **One path each**: Claude only via `lib/claude.ts`, search only via `lib/search.ts`, so Azure (Foundry, AI Search) can be swapped in later without touching callers.
- **Audit**: access changes, deletions and anything Sidekick does on its own call `audit()` / `auditAsSidekick()`.
- **Parameters**: SQL values always go in `?` parameters, never into the SQL string.
- **Secrets**: only in `app/.env.local` (git-ignored). The Teams bot never runs without token checks in production.
- **Both databases**: SQL must run on SQLite and Postgres; `npm test` checks both.
- **No silent failures**: routes use `handle()`; pages use `api()` (opens the problem modal for network/server/paused problems) and `useReportError()` instead of empty catches; page crashes land on `error.tsx`.
- **Tests**: add or update tests in `app/tests/` with any behaviour change; `npm test` (which ends with a production `next build`) must pass before committing, and the same suite runs on every pull request in GitHub Actions.

## Documentation conventions
- Every source file starts with a header comment saying what it's for; library files explain the concepts they introduce.
- Every exported function, type and route has a doc comment: what it does, who may call it, what it returns or throws.
- Comments explain *why* and the concept, not what the next line literally does.
- User-visible behavior changes also update the matching guide in `docs/guide/`.
