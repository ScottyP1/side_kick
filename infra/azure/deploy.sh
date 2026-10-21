#!/bin/zsh
# Deploys the current origin/main to Azure: builds the image in Azure Container Registry (no Docker
# needed on the Mac) and points the container app at it. Settings and secrets stay as they are.
# Prints the version that was live before (for a rollback), then waits until /api/health answers ok.
# If it doesn't within ~5 minutes, it says so and prints the rollback command (docs/RUNBOOKS.md).
set -e
cd "$(dirname "$0")/../.."
git fetch -q origin
TAG=$(git rev-parse --short origin/main)
PREV=$(az containerapp show -g sidekick-rg -n sidekick-app --query "properties.template.containers[0].image" -o tsv)
HOST=$(az containerapp show -g sidekick-rg -n sidekick-app --query properties.configuration.ingress.fqdn -o tsv)
echo "Live now: $PREV"
SRC=$(mktemp -d)
git archive origin/main app | tar -x -C "$SRC"   # clean copy: no .env.local, no local data
az acr build -r sidekicklabsacr -t sidekick:$TAG -t sidekick:latest "$SRC/app" --no-logs -o none
az containerapp update -g sidekick-rg -n sidekick-app --image sidekicklabsacr.azurecr.io/sidekick:$TAG -o none
rm -rf "$SRC"
echo "Deployed $TAG. Waiting for the health check…"
for i in {1..30}; do
  if curl -fsS "https://$HOST/api/health" 2>/dev/null | grep -q '"ok":true'; then
    echo "✓ Healthy: $TAG is live."
    exit 0
  fi
  sleep 10
done
echo "✗ $TAG didn't report healthy within 5 minutes. To roll back to the previous version:"
echo "  az containerapp update -g sidekick-rg -n sidekick-app --image $PREV"
exit 1
