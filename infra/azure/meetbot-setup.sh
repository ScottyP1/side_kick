#!/bin/zsh
# Sets up Sidekick's self-hosted meeting bot in Azure (docs/LIVE-MEETINGS.md → "Runs only during meetings";
# docs/RUNBOOKS.md → "Meeting bot"). Idempotent: every step checks first, so running it again only fixes what's
# missing and rolls the job to the current image. **Creates billable resources: only run it after Cody approves.**
#
# What it makes (all in sidekick-rg, tagged sidekick-meetbot=1 so the budget below sees them):
#   1. Azure AI Speech `sidekick-speech` (S0, East US): its key → Key Vault `azure-speech-key`.
#   2. Database `attendee` on the existing Postgres server `sidekick-labs-db` (no new server, $0); its connection
#      string → Key Vault `meetbot-database-url` (made from the app's `database-url`, so no password is typed).
#   3. Secrets Attendee needs (`meetbot-django-secret`, `meetbot-credentials-key`) and the key Sidekick derives each
#      meeting's bot key from (`meetbot-secret`), generated once.
#   4. Images in sidekicklabsacr: `attendee:<tag>` (Attendee's own Dockerfile at the pinned tag) and
#      `meetbot:<tag>-<commit>` (meetbot/: our patches, Redis, the shim).
#   5. Container Apps job `sidekick-meetbot` in sidekick-env: manual trigger, one replica, 2 vCPU / 4 GiB,
#      at most 4.5 hours per execution (a stuck bot can't run on), no retries; its own managed identity reads the
#      Key Vault secrets and pulls the image.
#   6. The app (`sidekick-app`) may start and stop that job only (Contributor on the job), and gets the settings
#      SIDEKICK_MEETBOT_JOB / _IMAGE / _SECRET, AZURE_SUBSCRIPTION_ID, AZURE_SPEECH_KEY / _REGION, ATTENDEE_RAISE_HAND.
#   7. An Azure budget `sidekick-meetbot-monthly` on the tagged resources, emailing at 50/80/100%. Azure budgets only
#      warn; the app's own cap (Owner Console → Live meetings) is what stops new meetings.
#
# Usage: CONFIRM=yes BUDGET_EMAIL=<who gets the budget emails> [BUDGET_USD=50] infra/azure/meetbot-setup.sh
# Without CONFIRM=yes it only prints what it would do.
set -euo pipefail
cd "$(dirname "$0")/../.."

RG=sidekick-rg; LOC=eastus; ENV_NAME=sidekick-env; ACR=sidekicklabsacr; KV=sidekick-kv; APP=sidekick-app
JOB=sidekick-meetbot; SPEECH=sidekick-speech; PG=sidekick-labs-db; DB=attendee
ATTENDEE_REF=v1.89.2
TAG="sidekick-meetbot=1"
BUDGET_USD=${BUDGET_USD:-50}

if [[ "${CONFIRM:-}" != "yes" ]]; then
  echo "Dry run. This would create or update, in $RG: Speech $SPEECH (S0, $LOC), database $DB on $PG, Key Vault secrets"
  echo "meetbot-*, images attendee:$ATTENDEE_REF and meetbot:$ATTENDEE_REF-<commit>, job $JOB (2 vCPU / 4 GiB, manual),"
  echo "a role for $APP on the job, the app's settings, and budget sidekick-meetbot-monthly (\$$BUDGET_USD, 50/80/100%)."
  echo "Run again with CONFIRM=yes BUDGET_EMAIL=… once Cody has approved the spend."
  exit 0
fi
: "${BUDGET_EMAIL:?Set BUDGET_EMAIL to the address that gets the budget emails}"
SUB=$(az account show --query id -o tsv)
secret_exists() { az keyvault secret show --vault-name $KV -n "$1" --query id -o tsv >/dev/null 2>&1; }

