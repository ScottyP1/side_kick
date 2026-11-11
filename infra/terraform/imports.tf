# Import blocks: the resources that already exist in Azure (everything the Nov 11, 2026 pause kept), so the first
# `terraform apply` adopts them instead of trying to make second copies. An import changes nothing in Azure by
# itself; the plan lists any setting it would change on top (README → What the first plan shows).
#
# Not imported because the pause deleted them (the first apply creates them): Postgres sidekick-labs-db with its
# firewall rule and databases, registry sidekicklabsacr, and the three role assignments on the registry.
#
# Once the first apply has run, these blocks do nothing (Terraform skips imports already in the state). Remove this
# file only if building into a different subscription or from nothing (README → Rebuild from nothing).

locals {
  sub   = "/subscriptions/${var.subscription_id}"
  rg    = "${local.sub}/resourceGroups/${local.rg_name}"
  ra    = "providers/Microsoft.Authorization/roleAssignments"
  kv_id = "${local.rg}/providers/Microsoft.KeyVault/vaults/${local.kv_name}"
  job   = "${local.rg}/providers/Microsoft.App/jobs/${local.job_name}"
  mb    = var.meetbot_enabled ? toset(["0"]) : toset([])
}

import {
  to = azurerm_resource_group.sidekick
  id = local.rg
}
import {
  to = azurerm_log_analytics_workspace.logs
  id = "${local.rg}/providers/Microsoft.OperationalInsights/workspaces/sidekick-logs"
}
import {
  to = azurerm_application_insights.insights
  id = "${local.rg}/providers/Microsoft.Insights/components/sidekick-insights"
}
import {
  to = azurerm_container_app_environment.env
  id = "${local.rg}/providers/Microsoft.App/managedEnvironments/${local.env_name}"
}
import {
  to = azurerm_container_app.app
  id = "${local.rg}/providers/Microsoft.App/containerApps/${local.app_name}"
}
import {
  to = azurerm_key_vault.kv
  id = local.kv_id
}
import {
  to = azurerm_bot_service_azure_bot.bot
  id = "${local.rg}/providers/Microsoft.BotService/botServices/sidekick-bot-dev"
}
import {
  to = azurerm_bot_channel_ms_teams.teams
  id = "${local.rg}/providers/Microsoft.BotService/botServices/sidekick-bot-dev/channels/MsTeamsChannel"
}
import {
  to = azurerm_search_service.search
  id = "${local.rg}/providers/Microsoft.Search/searchServices/sidekick-labs-search"
}
import {
  to = azurerm_monitor_action_group.alerts
  id = "${local.rg}/providers/Microsoft.Insights/actionGroups/sidekick-alerts-ag"
}
import {
  to = azurerm_monitor_action_group.freeze
  id = "${local.rg}/providers/Microsoft.Insights/actionGroups/sidekick-freeze-ag"
}
import {
  to = azurerm_application_insights_standard_web_test.health
  id = "${local.rg}/providers/Microsoft.Insights/webTests/sidekick-health-test"
}
import {
  to = azurerm_monitor_metric_alert.site_down
  id = "${local.rg}/providers/Microsoft.Insights/metricAlerts/sidekick-site-down"
}
import {
  to = azurerm_monitor_metric_alert.app_restarts
  id = "${local.rg}/providers/Microsoft.Insights/metricAlerts/sidekick-app-restarts"
}
import {
  to = azapi_resource.freeze
  id = "${local.rg}/providers/Microsoft.Logic/workflows/sidekick-freeze"
}
import {
  to = azurerm_user_assigned_identity.deployer
  id = "${local.rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/sidekick-deployer"
}
import {
  to = azurerm_federated_identity_credential.github_main
  id = "${local.rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/sidekick-deployer/federatedIdentityCredentials/github-main"
}
import {
  for_each = var.github_repo_ids_subject == "" ? toset([]) : toset(["0"])
  to       = azurerm_federated_identity_credential.github_main_ids[0]
  id       = "${local.rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/sidekick-deployer/federatedIdentityCredentials/github-main-ids"
}

# Custom roles: "<role definition id>|<scope>".
import {
  to = azurerm_role_definition.deployer
  id = "${local.sub}/providers/Microsoft.Authorization/roleDefinitions/a23d6548-e3cb-4b0f-93ed-99f800552039|${local.rg}"
}
import {
  to = azurerm_role_definition.freeze
  id = "${local.sub}/providers/Microsoft.Authorization/roleDefinitions/2e91b4f9-8e2c-42bb-b8dc-a9de7bf17aaa|${local.rg}"
}

# Role assignments that still exist (their ids are Azure's random names, not secrets).
import {
  to = azurerm_role_assignment.owner_kv_admin
  id = "${local.kv_id}/${local.ra}/df19338d-0277-4a8d-97a8-8c7f074eb641"
}
import {
  to = azurerm_role_assignment.app_kv_reader
  id = "${local.kv_id}/${local.ra}/2b4e2560-975d-446f-9fc9-e0ae5e913611"
}
import {
  to = azurerm_role_assignment.deployer_app
  id = "${local.rg}/providers/Microsoft.App/containerApps/${local.app_name}/${local.ra}/9a139a97-3275-4742-b095-7a878f919daf"
}
import {
  to = azurerm_role_assignment.freeze
  id = "${local.rg}/${local.ra}/8c1e26fc-5c2b-4565-a544-d530fece4e66"
}

# Budgets.
import {
  for_each = local.budgets
  to       = azurerm_consumption_budget_subscription.budget[each.key]
  id       = "${local.sub}/providers/Microsoft.Consumption/budgets/${each.key}"
}
import {
  for_each = var.keep_legacy_budget ? toset(["0"]) : toset([])
  to       = azurerm_consumption_budget_subscription.legacy[0]
  id       = "${local.sub}/providers/Microsoft.Consumption/budgets/sidekick-monthly-25"
}

# The meeting bot (only with var.meetbot_enabled).
import {
  for_each = local.mb
  to       = azurerm_cognitive_account.speech[0]
  id       = "${local.rg}/providers/Microsoft.CognitiveServices/accounts/sidekick-speech"
}
import {
  for_each = local.mb
  to       = azurerm_container_app_job.meetbot[0]
  id       = local.job
}
import {
  for_each = local.mb
  to       = azurerm_role_assignment.job_kv_reader[0]
  id       = "${local.kv_id}/${local.ra}/4be0a888-4db6-4ea7-bb61-c823bcc79176"
}
import {
  for_each = local.mb
  to       = azurerm_role_assignment.app_runs_job[0]
  id       = "${local.job}/${local.ra}/c128bb46-0b5f-417d-bae0-43a1d149db71"
}
import {
  for_each = local.mb
  to       = azurerm_consumption_budget_resource_group.meetbot[0]
  id       = "${local.rg}/providers/Microsoft.Consumption/budgets/sidekick-meetbot-monthly"
}
