#!/bin/zsh
# Access recovery on the LIVE database: gives a portal user or the Owner Console account a one-time
# temporary password, printed only in this terminal (app/scripts/reset-password.mjs does the work).
#
#   ./infra/azure/reset-password.sh you@example.com                   portal user (e.g. the Org Owner)
#   ./infra/azure/reset-password.sh you@example.com --allow-password  …and turn off "Require Microsoft sign-in"
#   ./infra/azure/reset-password.sh --owner you@example.com           Owner Console account
#
# The live database only accepts Azure traffic, so for this run only it:
#   1. adds a firewall rule for this Mac's public IP address (named reset-password-tmp),
#   2. reads the database-url secret from Key Vault `sidekick-kv` into a variable (never printed or written to disk),
#   3. runs the reset, then
#   4. removes the firewall rule again, even if the reset failed or you pressed Ctrl-C (an EXIT trap).
# Nothing secret is printed: not the database URL or its password (the reset script blanks them out of any
# error, too); only the one-time temporary password, in this terminal.
# Needs `az login` (the Sidekick Labs account) and `npm --prefix app ci` done once on this Mac.
set -u
set +x  # never echo commands: one of them carries the database URL
RG=sidekick-rg
DB=sidekick-labs-db
RULE=reset-password-tmp
ROOT=${0:A:h:h:h}

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <email> [--allow-password] [--reset-2fa]   or   $0 --owner <email> [--name \"Your name\"] [--reset-2fa]"; exit 2
fi
az account show >/dev/null 2>&1 || { echo "✗ Run az login first."; exit 1; }
[[ "$(az postgres flexible-server show -g $RG -n $DB --query state -o tsv)" == "Ready" ]] || { echo "✗ The database isn't running. Start it with ./infra/azure/unfreeze.sh first."; exit 1; }

IP=$(curl -fsS https://api.ipify.org) || { echo "✗ Couldn't find this Mac's public IP address."; exit 1; }
RULE_CREATED=0
cleanup() {
  unset DATABASE_URL
  [[ $RULE_CREATED == 1 ]] || return 0
  echo "Removing the temporary firewall rule…"
  az postgres flexible-server firewall-rule delete -g $RG --name $DB --rule-name $RULE --yes -o none \
    || echo "⚠ Couldn't remove it. Remove it by hand: az postgres flexible-server firewall-rule delete -g $RG --name $DB --rule-name $RULE --yes"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
echo "Letting $IP reach the database for this run (takes about a minute)…"
RULE_CREATED=1  # set first, so a create that half-worked is still cleaned up
az postgres flexible-server firewall-rule create -g $RG --name $DB --rule-name $RULE --start-ip-address $IP --end-ip-address $IP -o none || exit 1

# Read into a variable (not exported), so it reaches only the reset script below, never the screen or disk.
DATABASE_URL=$(az keyvault secret show --vault-name sidekick-kv -n database-url --query value -o tsv 2>/dev/null) || { echo "✗ Couldn't read database-url from Key Vault sidekick-kv (check az login and that you have Key Vault Administrator on it)."; exit 1; }
[[ -n "$DATABASE_URL" ]] || { echo "✗ Couldn't read the database-url secret."; exit 1; }
DATABASE_URL=$DATABASE_URL node --no-warnings "$ROOT/app/scripts/reset-password.mjs" "$@"
