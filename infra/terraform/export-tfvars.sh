#!/bin/zsh
# Writes infra/terraform/sidekick.tfvars (git-ignored) from what is in Azure now, so a `terraform plan` compares the
# code with the real setup instead of with guesses: the subscription and tenant ids, Cody's object id, the bot's app
# id, who the alerts and budgets email, the database admin user name and the app's plain settings with their order
# (including the live address, which must never be committed). Reads only; changes nothing in Azure.
#
# No secret value is written or printed. The database admin user name is taken from Key Vault `database-url`; the
# password in it is dropped inside the parser and never leaves it.
#
# Usage: infra/terraform/export-tfvars.sh   (signed in with `az login` as the Sidekick Labs admin)
# Run it again before each plan: deploys change SIDEKICK_COMMIT / SIDEKICK_RELEASED_AT, meetbot-setup.sh changes
# SIDEKICK_MEETBOT_IMAGE.
set -euo pipefail
cd "$(dirname "$0")"
RG=sidekick-rg
OUT=sidekick.tfvars

SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
OWNER=$(az ad signed-in-user show --query id -o tsv)
BOT_APP=$(az bot show -g $RG -n sidekick-bot-dev --query properties.msaAppId -o tsv)
SETTINGS=$(az containerapp show -g $RG -n sidekick-app --query "properties.template.containers[0].env" -o json)
ALERTS=$(az monitor action-group show -g $RG -n sidekick-alerts-ag --query emailReceivers -o json)
BUDGET=$(az rest --method get --url "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.Consumption/budgets/sidekick-total-50?api-version=2023-05-01" --query "properties.notifications" -o json)
MB_BUDGET=$(az rest --method get --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Consumption/budgets/sidekick-meetbot-monthly?api-version=2023-05-01" --query "properties.notifications" -o json 2>/dev/null || echo '{}')
IDS_SUBJECT=$(az identity federated-credential show -g $RG --identity-name sidekick-deployer -n github-main-ids --query subject -o tsv 2>/dev/null || true)
DB_USER=$(az keyvault secret show --vault-name sidekick-kv -n database-url --query value -o tsv | python3 -c '
import sys, urllib.parse as u
print(u.unquote(u.urlsplit(sys.stdin.read().strip()).username or ""))')

SUB=$SUB TENANT=$TENANT OWNER=$OWNER BOT_APP=$BOT_APP SETTINGS=$SETTINGS ALERTS=$ALERTS BUDGET=$BUDGET \
MB_BUDGET=$MB_BUDGET IDS_SUBJECT=$IDS_SUBJECT DB_USER=$DB_USER python3 - > $OUT <<'PY'
import json, os
e = os.environ
q = json.dumps  # HCL strings are JSON strings
env = json.loads(e["SETTINGS"])
settings = {s["name"]: s.get("value", "") for s in env if not s.get("secretRef")}  # secret ones are in app.tf
alerts = [{"name": r["name"], "email": r["emailAddress"]} for r in json.loads(e["ALERTS"])]
def emails(notifs):
    seen = []
    for n in notifs.values():
        for m in n.get("contactEmails", []):
            if m not in seen: seen.append(m)
    return seen
print("# Written by export-tfvars.sh from Azure. Git-ignored: it holds the live address and ids. No secrets.")
print(f"subscription_id = {q(e['SUB'])}")
print(f"tenant_id       = {q(e['TENANT'])}")
print(f"owner_object_id = {q(e['OWNER'])}")
print(f"entra_app_id    = {q(e['BOT_APP'])}")
print(f"db_admin_login  = {q(e['DB_USER'])}")
print(f"github_repo_ids_subject = {q(e['IDS_SUBJECT'])}")
print("alert_emails = ["); [print(f"  {{ name = {q(a['name'])}, email = {q(a['email'])} }},") for a in alerts]; print("]")
print(f"budget_emails = {q(emails(json.loads(e['BUDGET'])))}")
mb = emails(json.loads(e["MB_BUDGET"])) or emails(json.loads(e["BUDGET"]))[:1]
print(f"meetbot_budget_emails = {q(mb)}")
print("app_settings = {"); [print(f"  {q(k)} = {q(v)}") for k, v in settings.items()]; print("}")
print(f"app_env_order = {q([s['name'] for s in env])}")
PY
echo "Wrote infra/terraform/$OUT ($(grep -c . $OUT) lines; git-ignored). Next: terraform plan -var-file=$OUT"
