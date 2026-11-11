#!/bin/zsh
# Brings Sidekick back in Azure after the Nov 11, 2026 pause (docs/RUNBOOKS.md → "Bring Sidekick back from the
# pause"). The pause deleted the database server and the image registry, turned the app's web address off and
# stopped it, and switched off the uptime check, its alerts and automatic deploys. Everything else stayed (the
# environment, the app's settings, Key Vault and its secrets, Bot, Search, Speech, the meeting bot job, the alerts'
# action groups, the Microsoft directory), so this script only puts back what was removed:
#
#   1. Postgres Flexible Server `sidekick-labs-db` (Burstable B1ms, 32 GB, v17, Central US, 35-day backups) with the
#      same name, admin user and password as before, read from Key Vault `database-url`, so the secrets
#      `database-url` and `meetbot-database-url` work unchanged. Nothing secret is printed.
#   2. Databases `sidekick` and `attendee`, restored from the backups made at the pause
#      (~/Documents/sidekick-backups/*.dump, or BACKUP_DIR=…), through a firewall rule for this Mac that is removed
#      again afterwards.
#   3. Container Registry `sidekicklabsacr` (Basic, admin user and anonymous pull off) and its roles: AcrPull for the
#      app's and the meeting bot job's managed identities, "Sidekick Deployer" for the GitHub deploy identity.
#   4. The app image built from origin/main (as deploy.sh does), the app pointed at it, its web address on again
#      (external, port 8080; same address as before, since the environment was kept) and one copy always running.
#   5. The uptime check, the "site down" and "app restarts" alerts and the GitHub Deploy workflow switched on again.
#   6. Waits until /api/health answers ok with the new commit.
#
# The meeting bot's images live in the registry too: after this, run `CONFIRM=yes BUDGET_EMAIL=…
# infra/azure/meetbot-setup.sh` (idempotent) to rebuild them, only if live meetings are wanted again.
#
# Usage: CONFIRM=yes infra/azure/rebuild.sh   (signed in with `az login` as the Sidekick Labs admin, `gh` signed in,
# Postgres 17 client tools from `brew install postgresql@17`). Without CONFIRM=yes it only prints what it would do.
# Billable again afterwards: about $33/month (database ~$17, app ~$10, registry ~$5, uptime check ~$3).
set -euo pipefail
cd "$(dirname "$0")/../.."

RG=sidekick-rg; PG=sidekick-labs-db; PG_LOC=centralus; ACR=sidekicklabsacr; ACR_LOC=eastus; KV=sidekick-kv
APP=sidekick-app; JOB=sidekick-meetbot; DEPLOYER=sidekick-deployer; REPO=ScottyP1/side_kick
BACKUP_DIR=${BACKUP_DIR:-$HOME/Documents/sidekick-backups}
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}

if [[ "${CONFIRM:-}" != "yes" ]]; then
  echo "Dry run. This would create Postgres $PG (B1ms, v17, $PG_LOC) and restore 'sidekick' and 'attendee' from"
  echo "$BACKUP_DIR, create registry $ACR (Basic) with its roles, build the app image from origin/main, turn"
  echo "$APP's web address on with one copy, and switch the uptime check, alerts and GitHub deploys back on."
  echo "Cost again afterwards: about \$33/month. Run with CONFIRM=yes to do it."
  exit 0
fi
SIDEKICK_DUMP=$(ls -t "$BACKUP_DIR"/sidekick-*.dump | head -1)
ATTENDEE_DUMP=$(ls -t "$BACKUP_DIR"/attendee-*.dump 2>/dev/null | head -1 || true)
echo "Backups: $SIDEKICK_DUMP ${ATTENDEE_DUMP:-(no attendee backup: its database starts empty)}"

echo "1/6 Database server $PG"
# The admin user and password come from the app's own connection string, so the secrets stay valid.
eval "$(az keyvault secret show --vault-name $KV -n database-url --query value -o tsv | python3 -c '
import sys, shlex, urllib.parse as u
p = u.urlsplit(sys.stdin.read().strip())
print("PG_USER=" + shlex.quote(u.unquote(p.username)) + "; PG_PASS=" + shlex.quote(u.unquote(p.password)))')"
if ! az postgres flexible-server show -g $RG -n $PG -o none 2>/dev/null; then
  az postgres flexible-server create -g $RG -n $PG -l $PG_LOC --tier Burstable --sku-name Standard_B1ms \
    --storage-size 32 --version 17 --backup-retention 35 --admin-user "$PG_USER" --admin-password "$PG_PASS" \
    --public-access 0.0.0.0 --database-name sidekick --yes -o none
