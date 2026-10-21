# Runbooks: what to do when something goes wrong

Step-by-step fixes for the live Azure site (resource group `sidekick-rg`). Run the commands on the Mac after
`az login`. Never paste a secret value into chat, a ticket or this repo: type it into the command, or read
it from where it lives. Background and costs are in `docs/HOSTING.md`; the October 2026 security and
operations review is in `docs/security/`.

**Quick reference**

| Situation | Go to |
|---|---|
| A deploy broke the site | [Roll back](#roll-back-a-bad-deploy) |
| Data deleted or corrupted | [Restore the database](#restore-the-database) |
| A key may have leaked, or it's expiring | [Rotate secrets](#rotate-secrets) |
| Someone broke in, or something is badly wrong | [Incident](#incident-leaked-key-break-in-data-loss) |
| The site is down (uptime alert email) | [Site down](#the-site-is-down) |
| Microsoft 365 trial ends Nov 14, 2026 | [Trial end](#microsoft-365-trial-ending-nov-14-2026) |

## Roll back a bad deploy

`./infra/azure/deploy.sh` prints the version that was live before and, if the new one isn't healthy within
five minutes, the exact rollback command. Every image tag is kept in the registry, so any earlier version
can come back:

```bash
az acr repository show-tags -n sidekicklabsacr --repository sidekick --orderby time_desc --top 10 -o tsv
```

```bash
az containerapp update -g sidekick-rg -n sidekick-app --image sidekicklabsacr.azurecr.io/sidekick:<tag>
```

Then check `https://<the live address>/api/health` answers `"ok":true`.

- A rollback changes only the code. Database tables added by the newer version stay (they're
  `CREATE … IF NOT EXISTS`, so the older code just ignores them); nothing is dropped.
- Fix the problem on a branch, merge, and deploy again as usual.

## Restore the database

Postgres (`sidekick-labs-db`) keeps point-in-time backups (35 days, see HOSTING → Data). A restore always
creates a **new** server; the live one is untouched until you switch.

1. Pick a time just before the problem (UTC), then restore to a new server:
   ```bash
   az postgres flexible-server restore -g sidekick-rg --name sidekick-labs-db-restore --source-server sidekick-labs-db --restore-time "2026-10-20T12:00:00Z"
   ```
   This takes about 10–20 minutes and bills a second small server while it exists.
2. Give it the same firewall rule as the live server ("Allow Azure services"):
   ```bash
   az postgres flexible-server firewall-rule create -g sidekick-rg --name sidekick-labs-db-restore --rule-name AllowAzure --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
   ```
3. Check the data is what you expect (connect with `psql` using the same user and password; only the host
   name changes).
4. Switch the app: set the `database-url` secret to the new host, then restart.
   ```bash
   az containerapp secret set -g sidekick-rg -n sidekick-app --secrets database-url="<new connection string>"
   ```
   ```bash
   az containerapp revision restart -g sidekick-rg -n sidekick-app --revision $(az containerapp show -g sidekick-rg -n sidekick-app --query properties.latestRevisionName -o tsv)
   ```
5. The search index rebuilds itself from Postgres (`reindexAzure` in `app/src/lib/search.ts`); nothing to do.
6. Once happy, delete the old server (or keep it a few days, then delete) and update `docs/HOSTING.md`
   with the new server name and its budget.

**Only one thing to undo?** (one deleted workspace or document): restore to a new server as above, copy
just those rows back, and delete the restored server, instead of switching the whole app.

## Rotate secrets

The live app's secrets are Container App secrets (`az containerapp secret list -g sidekick-rg -n sidekick-app -o table`
shows names only). After changing one, start a new revision (step at the end) so the app picks it up.

| Secret | Where it's made | Notes |
|---|---|---|
| `anthropic-api-key` | console.anthropic.com → API keys | Create the new key, set it, then delete the old one. |
| `client-secret` | Entra admin center → App registrations → **Sidekick Bot** → Certificates & secrets | Current secret "sidekick dev" **expires 2027-04-13**. Create a new one, set it, delete the old one. Also update `app/.env.local` if the laptop should keep working. |
| `azure-search-api-key` | `az search admin-key renew -g sidekick-rg --service-name sidekick-labs-search --key-kind secondary` | Switch the app to the secondary key, then renew the primary (no downtime). |
| `azure-openai-api-key` | `az cognitiveservices account keys regenerate -g sidekick-rg -n codyscott-9578-resource --key-name key2` | Same two-key swap as Search. |
| `database-url` | `az postgres flexible-server update -g sidekick-rg -n sidekick-labs-db --admin-password "<new>"` | Then rebuild the connection string with the new password. |

Set a new value (repeat per secret):

```bash
az containerapp secret set -g sidekick-rg -n sidekick-app --secrets anthropic-api-key="<new value>"
```

Then restart so the app reads it:

```bash
az containerapp revision restart -g sidekick-rg -n sidekick-app --revision $(az containerapp show -g sidekick-rg -n sidekick-app --query properties.latestRevisionName -o tsv)
```

Check `/api/health`, ask one question in the portal and one `@Sidekick` question in Teams.

## Incident: leaked key, break-in, data loss

1. **Stop the damage.** Either the Owner Console kill switch (pauses the portal and Teams for every client,
   data stays) or, if the Azure resources themselves may be abused, `./infra/azure/freeze.sh` (stops the app
   and the database).
2. **Rotate every secret** above, not just the one you suspect. Also change the Azure/Entra admin password
   and sign out its other sessions (Entra → Users → Revoke sessions).
3. **Look at what happened:** the portal's Security & audit page (who did what), Activity → Traces
   (requests, errors), Entra admin center → Sign-in logs (unexpected countries or failed sign-ins), the
   container logs in Log Analytics (`ContainerAppConsoleLogs_CL`), GitHub → Settings → Security log.
4. **Data lost or changed?** [Restore the database](#restore-the-database) to just before it happened.
5. **Bring it back:** `./infra/azure/unfreeze.sh` or turn the kill switch off; check health, sign in, ask
   a question.
6. **Write it down** in `docs/PROGRESS.md`: what happened, when, what was exposed, what changed. If client
   data may have been seen by someone else, the affected organizations must be told.

## The site is down

The uptime alert emails when `/api/health` fails from Azure's test locations (HOSTING → Monitoring).

1. Open `https://<the live address>/api/health`.
   - **503 with `"reachable":false`**: the database is down or unreachable. Check it:
     `az postgres flexible-server show -g sidekick-rg -n sidekick-labs-db --query state -o tsv`
     (`Stopped`: someone froze it or Azure's 7-day auto-start; run `./infra/azure/unfreeze.sh`).
   - **No answer / 404 "Container App – Unavailable"**: the app isn't running. `./infra/azure/status.sh`,
     then the logs: `az containerapp logs show -g sidekick-rg -n sidekick-app --tail 100 --type console`.
2. Just deployed? [Roll back](#roll-back-a-bad-deploy).
3. A budget freeze? `status.sh` shows the app stopped and a budget at 100%: decide whether to raise the
   budget, then `unfreeze.sh`.

## Microsoft 365 trial ending Nov 14, 2026

The Sidekick Labs tenant (Teams, the bot's home, the test users, one of the alert mailboxes) runs on a
Microsoft 365 Business Basic trial that turns into a paid subscription ($8.40/month + tax, 1 license) on
**Nov 15** unless cancelled. **Never turn off recurring billing on a trial: that cancels it.**

- **Keep it:** nothing to do; check the first charge on the Visa.
- **Cancel it** (before Nov 15): Teams, the test chats and the `…@SidekickLabs334.onmicrosoft.com`
  mailbox stop working. Should keep working: the Entra tenant (sign-in to Azure, the Entra app), the Azure
  subscription and the live portal. Before cancelling: turn off the bot's Teams channel and the reminders
  switch (Owner Console), make sure budget and uptime alerts also go to the outlook.com address (they do
  as of Oct 2026), and note in PROGRESS that Teams testing needs a new tenant.
