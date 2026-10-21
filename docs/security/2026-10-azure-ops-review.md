# Security & operations review: Azure (October 20, 2026)

Read-only review of Sidekick's live Azure setup (resource group `sidekick-rg`, image `sidekick:ba0a60a`,
revision `sidekick-app--0000007`), its GitHub repo and the deploy scripts. Nothing in Azure, Entra, Teams
or GitHub was changed. The live site was only probed without signing in (GET requests, plus empty or
unsigned POSTs to `/api/messages` and `/api/reminders/tick`). No secret values were read into this
report; secrets are named only. "The live address" means the Container App's address (see
`az containerapp show … --query properties.configuration.ingress.fqdn`).

The application code itself is reviewed separately (parallel app review).

## Summary

**Nothing critical.** The database isn't open to the whole internet, no secret is exposed in the repo,
git history or the live site, and every API route refuses anonymous callers.

The basics are right: HTTPS only (old TLS refused), secrets stored as Container App secrets, image
pulled with a managed identity, registry admin off, Postgres requires TLS, only Cody has roles in the
subscription, budgets with an automatic freeze, and spend is $2.71 of $50 this month.

The gaps are mostly **operations**: if the site goes down nobody is told, container logs aren't kept,
there are no written runbooks for rollback, restore, secret rotation or incidents, and the database
(the only copy of all customer data) has 7-day, single-region backups that have never been test-restored.
On the security side: no browser security headers, Postgres accepts connections from any Azure
customer's network (password still needed), the Owner Console's first account was never created on the
live site, the laptop and the live site share the same keys, and Dependabot alerts are off.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 7 |
| Low | 9 |

## Findings

### High

**H1. Nobody is told when the site is down or erroring; container logs are thrown away.**
- *What/where:* `sidekick-env` has no log destination (no Log Analytics workspace), so the container's
  console output (`console.error`, start-up crashes, Next.js errors) is visible only in the live log
  stream and then lost. There are no Azure Monitor alerts (metric, activity log or availability) and no
  Application Insights. The only action group is the budget freeze. The container has **no health
  probes** configured (`probes: null`, so Azure only checks the port is open), even though
  `app/src/app/api/health/route.ts` says it's used as the Azure health probe.
- *Why it matters:* if the database is unreachable, the app hangs, or a deploy breaks start-up, Cody
  finds out only when someone complains. The app's own Activity/Performance pages record errors in the
  database, but they can't report an app that's down or a database it can't reach, and nobody is
  notified.
- *Fix:* (1) add liveness + readiness probes on `/api/health` (free, 15 min); (2) an availability alert:
  an Azure Monitor standard availability test on `/api/health` emailing both addresses (~$1/month), or a
  free external uptime checker; (3) connect `sidekick-env` to a Log Analytics workspace with a 30-day
  retention and a 0.1 GB/day cap (first 5 GB/month free, so ~$0); (4) optional: an alert on
  `RestartCount > 0` and Postgres `cpu_percent`/`memory_percent > 90%`. Total effort: ~1–2 hours.

**H2. No written runbooks for the things that go wrong.**
- *What/where:* `docs/HOSTING.md` documents deploy, freeze/unfreeze and the reminders timer. There is no
  written way to **roll back** a bad deploy, **restore the database**, **rotate secrets**, **respond to an
  incident** (leaked key, account takeover, data deleted by mistake), or handle the **Microsoft 365
  trial ending Nov 14, 2026** (see M7). `infra/azure/deploy.sh` has no rollback step and doesn't wait for
  or check health after switching.
- *Why it matters:* under pressure is the worst time to work out the `az` commands. A bad deploy is easy
  to undo today (old revisions and every image tag are kept), but only if you know how.
