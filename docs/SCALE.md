# Scale readiness: 100 companies / 10,000 groups

Roadmap item 6 (October 23, 2026). Can Sidekick serve 100 client companies with 10,000 groups and ~50,000
people? We built that world on a local copy, sent it realistic traffic, fixed what broke, and measured again.
Everything ran on Cody's Mac with made-up data; Claude, Teams and Microsoft were simulated, nothing paid was
used, and no Azure setting was changed. The Azure side is a costed plan: `docs/HOSTING.md` → Scaling up.

## The short version
- **Pages for big companies were the problem, and are fixed.** A company with ~1,000 groups waited up to
  **64 seconds** for its Groups page; now **under 1 second** (p99), usually 0.05 s. Missing database
  indexes were the cause.
- **The background work couldn't keep up, and now does.** With one job at a time, the watchers ("Needs
  attention" checks) reached only **15 of 100 companies** in two minutes and a full round would take longer
  than the 15 minutes between rounds. Now **all 100** in the same two minutes.
- **One noisy company could break Sidekick for everyone; now it can't.** When one company fired questions
  non-stop, about **half of everyone's questions failed** ("AI is very busy") and **no other company's**
  background checks ran. Now other companies' questions had **0 errors** at normal speed, 42 companies'
  checks still ran, and only the noisy company waits longer.
- **Tables no longer grow forever**: an hourly clean-up deletes old traces, logs and expired rows.
- **What to buy, and when**: the paid search tier before the first real customer (~$75/month); a bigger
  database and 2–4 app copies as companies arrive; about **$500–600/month** of Azure at 100 companies
  (plus Claude). Details in `docs/HOSTING.md`.

## How we tested
- **The world** (`npm --prefix app run load:world`, `app/scripts/load-world.mjs`): written straight into a
  local Postgres in **94 seconds**: 100 organizations of very different sizes (the biggest ~1,300 groups,
  a long tail of small ones), 10,002 groups, 50,010 people in every role, 123,000 memberships, 40,000
  documents, 40,000 meetings, 140,000 decisions and notes, 80,000 action items, 80,000 questions, 150,000
  tracked Teams messages, 10,000 linked Teams chats, 8,000 connector work items, 358,000 search passages,
  and the history that grows every day: 300,000 traces with 1.35 million steps, 200,000 AI usage rows,
  100,000 audit entries, 40,000 finished jobs. 1.3 GB.
- **The traffic** (`npm --prefix app run load:test`, `app/scripts/load-test.mjs`): 40 people at once for
  2 minutes, picked so big companies send more, each pausing 1–3 s between actions: portal page loads
  (45%: the page plus the calls its screen makes), Ask questions (20%), Teams messages through the local
  Teams test path (15%, timed until the answer arrives), uploads (5%), other reads (15%), and the job
  heartbeat every 5 seconds starting with "run the watchers for every company". Fake Claude answers in
  ~1.5 s, like the real one.
