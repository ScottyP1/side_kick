#!/bin/zsh
# Deploys the current origin/main to Azure: builds the image in Azure Container Registry (no Docker
# needed on the Mac) and points the container app at it. Settings and secrets stay as they are.
set -e
cd "$(dirname "$0")/../.."
git fetch -q origin
TAG=$(git rev-parse --short origin/main)
SRC=$(mktemp -d)
git archive origin/main app | tar -x -C "$SRC"   # clean copy: no .env.local, no local data
az acr build -r sidekicklabsacr -t sidekick:$TAG -t sidekick:latest "$SRC/app" --no-logs -o none
az containerapp update -g sidekick-rg -n sidekick-app --image sidekicklabsacr.azurecr.io/sidekick:$TAG -o none
rm -rf "$SRC"
echo "Deployed $TAG. Check: https://$(az containerapp show -g sidekick-rg -n sidekick-app --query properties.configuration.ingress.fqdn -o tsv)/api/health"