- *Fix:* add a "Runbooks" section to `docs/HOSTING.md` (or `docs/RUNBOOKS.md`). Suggested content:
  - **Roll back:** `az containerapp update -g sidekick-rg -n sidekick-app --image sidekicklabsacr.azurecr.io/sidekick:<previous tag>`
    (tags in `az acr repository show-tags -n sidekicklabsacr --repository sidekick`). Note: schema changes
    in `db.ts` aren't reversed by an image rollback.
  - **Restore the DB:** point-in-time restore to a *new* server
    (`az postgres flexible-server restore --source-server sidekick-labs-db --restore-time … -n sidekick-labs-db-restore`),
    check it, then update the `database-url` secret; the search index rebuilds itself from Postgres.
  - **Rotate secrets:** where each one is created (Anthropic console, Entra app *Certificates & secrets*,
    Search keys, Foundry keys, Postgres admin password) and `az containerapp secret set` + new revision.
  - **Incident:** freeze (`freeze.sh`), rotate every key, check Entra sign-in logs and the app audit log.
  - Make `deploy.sh` print the previous tag and wait for `/api/health` to answer `ok:true`.
  - Effort: ~2 hours, no cost.

### Medium

**M1. No browser security headers.**
- *What/where:* the live site sends no `Strict-Transport-Security`, `Content-Security-Policy`,
  `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options` or `Referrer-Policy`, and does send
  `x-powered-by: Next.js` (`app/next.config.ts` has no `headers()`).
- *Why it matters:* without a framing rule, another site can show Sidekick invisibly in a frame and trick
  a signed-in user into clicking (clickjacking). Without HSTS a first visit over plain HTTP could be
  intercepted on hostile Wi-Fi. A CSP limits the damage of any future script-injection bug.
- *Fix:* add `headers()` in `next.config.ts`: HSTS (`max-age=31536000; includeSubDomains`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `frame-ancestors 'none'` (change to allow `teams.microsoft.com` etc. if a Teams tab is added), and
  `poweredByHeader: false`; start CSP in `Content-Security-Policy-Report-Only` mode. Effort ~1–2 hours
  (CSP needs testing with Next.js inline scripts), no cost.

**M2. Postgres accepts connections from every Azure customer's network, as the admin user.**
- *What/where:* `sidekick-labs-db` has public network access on, and its only firewall rule is
  "Allow all Azure services" (`0.0.0.0`), which means *any* Azure VM or function, from any subscription,
  can reach port 5432. Password auth is on, Entra auth is off, and the app connects as the server admin
  `sidekickadmin`.
- *Why it matters:* the strong random password and required TLS are the only lock. If `DATABASE_URL`
  leaks (laptop, a log, a screenshot), anyone can connect from Azure with full admin rights, including
  dropping the database.
- *Fix (pick one):* cheapest: create a separate app login with rights only on the `sidekick` database
  (no `CREATEROLE`/`CREATEDB`) and keep the admin password offline (~30 min, $0). Better: Entra auth with
  the app's managed identity (no password at all; ~2–3 hours of code + config). Strongest: VNet
  integration + private access (needs a new Container Apps environment and a new Postgres server; a few
  dollars/month and half a day).

**M3. Backups: 7 days, one region, never test-restored.**
- *What/where:* `sidekick-labs-db` keeps 7 days of point-in-time backups (earliest restore Oct 17),
  locally redundant, geo-redundant backup off, HA off, storage auto-grow off. Postgres is the only copy
  of everything: uploaded documents are not kept as files (only their extracted text, in the `passages`
  table), and the Azure AI Search index is rebuilt from Postgres automatically (`reindexAzure` in
  `app/src/lib/search.ts`). That's good design, but it makes the database backup the whole recovery plan.
- *Why it matters:* a mistake noticed after a week (e.g. a workspace deleted by an Org Owner, which
  removes everything in it) can't be undone; a regional Azure outage in Central US would take the data
  offline with no copy elsewhere.
- *Fix:* raise retention to 35 days (backup storage up to the server's 32 GB is included, so ~$0;
  `az postgres flexible-server update --backup-retention 35`); do one test restore to a temporary server
  and delete it (~$0.10); optionally a weekly `pg_dump` to the Mac or a blob container for an off-site
  copy. Geo-redundant backup can only be turned on when a server is created. Effort ~1 hour.

**M4. Owner Console's first account was never created on the live site.**
- *What/where:* `GET /api/owner/auth/setup` on the live address answers `{"needsSetup":true}`. Creating
  it is only allowed when the request's `Host` header is localhost (`assertLocalRequest` in
  `app/src/lib/owner.ts`). I checked (GET only) that Azure's ingress refuses requests with a spoofed
  `Host: localhost` ("Container App – Unavailable"), so it can't be claimed from outside today.
