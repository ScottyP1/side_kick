# Sidekick's Azure setup as code (Terraform)

Everything Sidekick runs on in Azure resource group `sidekick-rg`, written down as Terraform, so it can be rebuilt
from code instead of the hand-run `az` commands in `docs/HOSTING.md`. Written Nov 11, 2026, the day Azure was
paused; checked against the paused setup with `terraform plan` only. **Nothing has been applied yet.**

## Why Terraform (and not Bicep)

Both would work. Terraform, because:

- **The plan shows every change before it happens**, line by line, including for things that already exist.
  That fits the rule "show Cody each Azure change before making any".
- **It can adopt what's already there** (`imports.tf`): most of Sidekick still exists after the pause, so the
  first apply takes those over and only makes what was deleted.
- **It covers the awkward parts** in one place: subscription budgets, the Bot, role assignments, custom roles.
- **Secrets stay out**: the database password is sent "write-only" (never saved), and the secret values in Key
  Vault aren't managed at all.

The cost: Terraform keeps a **state file** (its memory of what it manages). Here it lives on the Mac next to the
database backups, never in the repo (below). Bicep has no state file but no real import, and its "what-if"
preview is noisier.

## What it covers

| File | What |
|---|---|
| `main.tf` | resource group, Log Analytics `sidekick-logs`, Application Insights `sidekick-insights`, Container Apps environment `sidekick-env`, registry `sidekicklabsacr` (Basic, admin off) |
| `app.tf` | Container App `sidekick-app`: 0.5 vCPU / 1 GiB, one copy, web address on (external, port 8080), system identity, probes, every secret a Key Vault reference |
| `database.tf` | Postgres `sidekick-labs-db` (B1ms, 32 GB, v17, Central US, 35-day backups), "Azure services" firewall rule, databases `sidekick` and `attendee` |
| `keyvault.tf` | Key Vault `sidekick-kv` (RBAC, purge protection, 90-day soft delete) and who may read it. **Never the secret values.** A plan warns if a secret the app needs is missing |
| `services.tf` | Azure Bot `sidekick-bot-dev` (F0, single tenant) + Teams channel, AI Search `sidekick-labs-search` (Free), Speech `sidekick-speech` (S0) |
| `monitoring.tf` | uptime test `sidekick-health-test`, alerts `sidekick-site-down` and `sidekick-app-restarts`, action group `sidekick-alerts-ag` |
| `budgets.tf` | the 8 monthly budgets (+ the older `sidekick-monthly-25`), the freeze Logic App `sidekick-freeze`, its action group and the custom role **Sidekick Freeze** |
| `deployer.tf` | GitHub deploy identity `sidekick-deployer`, its two federated credentials, the custom role **Sidekick Deployer** on the registry and the app |
| `meetbot.tf` | meeting bot job `sidekick-meetbot` (manual, 4 vCPU / 8 GiB, 4.5 h max), its roles, budget `sidekick-meetbot-monthly` |
| `imports.tf` | adopts the resources that still exist (everything the pause kept) |
| `export-tfvars.sh` | writes `sidekick.tfvars` (git-ignored) from Azure: ids, emails, the app's plain settings, the live address. Reads only |
| `after-apply.sh` | what Terraform can't do: restore the databases from the backups, start the app, build and deploy `origin/main`, switch GitHub deploys back on |

**Not covered** (made by hand once, still there, see `docs/HOSTING.md` / `docs/RUNBOOKS.md`): the Entra app
(portal sign-in + bot identity) and its client secret, the AI Foundry resource `codyscott-9578-resource` and
Cody's "Foundry User" role on the group, the Graph billing account `sidekick-graph-billing`, the auto-made
"Application Insights Smart Detection" action group, the GitHub repository variables, Teams admin settings. Also
never in Terraform: secret values, app images (deploys and `meetbot-setup.sh` build those) and database contents
(the backups).

## Who owns what after an apply

- **Image of the app**: the deploys (GitHub Deploy workflow, `infra/azure/deploy.sh`). Terraform ignores it.
- **Image of the meeting bot job**, its Key Vault secret values, the Speech key copy: `infra/azure/meetbot-setup.sh`.
- **The app's plain settings**: Terraform, from `sidekick.tfvars`. `export-tfvars.sh` copies the live ones first,
  so a plan only shows what you changed. (Deploys change `SIDEKICK_COMMIT`; re-export before every plan.)
- **Everything else** in the table above: Terraform. Change it in the code, `plan`, read it, then `apply`.

Protected from `terraform destroy` or an accidental replacement (`prevent_destroy`): the resource group, the
environment (its domain is part of the live address), the database server and `sidekick` database, the vault and
the search service.

## First time on a Mac

```bash
brew install hashicorp/tap/terraform
```

```bash
az login
```

```bash
infra/terraform/export-tfvars.sh
```

```bash
terraform -chdir=infra/terraform init -backend-config="path=$HOME/Documents/sidekick-backups/terraform/sidekick.tfstate"
```

