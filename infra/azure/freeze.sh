#!/bin/zsh
# Freeze Sidekick in Azure: stops the web app and the database so they stop costing money.
# Run by hand when a budget alert arrives (or any time you want everything off). Needs `az login`
# as CodyScott@SidekickLabs334.onmicrosoft.com. Undo with ./unfreeze.sh.
# Still billed while frozen: Container Registry Basic (~$5/month) and database storage (~$4/month).
# Note: Azure starts a stopped Postgres server again by itself after 7 days; run this again if needed.
set -e
RG=sidekick-rg
APP_ID=$(az containerapp show -g $RG -n sidekick-app --query id -o tsv)
echo "Stopping the Sidekick app..."
az rest --method post --url "https://management.azure.com${APP_ID}/stop?api-version=2024-03-01" -o none
echo "Stopping the database (takes a few minutes)..."
az postgres flexible-server stop -g $RG -n sidekick-labs-db -o none
echo "Frozen. Teams messages to Sidekick will fail until you run ./unfreeze.sh."
