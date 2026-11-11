# The shared base of Sidekick's Azure setup in resource group sidekick-rg: the group itself, logs, Application
# Insights, the Container Apps environment and the image registry. The app is in app.tf, the database in
# database.tf, secrets in keyvault.tf, Bot/Search/Speech in services.tf, uptime and alerts in monitoring.tf,
# budgets and the freeze in budgets.tf, the deploy identity in deployer.tf, the meeting bot in meetbot.tf.
# Names, sizes and regions are the ones docs/HOSTING.md describes; README.md says how to use this.

locals {
  rg_name  = "sidekick-rg"
  location = "eastus"
  # B1ms Postgres had no capacity in East US / East US 2 at setup, and the free Search tier lives there too.
  db_location = "centralus"

  env_name  = "sidekick-env"
  app_name  = "sidekick-app"
  acr_name  = "sidekicklabsacr"
  kv_name   = "sidekick-kv"
  db_name   = "sidekick-labs-db"
  job_name  = "sidekick-meetbot"
  vault_url = "https://${local.kv_name}.vault.azure.net/secrets"

  # The live address's host. Built from the environment's domain rather than read from the app's web address,
  # because that reads empty while the address is switched off (as during the pause); it's the same value.
  app_host = "${local.app_name}.${azurerm_container_app_environment.env.default_domain}"

  # Everything the meeting bot costs carries this tag, so its own budget (budgets.tf) sees only that.
  meetbot_tags = { "sidekick-meetbot" = "1" }
}

resource "azurerm_resource_group" "sidekick" {
  name     = local.rg_name
  location = local.location
  lifecycle {
    prevent_destroy = true
  }
}

# Console and system logs of the Container Apps environment. Hard cap 0.1 GB/day keeps it inside the free 5 GB/month.
resource "azurerm_log_analytics_workspace" "logs" {
  name                = "sidekick-logs"
  resource_group_name = azurerm_resource_group.sidekick.name
  location            = local.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 0.1
  lifecycle {
    ignore_changes = [local_authentication_enabled] # not set on the live workspace (Azure's default applies)
  }
}

# Runs the uptime test (monitoring.tf); keeps its own results 90 days on the same workspace.
resource "azurerm_application_insights" "insights" {
  name                = "sidekick-insights"
  resource_group_name = azurerm_resource_group.sidekick.name
  location            = local.location
  workspace_id        = azurerm_log_analytics_workspace.logs.id
  application_type    = "web"
  retention_in_days   = 90
  lifecycle {
    # Not set on the live resource (= keep everything); azurerm would otherwise write its own default.
    ignore_changes = [sampling_percentage]
  }
}

# The Container Apps environment (Consumption profile). Its default domain is part of the live address, so it must
# never be replaced: the pause kept it for exactly that reason.
resource "azurerm_container_app_environment" "env" {
  name                       = local.env_name
  resource_group_name        = azurerm_resource_group.sidekick.name
  location                   = local.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.logs.id
  logs_destination           = "log-analytics"

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  lifecycle {
    prevent_destroy = true
    # Azure fills these in itself (e.g. the generated infrastructure resource group); changing them would replace
    # the environment and so change the live address.
    ignore_changes = [infrastructure_resource_group_name, log_analytics_workspace_id]
  }
}

# Image registry (Basic, ~$5/month). Admin user and anonymous pull off: the app and the meeting bot job pull with
# their managed identities (AcrPull, below and in meetbot.tf), deploys push with the Sidekick Deployer role.
resource "azurerm_container_registry" "acr" {
  name                   = local.acr_name
  resource_group_name    = azurerm_resource_group.sidekick.name
  location               = local.location
  sku                    = "Basic"
  admin_enabled          = false
  anonymous_pull_enabled = false
}

resource "azurerm_role_assignment" "app_acr_pull" {
  scope                = azurerm_container_registry.acr.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_container_app.app.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}