- *Why it matters:* the protection depends on Azure's routing, not on the app. A future change (custom
  domain, a reverse proxy, Front Door forwarding `Host`) could make it claimable by anyone, giving them
  every client's data. It also means there's currently no Owner Console on the live site at all.
- *Fix:* either create the owner account deliberately (e.g. run the setup through
  `az containerapp exec`, or a one-time setup code from an env secret, as already proposed in
  `docs/HOSTING.md`), or set an env flag that turns owner setup off in production. ~1 hour.

**M5. The laptop and the live site share the same keys; no Key Vault; key auth on everywhere.**
- *What/where:* the live app's five secrets (`anthropic-api-key`, `client-secret`,
  `azure-search-api-key`, `azure-openai-api-key`, `database-url`) are Container App secrets (fine,
  encrypted), copied from `app/.env.local`. The Entra app `Sidekick Bot` (ba9f8d71…) has a single client
  secret, named "sidekick dev", used by both. Local copies use the **live** search service (index
  `sidekick-passages` next to the live `sidekick-cloud`) with the same admin key, and the same Foundry key.
  Search and Foundry allow key auth and public network access. Anyone with Contributor on `sidekick-rg`
  can read all secrets; today that's Cody (Owner) and the `sidekick-freeze` Logic App's identity.