`init` downloads the providers (pinned in `.terraform.lock.hcl`) and points the state at
`~/Documents/sidekick-backups/terraform/` (made on first apply). Then a plan, which only reads:

```bash
terraform -chdir=infra/terraform plan -var-file=sidekick.tfvars -out=tfplan
```

## Bring Sidekick back from the pause (with Terraform)

The other way, without Terraform, is still `CONFIRM=yes infra/azure/rebuild.sh` (docs/RUNBOOKS.md → Bring
Sidekick back from the pause). Use one or the other. With Terraform:

1. Do **First time on a Mac** above and read the plan. As of Nov 11, 2026 it said
   `38 to import, 8 to add, 6 to change, 0 to destroy`:
   - **import** (no change in Azure): everything the pause kept.
   - **add**: Postgres server + firewall rule + 2 databases, the registry, and its 3 role assignments (AcrPull
     for the app and the job, Sidekick Deployer). Billable again: about $33/month in all.
   - **change**: the app's web address on and 1 copy always running; the uptime test and both alerts on;
     plus spelling-only changes that mean the same thing (identity `system` → `System` on the app and the job,
     the alerts' metric namespace filled in, the freeze action group's trigger address marked sensitive).
   - **0 to destroy.** If a plan ever says destroy or replace, stop and find out why first.
2. Apply exactly what you read:
   ```bash
   terraform -chdir=infra/terraform apply tfplan
   ```
3. Put the data and the app back:
   ```bash
   CONFIRM=yes infra/terraform/after-apply.sh
   ```
4. Only if live meetings are wanted again: `CONFIRM=yes BUDGET_EMAIL=… infra/azure/meetbot-setup.sh` (rebuilds
   the bot images in the new registry).
5. Check: `terraform -chdir=infra/terraform plan -var-file=sidekick.tfvars` (after `export-tfvars.sh`) says
   **No changes**.

To pause again later the same way: `-var monitoring_enabled=false -var app_min_replicas=0` switches the uptime
test, alerts and the always-on copy off; deleting the database and registry stays a deliberate manual step
(back up first, docs/RUNBOOKS.md), because `prevent_destroy` blocks it on purpose.

## Rebuild from nothing (new subscription or everything lost)

Rare; read it through first. Delete `imports.tf` (or keep only what exists), and:

1. Make the vault first and set every secret by hand (names: `terraform plan` warns about missing ones; how:
   docs/RUNBOOKS.md → Rotate secrets). `database-url` must hold the admin user and a new random password: the
   server gets that password.
   `terraform -chdir=infra/terraform apply -var-file=sidekick.tfvars -target=azurerm_key_vault.kv -target=azurerm_role_assignment.owner_kv_admin`
2. `apply -var first_build=true`: the app and the job are made with a placeholder image and no Key Vault
   references, because their managed identities only exist once they're made; their roles are granted in the
   same run.
3. `apply` again without it: registry and Key Vault references switched on.
4. `CONFIRM=yes infra/terraform/after-apply.sh` (or `SKIP_RESTORE=1` for an empty start), then
   `meetbot-setup.sh` if wanted.
5. By hand: the Entra app's redirect URIs and the bot's address follow the new live address
   (`terraform output app_url`); set the GitHub repository variable `AZURE_CLIENT_ID` to
   `terraform output deployer_client_id` (plus the tenant and subscription ids); new Teams package
   (docs/HOSTING.md → Teams app package).

## State and values: what's where

- **`sidekick.tfvars`** (git-ignored): ids, email addresses, the app's plain settings and the live address.
  No secrets. Re-made any time by `export-tfvars.sh`. Its shape: `sidekick.tfvars.example`.
- **The state** (`~/Documents/sidekick-backups/terraform/sidekick.tfstate`, outside the repo): resource ids, the
  plain settings and the freeze Logic App's trigger address (which can only start the freeze). **No database
  password** (sent write-only) and no Key Vault values (never read into Terraform). Keep it with the backups; if
  it's ever lost, run `init` again and the import blocks adopt everything anew.
- **Later**, if a second person ever runs this: move the state to an Azure Storage account with Entra sign-in
  (cents a month) so it's shared and locked. Not worth it for one person on one Mac.

## Known differences to clear up

- **Meeting bot size**: the live job's template (and the app's `SIDEKICK_MEETBOT_CPU` / `_MEMORY_GIB`) is
  4 vCPU / 8 GiB, but `infra/azure/meetbot-setup.sh` sets 2 / 4 when it runs. Terraform follows the live 4 / 8
  (`meetbot_cpu`, `meetbot_memory`). Harmless in practice, since the app picks each meeting's size itself (logo
  2 / 4, moving crystal ball 4 / 8, docs/PROGRESS.md), but after running the script the next plan shows it.
- The firewall rule made by the old `az … --public-access 0.0.0.0` had a date in its name; Terraform names it
  `AllowAllAzureServicesAndResourcesWithinAzureIps` (same effect).
