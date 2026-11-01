#!/usr/bin/env bash
# Step 7 of infra/azure/meetbot-setup.sh, on its own so it can be tested (app/tests/run.mjs → infra/azure/meetbot-budget.test.mjs
# runs it against a fake `az`): creates or updates the Azure budget `sidekick-meetbot-monthly` on the meeting bot's
# tagged resources (tag sidekick-meetbot=1), emailing BUDGET_EMAIL at 50/80/100% of BUDGET_USD a month.
#
# Azure refuses to change an existing budget's start date ("Start date of budgets cannot be updated"), so a second run
# in a later month used to fail here (found Nov 1 2026). Now an existing budget keeps its own start date and only the
# amount and emails are updated; a new budget starts on the first of this month (UTC).
#
# Usage (normally from meetbot-setup.sh): SUB=<subscription id> RG=<resource group> BUDGET_USD=50 BUDGET_EMAIL=<who> \
#   infra/azure/meetbot-budget.sh
set -euo pipefail
: "${SUB:?}" "${RG:?}" "${BUDGET_USD:?}" "${BUDGET_EMAIL:?}"

URL="https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Consumption/budgets/sidekick-meetbot-monthly?api-version=2023-05-01"
# The existing budget's start date, or nothing when there's no budget yet (az rest fails with 404).
START=$(az rest --method get --url "$URL" --query properties.timePeriod.startDate -o tsv 2>/dev/null || true)
if [[ -n "$START" ]]; then
  echo "  budget exists (since ${START%%T*}): keeping its start date, updating the amount and emails"
else
  START="$(date -u +%Y-%m-01)T00:00:00Z"
  echo "  new budget from ${START%%T*}"
fi
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
cat > "$BODY" <<JSON
{ "properties": {
  "category": "Cost", "amount": $BUDGET_USD, "timeGrain": "Monthly",
  "timePeriod": { "startDate": "$START" },
  "filter": { "tags": { "name": "sidekick-meetbot", "operator": "In", "values": ["1"] } },
  "notifications": {
    "actual50": { "enabled": true, "operator": "GreaterThanOrEqualTo", "threshold": 50, "contactEmails": ["$BUDGET_EMAIL"], "thresholdType": "Actual" },
    "actual80": { "enabled": true, "operator": "GreaterThanOrEqualTo", "threshold": 80, "contactEmails": ["$BUDGET_EMAIL"], "thresholdType": "Actual" },
    "actual100": { "enabled": true, "operator": "GreaterThanOrEqualTo", "threshold": 100, "contactEmails": ["$BUDGET_EMAIL"], "thresholdType": "Actual" }
  } } }
JSON
az rest --method put --url "$URL" --body @"$BODY" -o none
