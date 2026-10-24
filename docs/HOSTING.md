# Hosting Sidekick in Azure

Sidekick runs in Cody's Sidekick Labs Azure subscription (pay-as-you-go), resource group `sidekick-rg`,
signed in as CodyScott@SidekickLabs334.onmicrosoft.com. Set up October 16, 2026.

**Live address:** not written here; get it with
`az containerapp show -g sidekick-rg -n sidekick-app --query properties.configuration.ingress.fqdn -o tsv` (health: `/api/health`).

## What runs where

| Piece | Azure resource | Region | Cost (approx.) |
|---|---|---|---|
| Web app + Teams bot endpoint | Container App `sidekick-app` (0.5 vCPU, 1 GiB, always 1 copy) in environment `sidekick-env` | East US | ~$10–15/month |
| Database | Postgres Flexible Server `sidekick-labs-db` (Burstable B1ms, 32 GB, v17), database `sidekick` | Central US | ~$16/month |
| Container images | Container Registry `sidekicklabsacr` (Basic) | East US | ~$5/month |
| Search | AI Search `sidekick-labs-search` (Free), index `sidekick-cloud` (local copies use `sidekick-passages`) | Central US | $0 |
| Embeddings / Claude via Foundry | `codyscott-9578-resource` | East US 2 | pay per use |
| Budget freeze | Logic App `sidekick-freeze` + action group `sidekick-freeze-ag` | East US | ~$0 (runs only on alert) |
| Teams bot registration | Azure Bot `sidekick-bot-dev` (F0, single tenant), endpoint = the live address + `/api/messages` | global | $0 |
| Secrets | Key Vault `sidekick-kv` (Standard, RBAC, soft-delete 90 days + purge protection) | East US | ~$0.03/month |

Claude itself is still called with the Anthropic API key (not yet via Foundry); set a monthly spend limit
in the Anthropic console too, since Azure budgets don't see that spend.

Why not App Service: this subscription has a quota of 0 for App Service B1, and B1ms Postgres had no
capacity in East US / East US 2 when set up, hence Container Apps and Central US.

## Settings and secrets

Container App environment variables: `ANTHROPIC_API_KEY`, `CLIENT_SECRET`, `AZURE_SEARCH_API_KEY`,
`AZURE_OPENAI_API_KEY`, `DATABASE_URL` and `SIDEKICK_ENCRYPTION_KEY` come from Container App **secrets**
(referenced with `secretref:`); the rest are plain settings, plus `SIDEKICK_PUBLIC_URL` (the live address)
and `AZURE_SEARCH_INDEX=sidekick-cloud`. `SIDEKICK_PUBLIC_URL` also decides where Microsoft Graph sends meeting-transcript
notifications (`/api/graph/notifications`, must be https) and the Teams tab's sign-in audience
(`api://<host>/<Entra app id>`); optional `SIDEKICK_TEAMS_SSO_URL` accepts a second address's audience during a domain
move (docs/RUNBOOKS.md → Automatic meeting notes). The database admin password was generated at random and only exists
inside `DATABASE_URL`.

**Secrets live in Azure Key Vault `sidekick-kv`** (since Oct 21, 2026). Each of the six Container App secrets
(`anthropic-api-key`, `azure-openai-api-key`, `azure-search-api-key`, `client-secret`, `database-url`,
`encryption-key`) is a **Key Vault reference** (`keyvaultref:https://sidekick-kv.vault.azure.net/secrets/<name>,identityref:system`)
with no version, read with the app's own managed identity. So:

- **Who can read the values:** Cody ("Key Vault Administrator" on the vault) and the app's managed identity
  ("Key Vault Secrets User": read only). Nothing else has a role on the vault. The deploy identity and the
  freeze Logic App have narrow custom roles that can't list the app's secrets (see below): Azure's
  "list secrets" on a Container App returns the real values even for Key Vault references, so that right
  is what matters, and only Cody (Owner) has it.
- **Changing a value:** set a new version in the vault (RUNBOOKS → Rotate secrets). The app picks it up within
  about 30 minutes, or straight away after a restart.
- **The vault keeps deleted secrets 90 days** and can't be purged early (purge protection): a deleted
  secret, or the whole vault, can be recovered. A deleted vault's name stays taken for those 90 days.
