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

- `./deploy.sh`: builds `origin/main` in the registry and switches the app to it.
- `./status.sh`: is the app/database running, and every budget's limit and spend this month.
- `./freeze.sh`: stops the app and the database (use when a budget alert arrives). Registry (~$5) and
  database storage (~$4) are still billed while frozen. Azure restarts a stopped Postgres after 7 days.
- `./unfreeze.sh`: starts them again.

## Budgets and alerts

Monthly budgets, each emailing cody.l.scott@outlook.com and CodyScott@SidekickLabs334.onmicrosoft.com
at 50%, 80% and 100% actual spend and at 100% forecast: `sidekick-total-50` (whole subscription, $50),
`sidekick-app-hosting` ($20), `sidekick-app-environment` ($5), `sidekick-database` ($20),
`sidekick-registry` ($7), `sidekick-ai-foundry` ($10), `sidekick-search` ($3), `sidekick-bot` ($2).
The older `sidekick-monthly-25` ($25, alerts at 80% / forecast 100%) is still there; delete it in Cost
Management if the extra early warning isn't wanted. Budget data lags Azure usage by up to a day.

An automatic freeze (budget → action group → Logic App that stops the app and database) is designed but
not created: it needs an identity with Contributor rights on `sidekick-rg`, so it waits for Cody's OK.

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

The cloud database started empty. Org "Test Suite" (Org Owner Cody, cody.l.scott@outlook.com) with the
made-up Contoso workspace from `samples/` (9 documents, 8 meetings). Local data on the Mac is separate.