echo "1/7 Azure AI Speech"
az cognitiveservices account show -g $RG -n $SPEECH -o none 2>/dev/null || \
  az cognitiveservices account create -g $RG -n $SPEECH -l $LOC --kind SpeechServices --sku S0 --tags $TAG --yes -o none
az cognitiveservices account keys list -g $RG -n $SPEECH --query key1 -o tsv | tr -d '\n' | \
  az keyvault secret set --vault-name $KV -n azure-speech-key --file /dev/stdin -o none

echo "2/7 Attendee's database on $PG"
az postgres flexible-server db show -g $RG -s $PG -d $DB -o none 2>/dev/null || \
  az postgres flexible-server db create -g $RG -s $PG -d $DB -o none
if ! secret_exists meetbot-database-url; then
  az keyvault secret show --vault-name $KV -n database-url --query value -o tsv | \
    python3 -c "import sys,urllib.parse as u; p=u.urlsplit(sys.stdin.read().strip()); print(u.urlunsplit(p._replace(path='/$DB')), end='')" | \
    az keyvault secret set --vault-name $KV -n meetbot-database-url --file /dev/stdin -o none
fi

echo "3/7 Generated secrets"
secret_exists meetbot-django-secret || openssl rand -base64 48 | tr -d '\n' | az keyvault secret set --vault-name $KV -n meetbot-django-secret --file /dev/stdin -o none
secret_exists meetbot-credentials-key || openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n' | az keyvault secret set --vault-name $KV -n meetbot-credentials-key --file /dev/stdin -o none
secret_exists meetbot-secret || openssl rand -base64 48 | tr -d '\n' | az keyvault secret set --vault-name $KV -n meetbot-secret --file /dev/stdin -o none

echo "4/7 Images"
git fetch -q origin
COMMIT=$(git rev-parse --short origin/main)
az acr repository show-tags -n $ACR --repository attendee -o tsv 2>/dev/null | grep -qx "$ATTENDEE_REF" || \
  az acr build -r $ACR -t attendee:$ATTENDEE_REF "https://github.com/attendee-labs/attendee.git#$ATTENDEE_REF" --platform linux/amd64 --no-logs -o none
SRC=$(mktemp -d)
git archive origin/main meetbot | tar -x -C "$SRC"
az acr build -r $ACR -t meetbot:$ATTENDEE_REF-$COMMIT --build-arg BASE=$ACR.azurecr.io/attendee:$ATTENDEE_REF "$SRC/meetbot" --platform linux/amd64 --no-logs -o none
rm -rf "$SRC"
IMAGE=$ACR.azurecr.io/meetbot:$ATTENDEE_REF-$COMMIT

echo "5/7 The job"
VAULT=https://$KV.vault.azure.net/secrets
SECRETS=(
  "database-url=keyvaultref:$VAULT/meetbot-database-url,identityref:system"
  "django-secret=keyvaultref:$VAULT/meetbot-django-secret,identityref:system"
  "credentials-key=keyvaultref:$VAULT/meetbot-credentials-key,identityref:system"
  "speech-key=keyvaultref:$VAULT/azure-speech-key,identityref:system"
)
ENVV=(DATABASE_URL=secretref:database-url DJANGO_SECRET_KEY=secretref:django-secret CREDENTIALS_ENCRYPTION_KEY=secretref:credentials-key
  AZURE_SPEECH_KEY=secretref:speech-key AZURE_SPEECH_REGION=$LOC POSTGRES_SSL_REQUIRE=true)
if ! az containerapp job show -g $RG -n $JOB -o none 2>/dev/null; then
  # Created with a public image first: the identity that pulls from our registry and reads Key Vault needs roles first.
  az containerapp job create -g $RG -n $JOB --environment $ENV_NAME --trigger-type Manual \
    --replica-timeout 16200 --replica-retry-limit 0 --parallelism 1 --replica-completion-count 1 \
    --cpu 2 --memory 4Gi --image mcr.microsoft.com/k8se/quickstart-jobs:latest --mi-system-assigned --tags $TAG -o none
