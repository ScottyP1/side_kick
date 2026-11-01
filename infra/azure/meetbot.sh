#!/bin/zsh
# Pauses or resumes Sidekick's live meeting bot in Azure, one command each way (docs/RUNBOOKS.md → "Meeting bot";
# Cody, Oct 31: "create bot, do all testing and snaps … then remove it all or pause somehow until we get a customer").
#
#   infra/azure/meetbot.sh status            what exists, what's running, and this month's cost (read-only)
#   CONFIRM=yes infra/azure/meetbot.sh pause    stop every running execution; take away the app's role on the job and
#                                               its meeting-bot settings (Sidekick then says live meetings aren't set
#                                               up, so nothing can join); delete (and purge) the Speech resource.
#                                               Keeps the job definition, the images, the attendee database, Key Vault
#                                               secrets and the budget: none of them cost anything while idle.
#   CONFIRM=yes BUDGET_EMAIL=… infra/azure/meetbot.sh resume
#                                               runs meetbot-setup.sh (recreates Speech, rolls the job to the current
#                                               image, gives the app its role and settings back).
#
# In the Owner Console too, when pausing: Live meetings → cap 0, and Releases & switches → "Live in meetings" off. The
# script can't sign in to the Owner Console; without the app's settings nothing can start anyway.
set -euo pipefail
cd "$(dirname "$0")/../.."
RG=sidekick-rg; APP=sidekick-app; JOB=sidekick-meetbot; SPEECH=sidekick-speech; LOC=eastus
APP_SETTINGS=(SIDEKICK_MEETBOT_JOB SIDEKICK_MEETBOT_RG AZURE_SUBSCRIPTION_ID SIDEKICK_MEETBOT_IMAGE SIDEKICK_MEETBOT_SECRET SIDEKICK_MEETBOT_CPU SIDEKICK_MEETBOT_MEMORY_GIB AZURE_SPEECH_KEY AZURE_SPEECH_REGION ATTENDEE_RAISE_HAND)
SUB=$(az account show --query id -o tsv)

month_cost() {
  cat > /tmp/meetbot-cost.json <<JSON
{ "type": "ActualCost", "timeframe": "MonthToDate",
  "dataset": { "granularity": "None", "aggregation": { "totalCost": { "name": "Cost", "function": "Sum" } },
    "grouping": [{ "type": "Dimension", "name": "ResourceId" }],
    "filter": { "tags": { "name": "sidekick-meetbot", "operator": "In", "values": ["1"] } } } }
JSON
  az rest --method post --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.CostManagement/query?api-version=2023-03-01" \
    --body @/tmp/meetbot-cost.json --query "properties.rows" -o tsv 2>/dev/null | awk -F'\t' '{ split($2, p, "/"); printf "  %-28s $%.2f\n", p[length(p)], $1; t += $1 } END { printf "  %-28s $%.2f (Azure usage data lags a few hours)\n", "total this month", t }'
  rm -f /tmp/meetbot-cost.json
}

status() {
  echo "Job $JOB:"; az containerapp job show -g $RG -n $JOB --query "{image:properties.template.containers[0].image, cpu:properties.template.containers[0].resources.cpu, memory:properties.template.containers[0].resources.memory}" -o tsv 2>/dev/null || echo "  (not there)"
  echo "Executions running now: $(az containerapp job execution list -g $RG -n $JOB --query "length([?properties.status=='Running'])" -o tsv 2>/dev/null || echo 0)"
  echo "Speech $SPEECH: $(az cognitiveservices account show -g $RG -n $SPEECH --query sku.name -o tsv 2>/dev/null || echo 'deleted')"
  echo "App settings for the bot: $(az containerapp show -g $RG -n $APP --query "length(properties.template.containers[0].env[?name=='SIDEKICK_MEETBOT_JOB'])" -o tsv) (0 = Sidekick can't start the bot)"
  echo "This month's cost of the bot's resources (tag sidekick-meetbot=1):"; month_cost
}

case "${1:-status}" in
  status) status ;;
  pause)
    [[ "${CONFIRM:-}" == "yes" ]] || { echo "Dry run: would stop running executions, remove the app's role and bot settings, delete and purge $SPEECH. Run with CONFIRM=yes."; exit 0; }
    echo "1/4 Stop running executions"
    for e in $(az containerapp job execution list -g $RG -n $JOB --query "[?properties.status=='Running'].name" -o tsv 2>/dev/null); do
      az containerapp job stop -g $RG -n $JOB --job-execution-name "$e" -o none
    done
    echo "2/4 The app can no longer start the bot"
    JOB_ID=$(az containerapp job show -g $RG -n $JOB --query id -o tsv)
    APP_PID=$(az containerapp show -g $RG -n $APP --query identity.principalId -o tsv)
    for a in $(az role assignment list --assignee "$APP_PID" --scope "$JOB_ID" --query "[].id" -o tsv); do az role assignment delete --ids "$a" -o none; done
    PRESENT=($(az containerapp show -g $RG -n $APP --query "properties.template.containers[0].env[].name" -o tsv | grep -xF -f <(print -l $APP_SETTINGS) || true))
    (( ${#PRESENT} )) && az containerapp update -g $RG -n $APP --remove-env-vars $PRESENT -o none
    echo "3/4 Delete the Speech resource (and purge it, so resume can reuse its name)"
    if az cognitiveservices account show -g $RG -n $SPEECH -o none 2>/dev/null; then
      az cognitiveservices account delete -g $RG -n $SPEECH -o none
      az cognitiveservices account purge -g $RG -n $SPEECH -l $LOC -o none
    fi
    echo "4/4 Check"
    status
    echo "Paused. Also set the cap to 0 in Owner Console → Live meetings, and switch Releases & switches → Live in meetings off."
    ;;
  resume)
    [[ "${CONFIRM:-}" == "yes" ]] || { echo "Dry run: would run meetbot-setup.sh (Speech, job image, the app's role and settings). Run with CONFIRM=yes BUDGET_EMAIL=…"; exit 0; }
    CONFIRM=yes zsh infra/azure/meetbot-setup.sh
    echo "Resumed. In the Owner Console: raise the Live meetings cap, and switch Live in meetings back on."
    ;;
  *) echo "Usage: infra/azure/meetbot.sh status | pause | resume"; exit 1 ;;
esac
