# Row-level security: the second lock (October 2026)

**What it is.** Every query in Sidekick already filters by the person's organization (`org_id`) and checks the
group with `requireWorkspace` / `requireManage`. That is the first lock, and it lives in application code: one
forgotten `WHERE org_id = ?` would show one company's data to another. Row-level security (RLS) is a second
lock inside Postgres itself: the database only hands out rows of the organization the request works for, even
to a query that forgot its filter.

SQLite (laptop and demo copies) has no RLS; it behaves exactly as before. Production runs on Postgres.

## How the request's org reaches Postgres

1. **Scope in the app** (`app/src/lib/db.ts`). Every unit of work carries a *scope*, kept with Node's
   AsyncLocalStorage so it follows every `await`:
   - `handle()` (every API route) opens a request scope with no org yet (`openRequestScope`).
   - `currentUser()` (inside `requireUser`) checks the session as system work, then calls `setScopeOrg(user.org_id)`.
     From then on the request works for that org. A request can never switch to another org (it throws).
   - Background work picks a scope explicitly: `withOrg(orgId, fn)` (one org: a job for that org, a Teams
     answer, saving a trace) or `asSystem("reason", fn)` (named work that spans orgs).
2. **Settings on the connection.** Before a query runs, `db.ts` makes sure its connection carries the scope, in
   one statement: `set_config('role', …)`, `set_config('app.org_id', …)`, `set_config('app.bypass', …)`.
   - Outside a transaction the settings are made at session level and remembered per pooled connection, so a
     connection that already has the right scope needs no extra round trip (steady traffic for one org costs
     nothing extra).
   - Inside `tx(...)` they're made with `SET LOCAL`, which ends with the transaction, so a transaction can never
     leave its scope behind on a pooled connection. A scope change inside a transaction (for example `asSystem`
     inside it) applies again before the next statement.
3. **The role.** Org work runs as the role `sidekick_app` (no login, no `BYPASSRLS`, row access only). That
   matters because superusers and table owners skip RLS: on a developer's Mac the login is a superuser, and on
   Azure it's the table owner. System work keeps the login's own role (the owner, which also applies the
   schema), with `app.bypass = 'on'`.

## Which tables

Every table with an `org_id` column (56 today), plus `orgs` (by `id`) and `workspace_members` (visible when its
group is). The migration finds them from the catalog, so a new table with `org_id` is covered at the next start
without anyone remembering. `lib/db.ts` keeps the same list (`RLS_TABLES`, read from the schema text) to know
which queries need a scope.

The policy on each table (`sidekick_org_v3`), for reading and writing alike:

```sql
(SELECT current_setting('app.bypass', true)) = 'on'
OR org_id = (SELECT current_setting('app.org_id', true))
OR ((SELECT current_setting('app.org_id', true)) IS NULL AND (SELECT current_user) <> 'sidekick_app')
```

- With no org, the app sets `app.org_id` to empty, so nothing matches: it fails closed.
- The last line is for **older app versions**: during a deploy the previous version keeps answering while the
  new one applies the schema, and an automatic rollback brings it back. It connects as the owner and never sets
  `app.org_id` (so the setting is missing, `NULL`), and without this line it would see no rows at all. The
  current app sets the setting on every connection before its first query, and its org work runs as
  `sidekick_app`, which this line never lets through. It can be dropped (policy `v4`) once no older version can
  come back.
- `WITH CHECK` is the same rule, so a write can't put a row in, or move a row to, another org.
- The sub-selects make Postgres read each setting once per query, not once per row.
- Every guarded table has an index starting with `org_id` (the migration adds `<table>_org_rls` where missing).

**Group (workspace) level** is not in the database: who may see which group depends on the person's role and
memberships, which would need the user id and a membership lookup on every row. That stays in the app
(`requireWorkspace`, `canSeeWorkspace`), covered by the isolation test. The org line is the one that keeps
companies apart, and it's cheap.

## System work (the bypass)

`app.bypass` is only ever set by `asSystem(reason, …)` or `markRequestSystem(reason)`, in these named paths:

