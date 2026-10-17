#!/bin/zsh
# Unfreeze Sidekick in Azure: starts the database, then the web app (see freeze.sh).
set -e
RG=sidekick-rg
echo "Starting the database (takes a few minutes)..."
az postgres flexible-server start -g $RG -n sidekick-labs-db -o none
APP_ID=$(az containerapp show -g $RG -n sidekick-app --query id -o tsv)
echo "Starting the Sidekick app..."
az rest --method post --url "https://management.azure.com${APP_ID}/start?api-version=2024-03-01" -o none
URL=$(az containerapp show -g $RG -n sidekick-app --query properties.configuration.ingress.fqdn -o tsv)
echo "Running again: https://$URL (health: https://$URL/api/health)"
