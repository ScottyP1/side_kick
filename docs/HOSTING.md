# Hosting Sidekick in Azure

Sidekick runs in Cody's Sidekick Labs Azure subscription (pay-as-you-go), resource group `sidekick-rg`,
signed in as CodyScott@SidekickLabs334.onmicrosoft.com. Set up October 16, 2026.

**Live address:** https://sidekick-app.thankfulsky-373e157d.eastus.azurecontainerapps.io (health: `/api/health`)

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

Claude itself is still called with the Anthropic API key (not yet via Foundry); set a monthly spend limit
in the Anthropic console too, since Azure budgets don't see that spend.

Why not App Service: this subscription has a quota of 0 for App Service B1, and B1ms Postgres had no
capacity in East US / East US 2 when set up, hence Container Apps and Central US.

## Settings and secrets

Container App environment variables come from `app/.env.local` (never printed or committed):
`ANTHROPIC_API_KEY`, `CLIENT_SECRET`, `AZURE_SEARCH_API_KEY`, `AZURE_OPENAI_API_KEY` and `DATABASE_URL` are
Container App **secrets** (encrypted, referenced with `secretref:`); the rest are plain settings,
plus `SIDEKICK_PUBLIC_URL` (the live address) and `AZURE_SEARCH_INDEX=sidekick-cloud`.
The database admin password was generated at random and only exists inside `DATABASE_URL`.

The image is pulled with the app's managed identity (AcrPull role); the registry's admin user is off.

## Deploy, freeze, unfreeze

Scripts in `infra/azure/` (run after `az login`):

- `./deploy.sh`: builds `origin/main` in the registry and switches the app to it. It prints the version
  that was live before, waits up to 5 minutes for `/api/health` to answer ok, and otherwise prints the
  rollback command. What to do when things go wrong (rollback, restore, rotate secrets, incident): `docs/RUNBOOKS.md`.
- `./status.sh`: is the app/database running, and every budget's limit and spend this month.
- `./freeze.sh`: stops the app and the database (use when a budget alert arrives). Registry (~$5) and
  database storage (~$4) are still billed while frozen. Azure restarts a stopped Postgres after 7 days.
- `./unfreeze.sh`: starts them again.

## Automatic deploys (GitHub Actions)

Every merge to `main` that changes the app (`app/`, `teams/` or the workflows) deploys itself:
`.github/workflows/deploy.yml` runs the full test suite on the merged code, builds the image in
`sidekicklabsacr`, switches `sidekick-app` to it and waits until the new revision gets all traffic, is
healthy and `/api/health` answers ok. If not within ~5 minutes it **rolls back** to the previous image and
the run fails (GitHub emails the repo owner). One deploy at a time. Docs-only merges don't deploy; the
Actions tab has **Run workflow** for a manual deploy, and `./infra/azure/deploy.sh` still works from the Mac.

- **No stored Azure password.** GitHub's own login token (OIDC) is exchanged for the user-assigned managed
  identity `sidekick-deployer` (resource group `sidekick-rg`), which has a federated credential trusting
  only `repo:ScottyP1/side_kick:ref:refs/heads/main`. Its roles: Contributor on `sidekicklabsacr` (image
  builds) and on `sidekick-app` (switch the image). Nothing else: not the database, the other services or
  the subscription.