| Path | Where | Why it spans orgs |
| --- | --- | --- |
| Session lookup | `lib/auth.ts` `currentUser`, `sessionUser` | Finds whose session a cookie is, before the org is known; then `setScopeOrg` |
| Sign-in, sign-out, first-time setup, sign-up, Microsoft sign-in | routes pass `handle(fn, { system: "…" })` | Look people up by email or Microsoft id across orgs |
| Two-step sign-in | `lib/mfa-routes.ts` (`verify`, `signin-options`) | Before the session exists |
| Owner Console | `lib/owner.ts` `requireOwner` → `markRequestSystem` | Operators see every org by design |
| Job queue | `lib/jobs.ts` `runWorker`, `enqueue` | Claims, leases and idempotency keys span orgs; **each job then runs `withOrg(job.org_id)`** when it has one |
| Watchers, reminders, retention, roll-offs | recurring jobs with no org | Fan out over every org |
| Teams bot | `lib/teams/bot.ts` `handleTeamsRequest` | Activities arrive by tenant and conversation; unlinked chats belong to no org. **Answers run `withOrg(chat's org)`** |
| Teams tab, connector sign-in | `lib/teams/tab.ts` `tabUser`, `lib/connectors.ts` `finishConnect` | Only the tenant → org or saved-state lookup; then `setScopeOrg` |
| Chats without an org | teams-links routes, `workspaces.ts`, `rolloff.ts`, `watchers.ts`, `support-assistant.ts` | Waiting or just-unlinked chats have `org_id` NULL; the tenant / org condition in the query is the wall |
| Uniqueness across orgs | `api/users`, `lib/directory.ts` (email), `lib/tenants.ts` (Microsoft tenant) | An email or tenant belongs to one org at most |
| Microsoft Graph notifications, public help bot and support form | their routes (`handle(…, { system })`) | Arrive without a signed-in person |
| Error log | `lib/api.ts` `logAppError` | The Sidekick team's own table |

Search for `asSystem(`, `markRequestSystem(` and `system: "` to list them all.

Everything else (all signed-in portal routes, the assistant, Ask, exports) runs under the person's org.

## Failing loudly

- **Tests** run with `SIDEKICK_DB_STRICT=1` (`tests/run.mjs`). A query on an org table with no org and no system
  reason throws an error that names the fix. Both engines, so SQLite runs catch them too.
- **Production** (no strict mode): such a query logs `[db] Database query outside any org scope …` once per
  statement and runs as system work, so a path the tests don't cover keeps working. Signed-in request code
  always has its org by the time it reads data, so the lock still holds where it matters.
- `SIDEKICK_DB_STRICT=report` with `SIDEKICK_DB_SCOPE_LOG=<file>` lists each unscoped call site once instead of
  failing (how the paths above were found).

## Proof

- `tests/db.test.mjs` (Postgres only): under org A's scope, `SELECT … FROM documents` with **no WHERE** returns
  only A's rows; B's rows by id, through a JOIN, in `orgs`, `users` and `workspace_members` are invisible;
  `UPDATE`/`DELETE` with no WHERE leave B alone; inserting or moving a row into B is refused; system work sees
  both; 40 interleaved queries for two orgs on the shared pool each see only their own; a transaction's scope
  never leaks to the connection's next user. Strict mode refuses unscoped queries.
- `tests/api.test.mjs` isolation test: also checks the server reports RLS active (`/api/health` →
  `rowLevelSecurity`) on Postgres.

## Overhead (measured Oct 25, 2026 on the MacBook, local Postgres 17, 3,000 queries per case, two runs)

Reproduce with `npm --prefix app run bench:rls` (`app/scripts/rls-bench.mjs`; it says how to run it off and on).

| Query | RLS off | RLS on | Extra |
| --- | --- | --- | --- |
| One row by id, same org each time | 108–110 µs | 126–127 µs | ~18 µs (the policy check) |
| One row by id, org changes every query | 106–112 µs | 177–182 µs | ~70 µs: one extra statement to switch the connection's org |
| Count 2,000 rows of a group | 211–212 µs | 426–777 µs | 0.1–0.3 µs per row scanned |
| Transaction with 2 queries | 304–342 µs | 344–362 µs | ~20–40 µs (`SET LOCAL` once) |

What it means in practice:
- A typical page runs 5–30 small queries, so RLS adds well under a millisecond, next to Azure's ~1 ms network
  round trip per query.
- The real cost on Azure is the **org switch**: when a pooled connection last served another org, the settings
  go first as their own statement, one extra round trip (~1 ms). Connections serving the same org skip it (cached).
- Big scans pay a little per row because the policy is checked on each; the settings are read once per query
  (sub-selects), and every guarded table has an index starting with `org_id`, so queries that already filter by
  org or group stay index-driven.

## Deploy and rollback

See `docs/RUNBOOKS.md` → "Row-level security". In short: it deploys with the schema at start-up (idempotent,
no data changes); `SIDEKICK_RLS=off` turns it off again at the next start without a deploy.
