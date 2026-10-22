#!/bin/zsh
# Deploys the current origin/main to Azure: builds the image in Azure Container Registry (no Docker
# needed on the Mac) and points the container app at it. Settings and secrets stay as they are.
# Prints the version that was live before (for a rollback), then waits until /api/health answers ok with
# the new commit (SIDEKICK_COMMIT, set here like the GitHub deploy does), so it's the new version answering.
# If it doesn't within ~10 minutes, it says so and prints the rollback command (docs/RUNBOOKS.md).
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
az containerapp update -g sidekick-rg -n sidekick-app --image sidekicklabsacr.azurecr.io/sidekick:$TAG \
  --set-env-vars SIDEKICK_COMMIT=$TAG SIDEKICK_RELEASED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) -o none
rm -rf "$SRC"
echo "Deployed $TAG. Waiting for the health check…"
for i in {1..60}; do
  BODY=$(curl -fsS --max-time 10 "https://$HOST/api/health" 2>/dev/null || true)
  if [[ "$BODY" == *'"ok":true'* && "$BODY" == *"\"commit\":\"$TAG\""* ]]; then
    echo "✓ Healthy: $TAG is live."
    exit 0
  fi
  sleep 10
done
echo "✗ $TAG didn't answer within 10 minutes. To roll back to the previous version:"
echo "  az containerapp update -g sidekick-rg -n sidekick-app --image $PREV --set-env-vars SIDEKICK_COMMIT=${PREV##*:}"
exit 1