- **Repository variables** (Settings → Secrets and variables → Actions → Variables; ids, not secrets):
  `AZURE_CLIENT_ID` (the identity's client id), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
- **No manual approval gate:** GitHub's "required reviewers" for environments needs a paid plan on private
  repos, so merging *is* releasing. Keep the rule: merge only reviewed PRs with a green `test` check.
- **Stop automatic deploys** (e.g. during an incident): Actions → Deploy → ⋯ → Disable workflow.
- Rollback by hand: `docs/RUNBOOKS.md` → Roll back.

## Teams app package

There is **one** Sidekick app in Teams: its app ID is the Azure Bot's ID, and Teams sends its messages to
the bot's messaging endpoint (the live address above). Build the package with:

```bash
npm --prefix app run teams:package
```

That writes `teams/build/sidekick-teams-live.zip` (version from `teams/manifest.template.json`, now 1.2.0),
with the live address as its web address. It asks Azure for the address (`az login` needed), or uses
`SIDEKICK_LIVE_URL` if set; the address is never written into the repo.

- **Install it once, for the whole org**: Teams admin center → Teams apps → Manage apps → **Upload new app**.
  People then add Sidekick from **Built for your org** in any team, channel or chat. Don't upload it per
  chat: every per-person or per-chat upload can show up as another "Sidekick" in Manage your apps.
- **Updating**: bump `version` in the template, rebuild, then in Manage apps open Sidekick → **Upload file**.
  Chats and channels keep the app (and their links in the portal, which belong to the chat, not the app).
- **Reading every message** (chat tracking) needs the package's resource-specific consent permissions
  (`ChannelMessage.Read.Group`, `ChatMessage.Read.Chat`) *and* the tenant allowing that consent. Teams and
  chats have separate tenant settings, so tracking can work in a channel but not in a group chat.
- `-- --local` builds `sidekick-teams-local.zip` with the dev tunnel address instead. It's the same app to
  Teams (same ID), so uploading it replaces the live one, and it's only useful while the bot's endpoint
  points at the tunnel. Upload the live package again afterwards.

## Monitoring and alerts (October 20, 2026)

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
  referrer policy, no `x-powered-by`, and a Content-Security-Policy in **report-only** mode (switch it to
  enforcing once the browser console shows no reports).

## Budgets and alerts

Monthly budgets, each emailing cody.l.scott@outlook.com and CodyScott@SidekickLabs334.onmicrosoft.com
at 50%, 80% and 100% actual spend and at 100% forecast: `sidekick-total-50` (whole subscription, $50),
`sidekick-app-hosting` ($20), `sidekick-app-environment` ($5), `sidekick-database` ($20),
`sidekick-registry` ($7), `sidekick-ai-foundry` ($10), `sidekick-search` ($3), `sidekick-bot` ($2).
The older `sidekick-monthly-25` ($25, alerts at 80% / forecast 100%) is still there; delete it in Cost
Management if the extra early warning isn't wanted. Budget data lags Azure usage by up to a day.

**Automatic freeze:** when `sidekick-total-50` passes 100% of actual spend, its alert also calls action
group `sidekick-freeze-ag`, which runs Logic App `sidekick-freeze`. That Logic App stops `sidekick-app`
and `sidekick-labs-db` (the same as `freeze.sh`). Its managed identity has Contributor on `sidekick-rg`
only (nothing else in the subscription). Budget data lags real usage by up to a day, so spend can go a
little past $50 before the freeze runs. Run `./unfreeze.sh` to start things again (and raise the budget
first if it would trip again). Not test-fired yet, because firing it takes the live app down.

## Security review (October 16, 2026)

- App: HTTPS only (insecure off); Teams calls without Microsoft's signature are refused (401).
- First-run Setup is open until the first account exists; it was claimed by Cody right after deploy.
  The Owner Console setup only works from localhost. Proposed: a one-time setup code for production.
- Registry: admin user and anonymous pull off.
- Database: TLS required, random 32-character password; firewall allows Azure services only (the app's
  outgoing addresses are a long shared list that can change, so they aren't pinned). Private networking
  is the stronger option later (costs more).
- Entra app: single tenant, implicit grant off, secret valid until 2027-04-13. Redirect URIs: the live
  address plus localhost:3000/3301. The dev tunnel address was removed and the tunnel stopped.
- Bot: single tenant; Teams channel plus Azure's default Web Chat test channel (needs a secret).

## Data

Backups: Postgres point-in-time backups are kept **35 days** (raised from 7 on Oct 20, 2026; included in
the server's storage, $0), in one region (geo-redundant backup can only be chosen when a server is
created). Restore steps: `docs/RUNBOOKS.md` → Restore the database. Not yet done: one test restore.

The cloud database started empty. Org "Test Suite" (Org Owner Cody, cody.l.scott@outlook.com) with the
made-up Contoso workspace from `samples/` (9 documents, 8 meetings). Local data on the Mac is separate.

## Scheduled work: reminders (October 17, 2026)

Daily Teams reminders need something to run on a clock. For now that's an **in-app timer**: when the
server starts, `app/src/instrumentation.ts` calls `POST /api/reminders/tick` on itself every 5 minutes
with a random per-start token. That fits how the app is hosted: exactly **one always-on copy**
(min = max = 1 replica), so the timer is always running and there is no extra Azure resource or cost.

Safe with more copies: each reminder claims a unique row (`reminder_runs`, one per chat and day) before
it's built, so two copies would never post twice; they'd only both check.

When to switch to an **Azure Container Apps job** (a scheduled container, cron `*/5 * * * *`): if the app
ever scales to zero, runs several copies, or the timer should be visible and retryable in Azure. Then:
1. Set `SIDEKICK_TICK_SECRET` (a long random value, as a Container App secret) on the app, and
   `SIDEKICK_SCHEDULER=off` so the in-app timer stops.
2. Create the job in `sidekick-env` running `curl -fsS -X POST -H "x-sidekick-tick: $SECRET" https://<app>/api/reminders/tick`
   with the same secret. Cost: a few seconds of compute every 5 minutes, well inside the free grant.

Without the right header the route answers 404. Pausing **Reminders in Teams** in the Owner Console stops
all reminders immediately.
