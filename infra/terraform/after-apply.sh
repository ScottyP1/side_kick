#!/bin/zsh
# What `terraform apply` can't do, run right after it (infra/terraform/README.md → Bring Sidekick back):
#
#   1. Restore the databases `sidekick` and `attendee` from the newest backups in ~/Documents/sidekick-backups
#      (or BACKUP_DIR=…), through a firewall rule for this Mac that is removed again afterwards. Skipped with
#      SKIP_RESTORE=1 (e.g. when the server wasn't deleted). The admin user and password are read from Key Vault
#      `database-url` and never printed.
#   2. Start the app (the pause stopped it; Terraform can't say "running").
#   3. Build origin/main in the registry and switch the app to it, waiting for /api/health (infra/azure/deploy.sh).
#   4. Switch the GitHub Deploy workflow back on.
#
# The meeting bot's images are separate: run `CONFIRM=yes BUDGET_EMAIL=… infra/azure/meetbot-setup.sh` afterwards,
# only if live meetings are wanted again (it finds the job, Speech and database already made by Terraform).
#
# Usage: CONFIRM=yes infra/terraform/after-apply.sh   (az login as the Sidekick Labs admin, gh signed in,
# Postgres 17 client tools from `brew install postgresql@17`). Without CONFIRM=yes it only says what it would do.
set -euo pipefail
cd "$(dirname "$0")/../.."

RG=sidekick-rg; PG=sidekick-labs-db; KV=sidekick-kv; APP=sidekick-app; REPO=ScottyP1/side_kick
BACKUP_DIR=${BACKUP_DIR:-$HOME/Documents/sidekick-backups}
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}

if [[ "${CONFIRM:-}" != "yes" ]]; then
  echo "Dry run. This would restore 'sidekick' and 'attendee' from $BACKUP_DIR into $PG (unless SKIP_RESTORE=1),"
  echo "start $APP, build origin/main and switch the app to it (deploy.sh), and switch GitHub deploys back on."
  echo "Run with CONFIRM=yes to do it."
  exit 0
fi

if [[ "${SKIP_RESTORE:-}" != "1" ]]; then
  echo "1/4 Restoring the databases"
  SIDEKICK_DUMP=$(ls -t "$BACKUP_DIR"/sidekick-*.dump | head -1)
  ATTENDEE_DUMP=$(ls -t "$BACKUP_DIR"/attendee-*.dump 2>/dev/null | head -1 || true)
  echo "  from $SIDEKICK_DUMP ${ATTENDEE_DUMP:-(no attendee backup: its database starts empty)}"
  eval "$(az keyvault secret show --vault-name $KV -n database-url --query value -o tsv | python3 -c '
import sys, shlex, urllib.parse as u
p = u.urlsplit(sys.stdin.read().strip())
print("PG_USER=" + shlex.quote(u.unquote(p.username)) + "; PG_PASS=" + shlex.quote(u.unquote(p.password)))')"
  MYIP=$(curl -fsS https://api.ipify.org)
  az postgres flexible-server firewall-rule create -g $RG --server-name $PG --name restore-mac \
    --start-ip-address "$MYIP" --end-ip-address "$MYIP" -o none
  trap 'az postgres flexible-server firewall-rule delete -g $RG --server-name $PG --name restore-mac --yes -o none' EXIT
  HOST="$PG.postgres.database.azure.com"
  export PGPASSWORD="$PG_PASS" PGSSLMODE=require
  "$PGBIN/pg_restore" --no-owner --no-acl -h $HOST -U "$PG_USER" -d sidekick "$SIDEKICK_DUMP"
  [[ -n "$ATTENDEE_DUMP" ]] && "$PGBIN/pg_restore" --no-owner --no-acl -h $HOST -U "$PG_USER" -d attendee "$ATTENDEE_DUMP"
  unset PGPASSWORD PG_PASS
else
  echo "1/4 Restore skipped (SKIP_RESTORE=1)"
fi

echo "2/4 Starting the app"
APP_ID=$(az containerapp show -g $RG -n $APP --query id -o tsv)
az rest --method post --url "https://management.azure.com${APP_ID}/start?api-version=2024-03-01" -o none

echo "3/4 Building origin/main and switching the app to it"
infra/azure/deploy.sh

echo "4/4 Automatic deploys"
gh workflow enable Deploy --repo $REPO
echo "✓ Done. Live meetings: CONFIRM=yes BUDGET_EMAIL=… infra/azure/meetbot-setup.sh (only if wanted)."