- **Cost:** Standard tier, about $0.03 per 10,000 reads (the app reads at start and checks every 30 minutes):
  a few cents a month.
- `app/.env.local` on the Mac still holds its own copies for the laptop (git-ignored, never committed).

**`SIDEKICK_ENCRYPTION_KEY`** (`encryption-key`, created Oct 21, 2026): the master key that encrypts
authenticator-app secrets in the database (`app/src/lib/secret-box.ts`, envelope encryption with AES-256-GCM:
each secret has its own data key, wrapped by this key). Production refuses authenticator setup without it.
It was moved into Key Vault **as-is** (fingerprint checked). **Never regenerate or delete it**: secrets
encrypted with it can't be read with another key (everyone would have to remove and re-add their
authenticator app; passkeys and backup codes are unaffected). Later, Key Vault could do the wrapping itself;
the stored format already has a key id for that.

**Connector apps** (optional, Azure DevOps, Jira, GitHub, Confluence and Microsoft 365: `app/src/lib/connectors.ts`): `ADO_CLIENT_ID` + `ADO_CLIENT_SECRET`
(`secretref:ado-client-secret`), `JIRA_CLIENT_ID` + `JIRA_CLIENT_SECRET` (`secretref:jira-client-secret`; Confluence uses
the same Atlassian app unless `CONFLUENCE_CLIENT_ID` + `CONFLUENCE_CLIENT_SECRET` are set) and `GITHUB_CLIENT_ID` +
`GITHUB_CLIENT_SECRET` (`secretref:github-client-secret`, a GitHub App) and `M365_CLIENT_ID` + `M365_CLIENT_SECRET`
(`secretref:m365-client-secret`, an Entra app with delegated read-only Graph permissions), Key Vault references like the others. Not set = that tool's tile says "Not set up yet". How to create them: RUNBOOKS → Connector
apps. Customers' tool sign-ins are stored in the database, sealed with `SIDEKICK_ENCRYPTION_KEY` (one more reason
never to regenerate it: they'd all have to reconnect).

The image is pulled with the app's managed identity (AcrPull role); the registry's admin user is off.

## Deploy, freeze, unfreeze

Scripts in `infra/azure/` (run after `az login`):

- `./deploy.sh`: builds `origin/main` in the registry and switches the app to it (setting `SIDEKICK_COMMIT`
  like the automatic deploy). It prints the version that was live before, waits up to 10 minutes for
  `/api/health` to answer ok with the new commit, and otherwise prints the rollback command. What to do when things go wrong (rollback, restore, rotate secrets, incident): `docs/RUNBOOKS.md`.
- `./status.sh`: is the app/database running, and every budget's limit and spend this month.
- `./freeze.sh`: stops the app and the database (use when a budget alert arrives). Registry (~$5) and
  database storage (~$4) are still billed while frozen. Azure restarts a stopped Postgres after 7 days.
- `./unfreeze.sh`: starts them again.

## Automatic deploys (GitHub Actions)

