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
| A merge didn't deploy ("Deploy skipped") | [Deploy skipped](#deploy-skipped) |
| Set up (or renew) the Azure DevOps / Jira connector apps | [Connector apps](#connector-apps-azure-devops-and-jira) |
| A customer's connector shows "Sign-in expired" or a problem | [Connector problems](#connector-problems) |
| Reminders/watchers stopped, Owner Console → Job queue shows a backlog, stuck or dead jobs | [Job queue stuck](#job-queue-stuck) |

## Roll back a bad deploy

Automatic deploys (GitHub Actions → Deploy) roll back by themselves when the new version isn't answering
`/api/health` with its own commit within ten minutes. `./infra/azure/deploy.sh` prints the version that was live before and, if the new one isn't
healthy, the exact rollback command. To pause automatic deploys: Actions → Deploy → ⋯ → Disable workflow. Every image tag is kept in the registry, so any earlier version
can come back:

```bash
az acr repository show-tags -n sidekicklabsacr --repository sidekick --orderby time_desc --top 10 -o tsv
```

```bash
az containerapp update -g sidekick-rg -n sidekick-app --image sidekicklabsacr.azurecr.io/sidekick:<tag> --set-env-vars SIDEKICK_COMMIT=<tag>
```

Then check `https://<the live address>/api/health` answers `"ok":true` and `"commit":"<tag>"`.

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
4. Switch the app: put the new connection string in Key Vault as a new version of `database-url`
   (type it into the command, or read it into a variable; never paste it into chat), then restart.
   ```bash
   az keyvault secret set --vault-name sidekick-kv -n database-url --value "<new connection string>" -o none
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

The live app's secrets live in **Key Vault `sidekick-kv`** (HOSTING → Settings and secrets); the Container App
only holds references to them. Names only: `az keyvault secret list --vault-name sidekick-kv --query "[].name" -o tsv`.
Changing one = adding a new **version** in the vault (the old version stays, so you can go back). The app
picks it up within about 30 minutes; restart (step at the end) to use it straight away.

| Secret | Where it's made | Notes |
|---|---|---|
| `anthropic-api-key` | console.anthropic.com → API keys | Create the new key, set it, restart, check, then delete the old one. |
| `client-secret` | Entra admin center → App registrations → **Sidekick Bot** → Certificates & secrets | Current secret "sidekick dev" **expires 2027-04-13**. Create a new one, set it, delete the old one. Also update `app/.env.local` if the laptop should keep working. |
| `azure-search-api-key` | `az search admin-key renew -g sidekick-rg --service-name sidekick-labs-search --key-kind secondary` | Switch the app to the secondary key, then renew the primary (no downtime). |
| `azure-openai-api-key` | `az cognitiveservices account keys regenerate -g sidekick-rg -n codyscott-9578-resource --key-name key2` | Same two-key swap as Search. |
| `encryption-key` (`SIDEKICK_ENCRYPTION_KEY`) | (exists since Oct 21, 2026) | **Never rotate casually**: authenticator-app secrets encrypted with the old key stop opening, so everyone with an authenticator app must remove and re-add it (passkeys and backup codes keep working). Rotate only if it leaked. |
| `ado-client-secret` (`ADO_CLIENT_SECRET`) | Entra admin center → App registrations → **Sidekick Connectors (Azure DevOps)** → Certificates & secrets | Note its expiry date here when you create it. New secret, set it, restart, connect once from a test org, delete the old one. Customers' connections keep working (their sign-ins aren't tied to the app secret). |
| `jira-client-secret` (`JIRA_CLIENT_SECRET`) | developer.atlassian.com → My apps → **Sidekick** → Settings → Rotate secret | Atlassian keeps the old secret working for a short overlap; set the new one and restart within it. |
| `database-url` | `az postgres flexible-server update -g sidekick-rg -n sidekick-labs-db --admin-password "<new>"` | Then rebuild the connection string with the new password. |

Set a new value without it showing on screen. Either type it at a hidden prompt:

```bash
read -rs "V?New value: " && az keyvault secret set --vault-name sidekick-kv -n anthropic-api-key --value "$V" -o none; unset V
```

or pipe it straight from the command that makes it (e.g. a renewed Search key):

```bash
az search admin-key show -g sidekick-rg --service-name sidekick-labs-search --query secondaryKey -o tsv | tr -d '\n' | az keyvault secret set --vault-name sidekick-kv -n azure-search-api-key --file /dev/stdin -o none
```

Then restart so the app reads it now:

```bash
az containerapp revision restart -g sidekick-rg -n sidekick-app --revision $(az containerapp show -g sidekick-rg -n sidekick-app --query properties.latestRevisionName -o tsv)
```

Check `/api/health`, ask one question in the portal and one `@Sidekick` question in Teams.

- **Go back to the previous value:** each change is a version. List them with
  `az keyvault secret list-versions --vault-name sidekick-kv -n <name> -o table`, then set the old one again
  (`az keyvault secret show --vault-name sidekick-kv -n <name> --version <id> --query value -o tsv | tr -d '\n' | az keyvault secret set --vault-name sidekick-kv -n <name> --file /dev/stdin -o none`) and restart.
- **App can't start after a change** (health 503, or the revision fails with a Key Vault error in
  `az containerapp logs show -g sidekick-rg -n sidekick-app --type system`): check the app's identity still has
  "Key Vault Secrets User" on the vault (`az role assignment list --scope $(az keyvault show -n sidekick-kv --query id -o tsv) -o table`).
- A secret deleted by mistake: `az keyvault secret recover --vault-name sidekick-kv -n <name>` (kept 90 days).

## Incident: leaked key, break-in, data loss

1. **Stop the damage.** Either the Owner Console kill switch (pauses the portal and Teams for every client,
   data stays) or, if the Azure resources themselves may be abused, `./infra/azure/freeze.sh` (stops the app
   and the database).
2. **Rotate every secret** above, not just the one you suspect. Also change the Azure/Entra admin password
   and sign out its other sessions (Entra → Users → Revoke sessions). Check nobody new has a role on the vault
   or the resource group (`az role assignment list -g sidekick-rg --all -o table`; only Cody, the app's
   identity, "Sidekick Deployer" and "Sidekick Freeze" belong there).
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
   - **`"ok":true` but `claude`/`teams` false, or the revision won't start**: a Key Vault reference may be
     failing; see [Rotate secrets](#rotate-secrets) → App can't start after a change.
   - **No answer / 404 "Container App – Unavailable"**: the app isn't running. `./infra/azure/status.sh`,
     then the logs: `az containerapp logs show -g sidekick-rg -n sidekick-app --tail 100 --type console`.
2. Just deployed? [Roll back](#roll-back-a-bad-deploy).
3. A budget freeze? `status.sh` shows the app stopped and a budget at 100%: decide whether to raise the
   budget, then `unfreeze.sh`.

## Job queue stuck

Every background task (daily reminders, leaving unassigned Teams chats, roll-off deletions, the watchers,
clean-up) is a job in the `jobs` table, run by a heartbeat every 30 seconds (HOSTING → Scheduled work).
Signs of trouble: reminders or "Needs attention" stop updating, or **Owner Console → Job queue** says
"Needs a look" (backlog waiting more than 5 minutes, stuck jobs, or dead letters).

1. **Is the heartbeat running?** Job queue page → "Last 24 hours … last" should be under a minute or two old.
   If not:
   - Is the app up (`/api/health`)? If not, [Site down](#the-site-is-down).
   - Is `SIDEKICK_SCHEDULER=off` set on the Container App without an external scheduler (HOSTING)? Remove it,
     or set up the Container Apps job.
   - Logs: `az containerapp logs show -g sidekick-rg -n sidekick-app --tail 200 --type console | grep -i "heartbeat\|Job "`.
     "Job heartbeat: the tick answered 5xx" means the tick route itself fails: the reference code in the
     Owner Console → Performance & errors says why (usually the database).
2. **Stuck jobs** (running, lease ran out): the worker stopped mid-job (deploy, crash). Nothing to do: the next
   beat takes the job over (that counts as an attempt). If they keep coming back, the job itself hangs; check
   its kind's logs.
3. **Dead letters** (gave up after its attempts): read "Last error" (a reason, never client content).
   - Fix the cause first (e.g. Teams or Microsoft Graph refusing, a feature paused, the database full).
   - Then **Retry** on the row (fresh attempts) or **Cancel** if it's no longer needed. A recurring job
     (reminders, watchers…) doesn't need a retry: its next slot runs on its own.
4. **Need everything to run now** (after fixing something): **Run all now** on the Job queue page.
5. **Last resort, in the database** (Postgres, `psql` as in [Restore the database](#restore-the-database)):
   ```sql
   -- what's waiting and why
   SELECT kind, status, COUNT(*), MIN(run_at), MAX(attempts) FROM jobs WHERE status IN ('queued','running','dead') GROUP BY kind, status;
   -- release every lease (only when no copy of the app is running a job, e.g. app stopped)
   UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL WHERE status = 'running';
   ```
   Never delete `queued` rows of a kind you don't understand: a roll-off deletion job deletes client data on
   purpose and must finish or be canceled in the Owner Console (Roll-offs) instead.

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
  you're in. Without it, two-step sign-in stays on and is asked after the temporary password. If the
  organization has **Require two-step sign-in for everyone** on, the portal shows only **Set up two-step
  sign-in** after the new password until a method is added: that's expected, not a lockout.
- The Org Owner turned on **Require two-step sign-in for everyone** and can't set up a method right now?
  Their setup screen has **Turn the requirement off** (Org Owner only, audited). Microsoft sign-in is never
  affected by the switch.
- If your organization has **Require Microsoft sign-in** on and Microsoft sign-in is what's broken, add
  `--allow-password` at the end: it also turns that setting off (audited). Turn it back on in Settings
  once you're in.
- The live database only accepts Azure traffic, so the script lets this Mac's public IP address in for
  the run only (firewall rule `reset-password-tmp`, takes about a minute) and removes it afterwards (an exit
  trap: also when the reset fails or you press Ctrl-C). If it ever says it couldn't remove the rule, run the
  command it prints.
- **Nothing secret is printed** except the temporary password: the `database-url` secret is read into a
  variable (read from Key Vault `sidekick-kv`, so you need "Key Vault Administrator" on it) and handed only
  to the reset script, never shown or saved, and any error has the database URL and
  its password blanked out. Only the database's host name is shown, so you know which one you changed.
- The database must be running (`./infra/azure/status.sh`; if frozen, `./infra/azure/unfreeze.sh`).

**Laptop copy** (SQLite in `app/data`, or whatever `DATABASE_URL` points to):

```bash
npm --prefix app run reset-password -- you@example.com
```

Same options (`--owner`, `--name`, `--allow-password`, `--reset-2fa`). Someone else in your organization locked out? An
Org Owner or Org Admin can also just remove and re-add them on Users & access, without this script.

## Deploy skipped

A merge to `main` whose Deploy run is green but shows **Deploy skipped** (Actions → Deploy → the run → the
warning and summary) wasn't deployed on purpose: the deploy guard (HOSTING → Automatic deploys) only ships the
merge commit of a pull request merged into `main` whose last commit has a green `test` check. The message
says which case it was:

- **"wasn't made by merging a pull request"**: someone pushed straight to `main`. Check the commit is what
  you want (GitHub → Commits). Normally: revert it and send it as a pull request. If it's fine and urgent,
  deploy it by hand (below).
- **"merged without a finished, green test check"** or **"test check failed"**: the PR was merged before its
  tests passed. Look at the failing test on the PR. Fix it in a new PR (that one deploys normally), or, if
  `main` itself is fine, deploy by hand: the manual run still runs the full test suite first and refuses to
  deploy if it fails.

**Deploy by hand:** GitHub → Actions → Deploy → **Run workflow** (branch `main`). Or from the Mac:
`./infra/azure/deploy.sh`. Both deploy the current `main`.

## Connector apps (Azure DevOps and Jira)

Sidekick's connectors (docs/guide/connect-devops-jira.md, code in `app/src/lib/connectors.ts`) need one app
registration per tool. **Only Cody creates these** (with his own personal accounts, never a client's), and the
secrets go straight into Key Vault; they are never pasted into chat, a ticket or the repo. Until an app exists, its
tile says "Not set up yet" and nothing else changes. Use the live address for `<site>` (SIDEKICK_PUBLIC_URL).

**Azure DevOps (Microsoft Entra ID; Azure DevOps' own OAuth apps are deprecated)**
1. entra.microsoft.com (the Sidekick Labs tenant) → **App registrations → New registration**.
   - Name: `Sidekick Connectors (Azure DevOps)`.
   - Supported account types: **Accounts in any organizational directory (Multitenant)**.
   - Redirect URI: **Web**, `https://<site>/api/connectors/callback`. After creating, add a second Web redirect
     URI `http://localhost:3000/api/connectors/callback` for the laptop.
2. **API permissions → Add a permission → APIs my organization uses →** search **Azure DevOps**
   (app id `499b84ac-1321-427f-aa17-267ca6975798`) → **Delegated** → tick **vso.work** ("Work items (read)") → Add.
   Nothing else is needed (`offline_access` for the refresh token is asked for at sign-in). Optionally **Grant admin
   consent** for the Sidekick Labs tenant so your own test sign-in doesn't ask.
3. **Certificates & secrets → New client secret** (24 months). Copy the **Value** once and store it at the hidden
   prompt (it never shows on screen):
   ```bash
   read -rs "V?ado-client-secret: " && az keyvault secret set --vault-name sidekick-kv -n ado-client-secret --value "$V" -o none; unset V
   ```
   Write the expiry date into the Rotate secrets table above.
4. Point the app at it (the application (client) id is on the app's Overview page; it isn't a secret):
   ```bash
   az containerapp secret set -g sidekick-rg -n sidekick-app --secrets ado-client-secret=keyvaultref:https://sidekick-kv.vault.azure.net/secrets/ado-client-secret,identityref:system
   az containerapp update -g sidekick-rg -n sidekick-app --set-env-vars ADO_CLIENT_ID=<application id> ADO_CLIENT_SECRET=secretref:ado-client-secret -o none
   ```
   (Deploys keep these: they only change the image and the release settings.) For the laptop, put the same two
   lines in `app/.env.local` (`ADO_CLIENT_ID=…`, `ADO_CLIENT_SECRET=…`).
5. Check: make a free Azure DevOps organization with your personal Microsoft work account (dev.azure.com, connected
   to the Sidekick Labs tenant: Organization settings → Microsoft Entra), add a project with two made-up work items,
   then on the live portal **Connectors → Azure DevOps**, type its name, Connect, link the project to a test group
   and ask about one item. A customer's Azure DevOps organization must be connected to their own Entra tenant, and
   their IT may need to approve the app once (admin consent).

**Jira Cloud (Atlassian OAuth 2.0, "3LO")**
1. developer.atlassian.com → **Console → My apps → Create → OAuth 2.0 integration**. Name: `Sidekick` (the working
   name), with your personal Atlassian account.
2. **Permissions → Jira API → Add → Configure → Edit scopes (Classic)**: tick **read:jira-work** and
   **read:jira-user**. Nothing that writes.
3. **Authorization → OAuth 2.0 (3LO) → Configure**: callback URL `https://<site>/api/connectors/callback`. For the
   laptop, make a second app ("Sidekick dev") with `http://localhost:3000/api/connectors/callback`.
4. **Distribution → Edit → Sharing** (otherwise only you can connect): vendor "Sidekick (working name)", privacy
   policy `https://<site>/privacy`, and answer the personal-data questions: the app **stores personal data**
   (names of assignees and comment authors, as part of work items) and supports Atlassian's personal data
   reporting by deleting everything on disconnect. Save.
5. **Settings**: copy the **Client ID** (not secret) and the **Secret** (store it at the hidden prompt):
   ```bash
   read -rs "V?jira-client-secret: " && az keyvault secret set --vault-name sidekick-kv -n jira-client-secret --value "$V" -o none; unset V
   az containerapp secret set -g sidekick-rg -n sidekick-app --secrets jira-client-secret=keyvaultref:https://sidekick-kv.vault.azure.net/secrets/jira-client-secret,identityref:system
   az containerapp update -g sidekick-rg -n sidekick-app --set-env-vars JIRA_CLIENT_ID=<client id> JIRA_CLIENT_SECRET=secretref:jira-client-secret -o none
   ```
6. Check: a free Jira Cloud site on your personal Atlassian account with one made-up project, then Connect on the
   live Connectors page, link the project, ask about an issue.

Costs: none from Microsoft or Atlassian for these apps. Each sync is a few API calls per linked project every 15
minutes (no AI calls; items only cost AI when someone asks).

## Connector problems

What the customer sees on **Connectors** and what to do (an Org Owner/Admin of theirs does the fixing; you only
help):
- **Sign-in expired**: their refresh was refused (the person who connected left, their password/MFA changed in a
  way that revoked tokens, an admin removed the app, or 90 days without any sync). They press **Reconnect** and
  sign in again. Nothing was deleted.
- **"refused access to the project …"**: the connected account lost access to that project. Reconnect with an
  account that can open it, or unlink the project.
- **"couldn't find …"**: the project or organization was renamed or deleted. Unlink it and link the new one.
- **"busy or unavailable"** or **"couldn't reach"**: the tool was down or rate limiting; it retries every 15
  minutes by itself. If every customer shows it, check the tool's status page.
- **Every connection of one tool fails right after a change on our side**: the app secret expired or was rotated
  wrongly ("didn't confirm the sign-in" on connect). Rotate it (Rotate secrets above) and restart.
- Customers also get a **Needs attention** finding ("Connector not working") from the broken-connector watcher. To
  see every broken connector across clients: `connectorProblems()` in `app/src/lib/connectors.ts`; the syncs run as
  `connector.sync` jobs (Owner Console → Job queue).

## Scaling up (the plan in docs/HOSTING.md → Scaling up)
Each step costs money: only with Cody's go-ahead. Do them in order and watch for a day after each one
(Owner Console → Performance and Job queue; Azure Monitor CPU and connections). Signs it's time are in
the HOSTING table; the load test numbers behind them are in docs/SCALE.md.

**1. Search to Basic.** Azure portal → AI Search → create `sidekick-search-basic` (Basic, same region as
the database) → copy its admin key into Key Vault `sidekick-kv` as `azure-search-api-key`, set
`AZURE_SEARCH_ENDPOINT` on the Container App to the new address, restart. The new index is empty, so
the first question after the restart starts copying every passage into it (`reindexAzure` in
`app/src/lib/search.ts`, a few sources at a time; embeddings cost about $0.02 per million words, so
cents today and roughly $50–60 once at 10,000 busy groups). Answers keep working meanwhile. Delete the
Free service a week later.

**2. Database to B2s (later D2ds_v5).** Portal → `sidekick-labs-db` → Compute + storage → pick the size →
Save. It restarts (a minute or two of "very busy" errors), so do it in the evening. Afterwards set the
server parameter `max_connections` to the new size's default (a resize doesn't change it), and
`DATABASE_POOL_MAX=20` on the Container App. Storage only grows, never shrinks: keep 32 GB until 80% full.

**3. Several app copies with auto-scaling.** Container App → Scale → min replicas 2, max 4, rule "HTTP
scaling, 50 concurrent requests". Resources → 1 vCPU / 2 GiB. Check: copies × `DATABASE_POOL_MAX` stays
under the database's connections (B1ms: 35), and 24 × copies Claude calls at once fits the Anthropic
limits. Nothing else changes: the job queue and the heartbeat already run safely on every copy. Sessions
live in the database, so people stay signed in whichever copy answers.

**4. Scale to zero (only if wanted).** Set `SIDEKICK_SCHEDULER=off` and `SIDEKICK_TICK_SECRET`, and create
the Container Apps job from docs/HOSTING.md → Scheduled work. Without it, nothing runs the reminders
and watchers while no copy is up.

**Undo.** Each step can be reversed in the same place (the database can go down a size; search back to
Free only if the passages fit, which they won't after real use).

## Slow pages or "AI is very busy"
1. Owner Console → **Performance**: which requests are slow, and is it database time or AI time?
   Activity traces show `db_ms` per request and `queued_ms` on AI steps (time spent waiting for a turn).
2. Database time high: set `SIDEKICK_SLOW_QUERY_MS=300` on the Container App for a day; the log then shows
   the slow queries (SQL only, never values). Fix with an index (both schemas: `app/src/lib/db.ts` and
   `app/db/schema.postgres.sql`) or step 2 of Scaling up.
3. AI steps waiting (`queued_ms` in the seconds) for one company only: that company is at its
   per-company limit (`SIDEKICK_CLAUDE_ORG_CONCURRENCY`, 6): expected, and it protects everyone else. For
   every company: the per-copy limit (`SIDEKICK_CLAUDE_CONCURRENCY`) or Anthropic's own rate limit; check
   the Anthropic Console's usage page before raising the setting.
4. Job queue behind (Owner Console → Job queue, oldest wait over 15 minutes): add copies (step 3) or raise
   `SIDEKICK_JOB_CONCURRENCY` to 8.
