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
| Locked out of the portal or the Owner Console | [Locked out](#locked-out-of-the-portal-or-the-owner-console) |

## Roll back a bad deploy

Automatic deploys (GitHub Actions → Deploy) roll back by themselves when the new version isn't healthy within
five minutes. `./infra/azure/deploy.sh` prints the version that was live before and, if the new one isn't
healthy, the exact rollback command. To pause automatic deploys: Actions → Deploy → ⋯ → Disable workflow. Every image tag is kept in the registry, so any earlier version
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
| `encryption-key` (`SIDEKICK_ENCRYPTION_KEY`) | `openssl rand -base64 32` (HOSTING → Settings and secrets) | **Don't rotate casually**: authenticator-app secrets encrypted with the old key stop opening, so everyone with an authenticator app must remove and re-add it (passkeys and backup codes keep working). Rotate only if it leaked. |
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

## Locked out of the portal or the Owner Console

Nobody on the web can reset an Org Owner's or an owner's password (on purpose: there is no reset email to
steal). Whoever has the database can, with one command on the Mac. It sets a **one-time temporary
password**, prints it **only in your terminal**, signs that account out everywhere, clears its failed
sign-ins, and records it (the organization's Security & audit page, or the Owner Console's operator log).
The next sign-in must pick a new password before anything else works.

**Live site** (after `az login` as the Sidekick Labs account, from the repo root; `npm --prefix app ci` once):

```bash
./infra/azure/reset-password.sh you@example.com
```

- Use the email you sign in to the portal with. It prints your name, role and organization, then the
  temporary password. Paste it into the sign-in page (or your password manager) straight away; never into
  chat, email or a ticket. Then pick your own password (a password manager can make a long one).
- **Owner Console** account instead: put `--owner` in front of the email. If there's no owner account yet
  on the live site (the first one can otherwise only be made on localhost), this creates it; add
  `--name "Your name"` to set the name.
- Lost your phone **and** your backup codes (two-step sign-in)? Add `--reset-2fa` at the end: it also
  removes the account's authenticator app, passkeys and backup codes (audited). Set them up again once
  you're in. Without it, two-step sign-in stays on and is asked after the temporary password.
- If your organization has **Require Microsoft sign-in** on and Microsoft sign-in is what's broken, add
  `--allow-password` at the end: it also turns that setting off (audited). Turn it back on in Settings
  once you're in.
- The live database only accepts Azure traffic, so the script lets this Mac's public IP address in for
  the run only (firewall rule `reset-password-tmp`, takes about a minute) and removes it afterwards (an exit
  trap: also when the reset fails or you press Ctrl-C). If it ever says it couldn't remove the rule, run the
  command it prints.
- **Nothing secret is printed** except the temporary password: the `database-url` secret is read into a
  variable and handed only to the reset script, never shown or saved, and any error has the database URL and
  its password blanked out. Only the database's host name is shown, so you know which one you changed.
- The database must be running (`./infra/azure/status.sh`; if frozen, `./infra/azure/unfreeze.sh`).

**Laptop copy** (SQLite in `app/data`, or whatever `DATABASE_URL` points to):

```bash
npm --prefix app run reset-password -- you@example.com
```

Same options (`--owner`, `--name`, `--allow-password`, `--reset-2fa`). Someone else in your organization locked out? An
Org Owner or Org Admin can also just remove and re-add them on Users & access, without this script.