Every merge to `main` that changes the app (`app/`, `teams/` or the workflows) deploys itself:
`.github/workflows/deploy.yml` first checks the push came through a merged pull request with a green
`test` check (the **deploy guard**, below), runs the full test suite on the merged code, builds the image in
`sidekicklabsacr`, switches `sidekick-app` to it and waits until the revision running the new image has all
traffic and `/api/health` answers ok **with the new commit** (`"commit"`, the short commit from
`SIDEKICK_COMMIT`), so it's really the new version answering. Azure's own revision health is printed but not
required: it sometimes stays "None" long after the app serves, which caused a needless rollback on
Oct 21, 2026 (#39). If the new version isn't answering within ~10 minutes it **rolls back** to the previous
image and the run fails (GitHub emails the repo owner). One deploy at a time. Docs-only merges don't deploy;
the Actions tab has **Run workflow** for a manual deploy, and `./infra/azure/deploy.sh` still works from the Mac.

- **Deploy guard (free stand-in for branch protection,** which needs GitHub Pro, ~$4/month: add it once there
  are paying customers or a second developer). A push to `main` deploys only if it is the merge commit of a
  pull request merged into `main` whose last commit has a successful `test` check (looked up with the
  workflow's own read-only token). Otherwise the run ends green with a **Deploy skipped** warning saying why,
  and nothing is built or changed. Manual runs (**Run workflow**) skip the guard. What to do: RUNBOOKS →
  Deploy skipped.

- **No stored Azure password.** GitHub's own login token (OIDC) is exchanged for the user-assigned managed
  identity `sidekick-deployer` (resource group `sidekick-rg`), which has a federated credential trusting
  only `repo:ScottyP1/side_kick:ref:refs/heads/main`. Its only role is the custom role **Sidekick Deployer**
  (since Oct 21, 2026; it had Contributor before), assigned on `sidekicklabsacr` and on `sidekick-app`: run
  registry builds and read their logs, read the app and its revisions, update the app (image and settings).
  It **can't** list the app's secrets, read registry passwords, delete anything or grant access, and has
  nothing on the database, the vault, the other services or the subscription. (Updating the app is still
  powerful: it chooses what code runs. That's what the deploy guard and the federated credential protect.)
  See the role: `az role definition list --name "Sidekick Deployer" -o json`.
- **Repository variables** (Settings → Secrets and variables → Actions → Variables; ids, not secrets):
  `AZURE_CLIENT_ID` (the identity's client id), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
- **No manual approval gate:** GitHub's "required reviewers" for environments needs a paid plan on private
  repos, so merging *is* releasing. Keep the rule: merge only reviewed PRs with a green `test` check.
- **Stop automatic deploys** (e.g. during an incident): Actions → Deploy → ⋯ → Disable workflow.
- Rollback by hand: `docs/RUNBOOKS.md` → Roll back.

**Release facts for the Owner Console.** The console's **Business** page shows which commit is running and
when it was released, read from two settings on the container: `SIDEKICK_COMMIT` (short git commit) and
`SIDEKICK_RELEASED_AT` (ISO time). The automatic deploy (`.github/workflows/deploy.yml`) sets them when it switches the app to the new image
(and again on a rollback, to the previous image's tag).
Without them the page falls back to the git checkout (laptop) or says "Not set by the deploy". Each app
copy records the release it runs (`app_releases`) the first time `/api/health` answers, so the page lists
the recent deploys without needing Azure.

**AI settings worth knowing** (all optional): `SIDEKICK_CLAUDE_RETRIES` (extra attempts when Claude is busy,
default 3), `SIDEKICK_BATCH=off` (send daily reminder wording live instead of through the half-price Batch
API), `SIDEKICK_MODEL_ESSENTIAL_ASK/_GUARD/_EXTRACT` (models used once a client's AI credit is used up),
`SIDEKICK_ASK_PER_HOUR` (questions per person per hour, default 60).

## Teams app package

There is **one** Sidekick app in Teams: its app ID is the Azure Bot's ID, and Teams sends its messages to
the bot's messaging endpoint (the live address above). Build the package with:

```bash
npm --prefix app run teams:package
```

That writes `teams/build/sidekick-teams-live.zip` (version from `teams/manifest.template.json`, now 1.4.0: adds the **Meetings** tab in the app bar and the tab for
chats, channels and meetings, served from `/teams/tab` and `/teams/config`),
with the live address as its web address. It asks Azure for the address (`az login` needed), or uses
`SIDEKICK_LIVE_URL` if set; the address is never written into the repo. The store listing's website,
privacy (`/privacy`) and terms (`/terms`) links use `SIDEKICK_WEBSITE_URL` if set (e.g. a custom domain),
otherwise the app's own address, which serves those pages.

- **Install it once, for the whole org**: Teams admin center → Teams apps → Manage apps → **Upload new app**.
  People then add Sidekick from **Built for your org** in any team, channel or chat. Don't upload it per
  chat: every per-person or per-chat upload can show up as another "Sidekick" in Manage your apps.
- **Updating**: bump `version` in the template, rebuild, then in Manage apps open Sidekick → **Upload file**.
  Chats and channels keep the app (and their links in the portal, which belong to the chat, not the app).
- **Reading every message** (chat tracking) needs the package's resource-specific consent permissions
  (`ChannelMessage.Read.Group`, `ChatMessage.Read.Chat`) *and* the tenant allowing that consent. Teams and
  chats have separate tenant settings, so tracking can work in a channel but not in a group chat.
- **1.3.0** adds the `add` / `remove` commands, store-ready website/privacy/terms links and wording for the
  chat picker. `webApplicationInfo` names `ENTRA_CLIENT_ID` (the multi-tenant app) when it's set, otherwise the
  bot's app as before: that's the app Microsoft treats as "Sidekick itself" for removing itself from chats.
- **Single- or multi-tenant** is set on the server, not in the package: today `TENANT_ID` (Sidekick Labs)
  keeps Sidekick to that tenant; `SIDEKICK_MULTI_TENANT=1` (plus a multi-tenant Entra app in `ENTRA_CLIENT_ID`
  / `ENTRA_CLIENT_SECRET`) serves any company that signed up, with the bot still single-tenant (lib/tenants.ts).
  Switching needs Azure/Entra/Store steps first: follow [TEAMS-MULTITENANT.md](TEAMS-MULTITENANT.md).
- `-- --local` builds `sidekick-teams-local.zip` with the dev tunnel address instead. It's the same app to
  Teams (same ID), so uploading it replaces the live one, and it's only useful while the bot's endpoint
  points at the tunnel. Upload the live package again afterwards.

## Monitoring and alerts (October 20, 2026)

Day to day, watch the business and the app's health in the **Owner Console → Business** page (MRR,
margin, limits, trials, payments, health checks, running release, app errors). The Azure pieces below are
the safety net that alerts when the app itself is down.

- **Health probes** on `sidekick-app`: *startup* and *readiness* call `/api/health` (200 only when the
  database answers); *liveness* is a plain port check, so a database blip takes the app out of traffic
  instead of restarting it in a loop. Probes are part of the revision template: a deploy keeps them.
- **Logs**: the Container Apps environment sends console and system logs to the Log Analytics workspace
  `sidekick-logs` (East US, 30-day retention, **hard cap 0.1 GB/day**, so at most ~3 GB/month, within the
  5 GB/month free allowance). Query `ContainerAppConsoleLogs_CL` / `ContainerAppSystemLogs_CL` in the portal
  (Log Analytics → Logs), or the live stream with `az containerapp logs show`.
- **Uptime test**: Application Insights `sidekick-insights` (on the same workspace) runs a standard test
  `sidekick-health-test` of `/api/health` every 15 minutes from East US and Central US (with retry and a
  TLS-certificate check: warns 14 days before expiry). Billed per run: $0.0005 × 5,760 runs ≈ **$2.90/month**.
- **Alerts** (action group `sidekick-alerts-ag`, emails both budget addresses):
  - `sidekick-site-down` (severity 1): availability below 50% over 30 minutes, i.e. about two failed checks.
  - `sidekick-app-restarts` (severity 2): the container restarted in the last 15 minutes.
  - What to do: `docs/RUNBOOKS.md` → The site is down.
- **Security headers** (`app/next.config.ts`): HSTS, `X-Frame-Options: DENY`, `nosniff`, a strict
  referrer policy, no `x-powered-by`, and an enforced Content-Security-Policy (started report-only in PR #25;
  enforced by the app security fixes in PR #22 after the portal showed no violations under it). If a page
  breaks after a deploy, look for "Content Security Policy" errors in the browser console.

## Budgets and alerts

Monthly budgets, each emailing cody.l.scott@outlook.com and CodyScott@SidekickLabs334.onmicrosoft.com
at 50%, 80% and 100% actual spend and at 100% forecast: `sidekick-total-50` (whole subscription, $50),
`sidekick-app-hosting` ($20), `sidekick-app-environment` ($5), `sidekick-database` ($20),
`sidekick-registry` ($7), `sidekick-ai-foundry` ($10), `sidekick-search` ($3), `sidekick-bot` ($2).
The older `sidekick-monthly-25` ($25, alerts at 80% / forecast 100%) is still there; delete it in Cost
Management if the extra early warning isn't wanted. Budget data lags Azure usage by up to a day.

**Automatic freeze:** when `sidekick-total-50` passes 100% of actual spend, its alert also calls action
group `sidekick-freeze-ag`, which runs Logic App `sidekick-freeze`. That Logic App stops `sidekick-app`
and `sidekick-labs-db` (the same as `freeze.sh`). Its managed identity has only the custom role
**Sidekick Freeze** on `sidekick-rg` (since Oct 21, 2026; Contributor before): read, stop and start the
Container App and the Postgres server, nothing else. Dry run that day: the Logic App was briefly pointed at
"start" (harmless on running resources) and run; Azure accepted both calls (the database answered "isn't
stopped", not "not allowed"), then the saved definition was restored. Budget data lags real usage by up to a day, so spend can go a
little past $50 before the freeze runs. Run `./unfreeze.sh` to start things again (and raise the budget
first if it would trip again). Not test-fired yet, because firing it takes the live app down.

## Security review (October 16, 2026)

- App: HTTPS only (insecure off); Teams calls without Microsoft's signature are refused (401).
- First-run Setup is open until the first account exists; it was claimed by Cody right after deploy.
- Owner Console setup (and first-run setup) in production needs the one-time `SIDEKICK_SETUP_CODE` secret
  (at least 16 characters; without it production refuses setup). To create the owner account: add the
  secret to the Container App, open `/owner/setup`, enter it, then remove the secret. (Oct 2026: the
  live owner account didn't exist yet; see `docs/security/`.)
- Sign-in (Oct 20, 2026, PR #30): two-step sign-in (passkeys, authenticator apps, backup codes) for portal and
  Owner Console accounts; authenticator secrets encrypted at rest with `SIDEKICK_ENCRYPTION_KEY` (above). New
  passwords are checked against Have I Been Pwned with its k-anonymity range API: only the first 5 characters
  of the password's SHA-1 hash leave the server (with padding), never the password. If HIBP can't be reached in
  3 seconds the password is accepted on length alone and the log gets a `[passwords] Breached-password check
  unavailable` warning. Locked-out accounts: `docs/RUNBOOKS.md` → Locked out.
- Registry: admin user and anonymous pull off.
- Database: TLS required, random 32-character password; firewall allows Azure services only (the app's
  outgoing addresses are a long shared list that can change, so they aren't pinned). Private networking
  is the stronger option later (costs more).
- Entra app: single tenant, implicit grant off, secret valid until 2027-04-13. Redirect URIs: the live
  address plus localhost:3000/3301. The dev tunnel address was removed and the tunnel stopped.
- Bot: single tenant; Teams channel plus Azure's default Web Chat test channel (needs a secret).
- Secrets and rights (Oct 21, 2026): secrets in Key Vault, narrow custom roles for the deployer and the freeze
  Logic App, the deploy guard, and the Org Owner switch **Require two-step sign-in for everyone** (for
  email/password organizations; Microsoft sign-in is exempt; `docs/guide/admin-guide.md`).

## Data

Backups: Postgres point-in-time backups are kept **35 days** (raised from 7 on Oct 20, 2026; included in
the server's storage, $0), in one region (geo-redundant backup can only be chosen when a server is
created). Restore steps: `docs/RUNBOOKS.md` → Restore the database. Not yet done: one test restore.

The cloud database started empty. Org "Test Suite" (Org Owner Cody, cody.l.scott@outlook.com) with the
made-up Contoso workspace from `samples/` (9 documents, 8 meetings). Local data on the Mac is separate.

## Scheduled work: the job queue (October 23, 2026)

Everything that runs on a clock (daily Teams reminders, leaving unassigned chats, roll-off deletions, the
watchers, clean-up) is a **job** in the database-backed job queue (`app/src/lib/jobs.ts`, kinds in
`app/src/lib/job-kinds.ts`). Something has to "beat" the queue: when the server starts,
`app/src/instrumentation.ts` calls `POST /api/jobs/tick` on itself every **30 seconds** with a random
per-start token. Each beat enqueues the recurring jobs whose slot has come (once per slot, whatever the number
of copies) and runs due jobs. No extra Azure resource or cost.

Safe with several copies: every copy beats, and each job is claimed with a lease (Postgres
`FOR UPDATE SKIP LOCKED` + a compare-and-set update), so it runs once. Failed jobs retry with backoff; after 5
attempts they're "dead" and listed in **Owner Console → Job queue** (Retry / Cancel). Stuck queue: see
`docs/RUNBOOKS.md` → Job queue stuck.

When to switch to an **Azure Container Apps job** (a scheduled container, cron `* * * * *`): only if the app
ever scales to zero (nothing would beat). Then:
1. Set `SIDEKICK_TICK_SECRET` (a long random value, as a Container App secret) on the app, and
   `SIDEKICK_SCHEDULER=off` so the in-app heartbeat stops.
2. Create the job in `sidekick-env` running `curl -fsS -X POST -H "x-sidekick-tick: $SECRET" https://<app>/api/jobs/tick`
   with the same secret. (`/api/reminders/tick`, the old name, does the same.) Cost: a few seconds of compute a
   minute, inside the free grant.

Without the right header the route answers 404. Pausing **Reminders in Teams** in the Owner Console stops
all reminders immediately; pausing **Watchers' AI checks** stops only the watchers' AI step.

## Self-service sign-up
Off on every new deploy: `/signup` refuses with "Sign-up isn't open yet" until you open it, so nobody can
create organizations (and spend Claude credit) on the live site by surprise. To open it, either flip
**Owner Console → Releases & switches → Self-service sign-up**, or set `SIDEKICK_SIGNUP_OPEN=true` on the
Container App. The console switch, once flipped, wins over the setting. Payments are test mode only.

## Scaling up: the plan for 100 companies / 10,000 groups (October 23, 2026; NOT done yet)
Measured on a local copy with the load test (`docs/SCALE.md`). Nothing here has been changed in Azure: each step
needs Cody's go-ahead because it costs money. Step-by-step instructions: `docs/RUNBOOKS.md` → Scaling up.
Prices are approximate pay-as-you-go list prices (US regions, October 2026); check the Azure pricing calculator
or the portal's estimate before buying.

| Step | When | Change | Extra cost / month |
|---|---|---|---|
| 1. Search: Free → **Basic** | Before the first real customer. Free holds only 50 MB / 10,000 passages; one busy group fills it | AI Search `Basic` (15 GB per partition) | ~$75 |
| 2. Database: B1ms → **B2s** | ~10 companies or 1,000 groups, or CPU over 70% for an hour | Burstable B2s (2 vCores, 4 GiB, ~430 connections) | ~+$35 (≈$50 total) |
| 3. App: **2–4 copies** with auto-scaling | When one copy's CPU is over 60% at busy hours, or before a launch | Container App min 2 / max 4 copies, scale rule "50 requests at once per copy"; 1 vCPU / 2 GiB each | ~+$30–100 (≈$35 per busy copy) |
| 4. Database: **General Purpose D2ds_v5** | ~50 companies / 5,000 groups, or B2s CPU credits running out | 2 vCores, 8 GiB, ~860 connections, no CPU credits; zone-redundant HA optional (doubles it) | ≈$130 total (≈$78 with a 1-year reservation) |
| 5. Search: Basic → **Standard S1** | Past ~1 million passages (about 1,000 busy groups) or Basic's vector quota | S1 (one partition; add a replica for 99.9% uptime) | ≈$245 per unit (+$245 per replica) |
| 6. Scheduled heartbeat as a **Container Apps job** | Only if the app may scale to zero copies | cron `* * * * *` calling `/api/jobs/tick` (see "Scheduled work" above) | ~$0 (inside the free grant) |

Rough totals: today ~$45/month. At ~10 companies (steps 1–2) ~$140. At 100 companies / 10,000 groups (steps 1–5,
3 app copies) **~$500–600/month** before Claude, which is billed by Anthropic per use and is by far the biggest
cost at that size (see the Owner Console's business view).

What the app already does for this (no Azure change needed):
- **Several copies are safe**: the job queue's leases run each job once; every copy beats the queue
  (`app/src/instrumentation.ts`); Postgres schema setup takes an advisory lock.
- **Connections**: each copy opens at most `DATABASE_POOL_MAX` connections (default 10) and waits at most
  `DATABASE_POOL_WAIT_MS` (15 s) for one. Keep copies × pool under the database's user connections: B1ms 35 (so
  at most 3 copies at 10), B2s ~410, D2ds_v5 ~840. With a bigger database, raise the pool to 20.
- **Claude turns**: each copy runs at most `SIDEKICK_CLAUDE_CONCURRENCY` (24) Claude calls at once, at most
  `SIDEKICK_CLAUDE_ORG_CONCURRENCY` (6) for one company. With N copies the account sees up to 24 × N at once:
  keep that under the Anthropic tier's limits (Anthropic Console → Limits), or lower the setting per copy.
- **Background work**: `SIDEKICK_JOB_CONCURRENCY` (4) jobs at once per copy, at most `SIDEKICK_JOB_ORG_CONCURRENCY`
  (2) per company. Each extra copy adds 4 more lanes.