- *Why it matters:* a stolen or synced `.env.local` (backup, cloud drive, screenshot) is a full
  compromise of the live site: it gives the Teams bot identity, the search admin key (read/delete every
  client's indexed text) and the database. The Foundry embedding deployment allows 500K tokens/minute,
  so a leaked key can also run up cost (the $10 budget would only email after the fact).
- *Fix:* give the live site its own Entra client secret and its own Search/Foundry keys, and rotate the
  shared ones (~30 min, $0); give local copies a separate search service or a query-only key; later use
  the managed identity for Search and Foundry (roles `Search Index Data Contributor`,
  `Cognitive Services OpenAI User`) and turn key auth off; optionally Key Vault references for the rest
  (~$0.03 per 10k reads). Narrow the freeze Logic App from Contributor to a custom role that can only
  stop/start the app and the database.

**M6. GitHub: no branch protection, Dependabot off, no secret scanning.**
- *What/where:* repo `ScottyP1/side_kick` is private with one collaborator (Cody, admin), no deploy
  keys or webhooks; the Actions token is read-only and actions are pinned to commit SHAs (good). Branch
  protection and rulesets aren't available on the free plan for private repos, so anything pushed to
  `main` is what `deploy.sh` ships next. Dependabot alerts are **disabled**; GitHub secret scanning isn't
  available on this plan (GitGuardian covers it; its PR #18 hit is the placeholder
  `postgres://user:…@host` in `app/.env.example`, a false positive).
- *Why it matters:* a vulnerable npm package (Next.js has had serious advisories) would go unnoticed, and
  Cody's GitHub account is the only gate to production.
- *Fix:* turn on Dependabot alerts and security updates (Settings → Code security, free); add
  `npm audit --omit=dev --audit-level=high` to the test workflow; make sure GitHub 2FA is on (manual
  check). GitHub Pro ($4/month) adds branch protection if wanted. ~15 min.

**M7. Microsoft 365 trial ending Nov 14, 2026 has no written plan.**
- *What/where:* the Azure sign-in account, the only Global Administrator, the Entra app and the Teams
  bot all live in the Sidekick Labs tenant; one of the two budget email addresses is that tenant's
  mailbox. `docs/PROGRESS.md` lists the decision (keep for $8.40/month or cancel before Nov 15) but not
  what happens to each piece.
- *Why it matters:* if the trial lapses, Teams (the bot, reminders, the test chats) and that mailbox stop;
  the Entra tenant and the Azure subscription should keep working, but it's worth knowing before the date
  rather than after.
- *Fix:* a short checklist in `docs/HOSTING.md`: what stops, what keeps working, and (if cancelling) turn
  off the bot's Teams channel and the reminders switch, and make sure budget alerts still reach the
  outlook.com address. ~30 min.

### Low

**L1. Unused bot channels are on.** `sidekick-bot-dev` has the Web Chat and Direct Line channels enabled
besides Teams. Messages through them are signed by Microsoft too, so the app accepts them. Only someone
with access to the bot resource can get their keys, so risk is small. Fix: disable both if not used (5 min).

**L2. Single points of failure.** One replica (min = max = 1), no zone redundancy, Postgres Burstable B1ms
with HA off (memory peaked at 73% in the last day), AI Search Free (no SLA, 50 MB: 1.4 MB / 3% used, 3
indexes: 2 used, one of them by local copies). Fine for a pilot; the upgrade path is documented in
`docs/HOSTING.md`. Revisit before real clients: 2 replicas (~$10–15/month more) and Search Basic (~$75/month).

**L3. Postgres maintenance window is system-chosen.** Azure can restart the database at any hour for
updates. Fix: set a custom window, e.g. Sunday 03:00 Eastern (`az postgres flexible-server update --maintenance-window Sun:7:0`). 2 min, $0.

**L4. Postgres storage auto-grow is off.** 32 GB, 13% used. If it ever fills, the server goes read-only.
Fix: turn auto-grow on (pays only when it grows). 2 min.

**L5. Secret expiry has no reminder.** Entra client secret "sidekick dev" expires **2027-04-13**; when it
does, Teams and Microsoft sign-in stop. The Anthropic, Search and Foundry keys and the database password
don't expire and have never been rotated. Fix: calendar reminder for March 2027; rotate yearly. The Entra
app has no owners listed (only manageable by the Global Admin); add Cody as owner.

**L6. Only one Global Administrator.** The tenant has three users and one Global Admin. If that account
is locked out (lost phone/MFA), nobody can recover the tenant, Entra app or Azure subscription easily.
Fix: a second, rarely used admin account with its own MFA, kept in the password manager ($0, 15 min).

**L7. Health endpoint tells anyone which services are wired up.** `/api/health` answers anonymously with
the database engine, search mode and whether Claude/Teams are configured. Minor; no versions or names.
Fix: return only `{ok}` to anonymous callers, details for signed-in owners. 15 min.

**L8. The live address is in the repo.** `docs/HOSTING.md` line 6 contains it (the repo is private, and the
address isn't secret, but other docs avoid it). Fix: replace with the `az … --query …fqdn` command.

**L9. Registry housekeeping.** No retention policy; every tag plus `latest` is kept (195 MB of 10 GB).
Keeping them is what makes rollback easy, so just prune occasionally (keep the last ~10). No cost now.

## Checked and fine

- **HTTPS/TLS:** HTTP → 301 to HTTPS; `allowInsecure` off; TLS 1.0 and 1.1 refused, TLS 1.2/1.3 accepted;
  Microsoft-managed certificate valid to Jan 2027 (auto-renewed by Azure).
- **Cookies (code):** `sk_session` httpOnly, SameSite Lax, Secure in production (`NODE_ENV=production` set
  in the Dockerfile), 7 days, stored hashed; `sk_owner` httpOnly, SameSite Strict, 12 hours; the
  Microsoft sign-in state cookie is path-scoped and 10 minutes. (Not seen live, since no sign-in was done.)
- **Anonymous access:** all 47 API routes answer 401 ("Sign in to continue.") / 405 / 404 without a
  session, with no data and no stack traces. Pages redirect to `/login`. `/api/auth/setup` reports
  `needsSetup:false` (org claimed), and both setup POSTs are localhost-only. `/api/messages` refuses a
  missing token and a fake token (401). `/api/reminders/tick` answers 404 without the right token.
- **No leaks:** no source maps served (`.js.map` 404, no `sourceMappingURL`); `/.env`, `/.git/config`,
  `/package.json`, `/server.js` not served; no CORS headers (cross-site scripts can't read API answers).
  Git history (79 commits) scanned for API-key, Entra-secret and connection-string patterns: only the
  `.env.example` placeholder. `.env*` is git-ignored and excluded from the image build.
- **Secrets storage:** all five secrets are Container App secrets referenced with `secretref:`; plain env
  vars hold only ids, endpoints and the public address.
- **Registry:** admin user off, anonymous pull off; image pulled by the app's system-assigned identity,
  which has only `AcrPull` on the registry.
- **Postgres TLS:** `require_secure_transport=on`, `ssl_min_protocol_version=TLSv1.2`; the app verifies
  the server certificate (`rejectUnauthorized: true` in `db.ts`).
- **Access:** only Cody has roles on the subscription (Owner + Foundry User); `sidekick-freeze` has
  Contributor on `sidekick-rg` only. No Key Vault exists (nothing forgotten in one).
- **Entra app:** single tenant, implicit grant off, one delegated Graph permission, redirect URIs are the
  live address plus localhost:3000/3301 only (dev tunnel removed).
- **Bot:** single tenant, F0 (free), endpoint is the live address.
- **GitHub Actions:** read-only token, actions pinned by SHA, no repository secrets needed.
- **Budgets:** 9 budgets, each emailing both addresses at 50/80/100% actual and 100% forecast;
  `sidekick-total-50` also triggers the automatic freeze. Spend this month: **$2.71 of $50** (database
  $2.16, registry $0.62, Foundry ~$0). Nothing idle is billing beyond the expected registry and database
  storage; the extra `sidekick-monthly-25` budget is free and harmless.
- **Reliability:** 0 restarts in the last 3 days; Postgres CPU peak 21%, storage 13%, 10 connections.
  Single revision mode; every past revision and image is kept, so rollback is one command. The in-app
  reminder timer briefly runs twice during a deploy (old and new revision overlap), but each reminder
  claims a unique `reminder_runs` row first, so there are no double posts.
- **Search recovery:** the Azure index can be rebuilt entirely from Postgres (`reindexAzure`, runs
  automatically on an empty index). Original uploaded files are not stored anywhere (only extracted
  text), so there are no files to back up.

## Manual checks for Cody

Things `az` and `gh` can't see:

1. **MFA** on `CodyScott@SidekickLabs334.onmicrosoft.com` (Azure + Entra Global Admin), the outlook.com
   account, GitHub (2FA), the Anthropic console and the password manager. Also check in Entra admin
   center → Overview → Properties → *Manage security defaults* that security defaults (or Conditional
   Access) are on; I couldn't read that policy with the CLI token.
2. **Anthropic console:** a monthly spend limit is set and the key is scoped to this project (Azure budgets
   don't see Claude spend).
3. **Entra sign-in logs** (Entra admin center → Sign-in logs): no unexpected countries or failed sign-ins
   for the admin and the two test users; the test users' passwords are only in the password manager.
4. **`.env.local` exposure:** the Mac's `app/.env.local` holds every live secret; check it isn't synced
   to iCloud/OneDrive/Dropbox or included in a backup you don't control.
5. **Budget emails actually arrive:** look for the 50% emails at month end (or send a test from Cost
   Management → Budgets → *Edit* → alert recipients).
6. **Teams admin center:** only one Sidekick custom app remains after the cleanup, and resource-specific
   consent settings are what you intend.