fi
JOB_ID=$(az containerapp job show -g $RG -n $JOB --query id -o tsv)
JOB_PID=$(az containerapp job show -g $RG -n $JOB --query identity.principalId -o tsv)
ACR_ID=$(az acr show -n $ACR --query id -o tsv)
KV_ID=$(az keyvault show -n $KV --query id -o tsv)
grant() { # principal role scope
  [[ -n "$(az role assignment list --assignee "$1" --role "$2" --scope "$3" --query '[0].id' -o tsv)" ]] || \
    az role assignment create --assignee-object-id "$1" --assignee-principal-type ServicePrincipal --role "$2" --scope "$3" -o none
}
grant "$JOB_PID" AcrPull "$ACR_ID"
grant "$JOB_PID" "Key Vault Secrets User" "$KV_ID"
az containerapp job registry set -g $RG -n $JOB --server $ACR.azurecr.io --identity system -o none
az containerapp job secret set -g $RG -n $JOB --secrets "${SECRETS[@]}" -o none
az containerapp job update -g $RG -n $JOB --image "$IMAGE" --cpu 2 --memory 4Gi --replace-env-vars "${ENVV[@]}" -o none

echo "6/7 The app may start and stop the job"
APP_PID=$(az containerapp show -g $RG -n $APP --query identity.principalId -o tsv)
grant "$APP_PID" Contributor "$JOB_ID"
az containerapp secret set -g $RG -n $APP --secrets \
  "meetbot-secret=keyvaultref:$VAULT/meetbot-secret,identityref:system" "azure-speech-key=keyvaultref:$VAULT/azure-speech-key,identityref:system" -o none
# ATTENDEE_RAISE_HAND stays 0 until meetbot/patches/02-raise-hand.patch is in the image (stage 2 trial).
az containerapp update -g $RG -n $APP --set-env-vars SIDEKICK_MEETBOT_JOB=$JOB SIDEKICK_MEETBOT_RG=$RG AZURE_SUBSCRIPTION_ID=$SUB \
  SIDEKICK_MEETBOT_IMAGE="$IMAGE" SIDEKICK_MEETBOT_SECRET=secretref:meetbot-secret SIDEKICK_MEETBOT_CPU=2 SIDEKICK_MEETBOT_MEMORY_GIB=4 \
  AZURE_SPEECH_KEY=secretref:azure-speech-key AZURE_SPEECH_REGION=$LOC ATTENDEE_RAISE_HAND=0 -o none

echo "7/7 Budget on the meeting bot's resources"
START=$(date -u +%Y-%m-01)
cat > /tmp/meetbot-budget.json <<JSON
{ "properties": {
  "category": "Cost", "amount": $BUDGET_USD, "timeGrain": "Monthly",
  "timePeriod": { "startDate": "${START}T00:00:00Z" },
  "filter": { "tags": { "name": "sidekick-meetbot", "operator": "In", "values": ["1"] } },
  "notifications": {
    "actual50": { "enabled": true, "operator": "GreaterThanOrEqualTo", "threshold": 50, "contactEmails": ["$BUDGET_EMAIL"], "thresholdType": "Actual" },
    "actual80": { "enabled": true, "operator": "GreaterThanOrEqualTo", "threshold": 80, "contactEmails": ["$BUDGET_EMAIL"], "thresholdType": "Actual" },
    "actual100": { "enabled": true, "operator": "GreaterThanOrEqualTo", "threshold": 100, "contactEmails": ["$BUDGET_EMAIL"], "thresholdType": "Actual" }
  } } }
JSON
az rest --method put --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Consumption/budgets/sidekick-meetbot-monthly?api-version=2023-05-01" \
  --body @/tmp/meetbot-budget.json -o none
rm -f /tmp/meetbot-budget.json
echo "✓ Meeting bot ready: job $JOB runs $IMAGE. Nothing runs until a meeting starts."
echo "  Test: in the portal turn Live in meetings on for a group, then type @Sidekick join in a meeting chat."
