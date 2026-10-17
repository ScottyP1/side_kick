#!/bin/zsh
# Shows whether Sidekick's Azure pieces are running, and this month's budgets (amount and spend so far).
RG=sidekick-rg
echo "App:      $(az containerapp show -g $RG -n sidekick-app --query properties.runningStatus -o tsv 2>/dev/null)"
echo "Database: $(az postgres flexible-server show -g $RG -n sidekick-labs-db --query state -o tsv 2>/dev/null)"
az consumption budget list --query "[].{budget:name, limit:amount, spent:currentSpend.amount}" -o table 2>/dev/null