fi
az postgres flexible-server db show -g $RG -s $PG -d attendee -o none 2>/dev/null || \
  az postgres flexible-server db create -g $RG -s $PG -d attendee -o none

echo "2/6 Restoring the databases"
MYIP=$(curl -fsS https://api.ipify.org)
az postgres flexible-server firewall-rule create -g $RG --server-name $PG --name rebuild-mac \
  --start-ip-address "$MYIP" --end-ip-address "$MYIP" -o none
HOST="$PG.postgres.database.azure.com"
export PGPASSWORD="$PG_PASS" PGSSLMODE=require
"$PGBIN/pg_restore" --no-owner --no-acl -h $HOST -U "$PG_USER" -d sidekick "$SIDEKICK_DUMP"
[[ -n "$ATTENDEE_DUMP" ]] && "$PGBIN/pg_restore" --no-owner --no-acl -h $HOST -U "$PG_USER" -d attendee "$ATTENDEE_DUMP"
unset PGPASSWORD PG_PASS
az postgres flexible-server firewall-rule delete -g $RG --server-name $PG --name rebuild-mac --yes -o none

echo "3/6 Registry $ACR and its roles"
az acr show -g $RG -n $ACR -o none 2>/dev/null || \
  az acr create -g $RG -n $ACR -l $ACR_LOC --sku Basic --admin-enabled false -o none
ACR_ID=$(az acr show -g $RG -n $ACR --query id -o tsv)
for P in $(az containerapp show -g $RG -n $APP --query identity.principalId -o tsv) \
         $(az containerapp job show -g $RG -n $JOB --query identity.principalId -o tsv 2>/dev/null || true); do
  az role assignment create --assignee-object-id "$P" --assignee-principal-type ServicePrincipal \
    --role AcrPull --scope "$ACR_ID" -o none
done
az role assignment create --assignee-object-id "$(az identity show -g $RG -n $DEPLOYER --query principalId -o tsv)" \
  --assignee-principal-type ServicePrincipal --role "Sidekick Deployer" --scope "$ACR_ID" -o none

echo "4/6 App image and web address"
APP_ID=$(az containerapp show -g $RG -n $APP --query id -o tsv)
az rest --method post --url "https://management.azure.com${APP_ID}/start?api-version=2024-03-01" -o none
git fetch -q origin
TAG=$(git rev-parse --short origin/main)
SRC=$(mktemp -d)
git archive origin/main app | tar -x -C "$SRC"   # clean copy: no .env.local, no local data
az acr build -r $ACR -t sidekick:$TAG -t sidekick:latest "$SRC/app" --no-logs -o none
rm -rf "$SRC"
az containerapp registry set -g $RG -n $APP --server $ACR.azurecr.io --identity system -o none
az containerapp update -g $RG -n $APP --image $ACR.azurecr.io/sidekick:$TAG --min-replicas 1 --max-replicas 1 \
  --set-env-vars SIDEKICK_COMMIT=$TAG SIDEKICK_RELEASED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) -o none
az containerapp ingress enable -g $RG -n $APP --type external --target-port 8080 --transport auto -o none

echo "5/6 Uptime check, alerts and automatic deploys"
az monitor app-insights web-test update -g $RG -n sidekick-health-test --enabled true -o none
az monitor metrics alert update -g $RG -n sidekick-site-down --enabled true -o none
az monitor metrics alert update -g $RG -n sidekick-app-restarts --enabled true -o none
gh workflow enable Deploy --repo $REPO

echo "6/6 Waiting for the health check"
HOST_APP=$(az containerapp show -g $RG -n $APP --query properties.configuration.ingress.fqdn -o tsv)
for i in {1..60}; do
  BODY=$(curl -fsS --max-time 10 "https://$HOST_APP/api/health" 2>/dev/null || true)
  if [[ "$BODY" == *'"ok":true'* && "$BODY" == *"\"commit\":\"$TAG\""* ]]; then
    echo "✓ Sidekick is back: https://$HOST_APP ($TAG)"
    exit 0
  fi
  sleep 10
done
echo "✗ $TAG didn't answer within 10 minutes. Check the app log (docs/RUNBOOKS.md → Site down)."
exit 1