- **The noisy company** (`--noisy --capacity 24`): the biggest company adds 20 people asking back to back
  and 300 queued background jobs of its own, while fake Claude allows only 24 calls at once across all
  companies (like a real account's rate limit).
- **Before vs after**: the same script against a copy of `main` (with only the fake-Claude timing added)
  and against this branch, each starting from the same saved copy of the world. The app ran as `next
  dev`, so absolute times are a bit slower than production; the comparison is what matters.

## Results

Latency in milliseconds: p50 = typical, p95 = 1 in 20 is slower, p99 = 1 in 100 is slower.

**Normal traffic**

| What | Before p50 / p95 / p99 | After p50 / p95 / p99 |
|---|---|---|
| Groups page | 172 / 3,440 / **64,455** | 52 / 102 / **712** |
| Home page | 146 / 225 / 926 | 62 / 134 / 241 |
| Meetings page | 189 / 311 / 944 | 51 / 118 / 754 |
| Knowledge page | 60 / 129 / 771 | 47 / 99 / 730 |
| Meetings list (API) | 156 / 263 / 1,036 | 13 / 33 / 44 |
| Ask a question (incl. ~1.5 s fake AI) | 3,016 / 4,022 / 4,291 | 3,265 / 4,292 / 4,584 |
| Teams answer, end to end | 3,134 / 4,312 / 5,629 | 3,366 / 4,498 / 5,487 |
| Upload | 21 / 71 / 509 | 22 / 56 / 525 |
| Errors | 0 | 0 |

Ask and Teams times are almost all the (fake) AI's ~1.5–3 s; their database part shrank (below). The
small rise is run-to-run noise from the AI timing.

**Database time per request** (average, from the app's own traces)

| Request | Before | After |
|---|---|---|
| Groups list (`GET /api/workspaces`) | 1,440 ms | 14 ms |
| Meetings list | 148 ms | 8 ms |
| Home numbers (`/api/overview`) | 113 ms | 24 ms |
| Ask a question | 88 ms | 59 ms |
| Teams answer | 85 ms | 39 ms |
| Documents list | 25 ms | 9 ms |

**Background work (job queue)**

| | Before | After |
|---|---|---|
| Companies whose watchers ran in 2 minutes | 15 of 100 | **100 of 100** |
| Jobs run | 71 | 280 |
| Backlog left at the end | 90 | 33 |

**One noisy company**

| | Before | After |
|---|---|---|
| Everyone's questions that failed | **155 of 315 (49%)** | **0 of 343** |
| Other companies' questions, p50 / p95 | 2,363 / 4,972 ms (when they worked) | 3,423 / 4,545 ms |
| The noisy company's own questions | 91% failed | all answered, ~11.5 s each (waiting their turn) |
| Other companies' watchers that ran | **0** | **42** |
| Pages (Groups p99) | 102,310 ms | 837 ms |

## What we changed
1. **Indexes** (`app/src/lib/db.ts` and `app/db/schema.postgres.sql`, same list on both engines, checked
   by a test): on the group, meeting and person columns that every list and count filters by (documents,
   meetings, decisions, action items, questions, memberships, users, sessions, chats) and on the time
   columns the clean-up uses. The Groups-page count query for the biggest company went from 14.9 s to
   48 ms on its own. Checked with `EXPLAIN ANALYZE` on Postgres.
2. **One-group checks** (`canSeeWorkspace` in `app/src/lib/auth.ts`): every request used to load all of the
   company's group ids to check one (1,300 for the biggest); now one indexed lookup, same rules.
3. **Job queue** (`app/src/lib/jobs.ts`): each heartbeat runs **4 jobs at once** (`SIDEKICK_JOB_CONCURRENCY`),
   and claims are **fair**: each company's oldest one or two jobs are considered, and a company already
   running 2 jobs (`SIDEKICK_JOB_ORG_CONCURRENCY`) waits while others go. Tested: 40 jobs from one company
   don't hold up two small ones.
4. **Watchers** (`app/src/lib/watchers.ts`): the stale-document check's AI questions (at most 6 per company
   per run) now run side by side instead of one after another (~9 s → ~4 s per company).
5. **Fair Claude turns** (`app/src/lib/fair-limiter.ts`, used in `app/src/lib/claude.ts`): at most 24 Claude
   calls at once per app copy and 6 per company; waiting companies are served in turn, and questions people
   wait on go before background checks. A call that would wait over 45 s gets the usual "very busy" message.
   The wait shows on each AI step of a trace (`queued_ms`).
6. **Retention** (`app/src/lib/retention.ts`, hourly job `data.retention`): deletes in small batches (no
   long locks; the old one-big-DELETE of traces deadlocked under load). See the list below.
7. **Connection pool** (`app/src/lib/db.ts`): stays at 10 per app copy (the live B1ms database allows ~35
   user connections), and a request now waits at most 15 s for a connection instead of forever.
8. **Search re-index** (`reindexAzure` in `app/src/lib/search.ts`): copies passages to Azure a few hundred
   sources at a time instead of loading all of them into memory (that would fail at millions of passages).
9. **Slow-query log** (`SIDEKICK_SLOW_QUERY_MS`): prints queries slower than that, SQL only, never values.

## How long Sidekick keeps things (`RETENTION` in app/src/lib/retention.ts)
| Record | Kept |
|---|---|
| Traces and their steps (Activity) | 30 days |
| AI usage per call, audit log | 13 months |
| Guardrail counts | 6 months |
| Server errors, resolved findings | 90 days |
| Rate-limit hits, failed sign-ins, sign-up attempts | 1 day |
| Expired sessions and sign-in challenges | deleted once expired |
| Assistant conversations | 24 hours after the last message |
| Tracked Teams messages | 90 days (lib/reminders.ts, unchanged) |
| Finished jobs / dead jobs | 7 / 30 days (lib/jobs.ts, unchanged) |
| Documents, meetings, decisions, questions | until the group or company is deleted (never by age) |

## Search at scale
- **Local keyword search on Postgres** is fine: it narrows to the group first (index on org + group), then
  matches words; ~1.4 ms per question on 358,000 passages.
- **Azure AI Search Free** holds 50 MB / 10,000 passages: one busy group can fill it. **Basic** (~$75/month,
  15 GB) is needed before the first real customer and lasts to roughly a million passages (about 1,000 busy
  groups). Each passage in Azure is ~8–9 KB (text plus a 1,536-number meaning vector).
- **Standard S1** (~$245/month per unit) from there; at 10,000 busy groups (~10 million passages, ~60 GB of
  vectors) plan for 2 S1 units, or shrink the vectors (fewer dimensions or compression) to fit one.
- SQLite (laptop only) can't filter its full-text index by company first; it's for demos, not scale.

## Limits and what's next
- Numbers come from `next dev` on a laptop, one app copy, against a local database. Production will be
  somewhat faster per request; the real limits will be the database tier and Anthropic's rate limits.
- The limiter and the queue caps are **per app copy**: with 3 copies, up to 72 Claude calls at once. Keep
  that under the Anthropic tier's limit (Anthropic Console → Limits).
- The watcher run for the biggest company still makes ~1,000 small queries (half a second of database time);
  fine every 15 minutes, worth batching if companies get much bigger.
- Not tested here: real Microsoft Graph and Teams limits (throttling per tenant), and several app copies
  against one database (the queue's multi-process test covers correctness).

## Re-running it
```bash
npm --prefix app run load:world
```
```bash
createdb -T sidekick_load sidekick_load_base
```
```bash
npm --prefix app run load:test -- --fresh sidekick_load_base --label after
```
Add `--noisy --capacity 24` for the noisy-company run, `--app <other checkout>/app` to measure another
version with the same script. Results (JSON) and the app's log go to `app/.load-results/` (git-ignored).
Local only: both scripts refuse a database that isn't on this Mac.
