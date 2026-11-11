# Monthly budgets and the automatic freeze (docs/HOSTING.md → Budgets and alerts).
#
# Every budget emails var.budget_emails at 50%, 80% and 100% of actual spend and at 100% forecast. When the whole
# subscription passes 100% of sidekick-total-50, its alert also calls action group sidekick-freeze-ag, which runs
# Logic App sidekick-freeze: it stops sidekick-app and sidekick-labs-db (like infra/azure/freeze.sh) with its own
# managed identity, whose only right is the custom role "Sidekick Freeze" (read, stop and start those two). Budget
# data lags usage by up to a day, so spend can go a little past $50 before the freeze runs. Undo: unfreeze.sh.

locals {
  rg_id = azurerm_resource_group.sidekick.id
  # name => amount (USD/month) and the one resource it watches (null = the whole subscription). Azure stores the
  # resource ids in lower case, so they're compared that way.
  budgets = {
    "sidekick-total-50"        = { amount = 50, resource = null }
    "sidekick-app-hosting"     = { amount = 20, resource = "${local.rg_id}/providers/microsoft.app/containerapps/${local.app_name}" }
    "sidekick-app-environment" = { amount = 5, resource = "${local.rg_id}/providers/microsoft.app/managedenvironments/${local.env_name}" }
    "sidekick-database"        = { amount = 20, resource = "${local.rg_id}/providers/microsoft.dbforpostgresql/flexibleservers/${local.db_name}" }
    "sidekick-registry"        = { amount = 7, resource = "${local.rg_id}/providers/microsoft.containerregistry/registries/${local.acr_name}" }
    "sidekick-ai-foundry"      = { amount = 10, resource = "${local.rg_id}/providers/microsoft.cognitiveservices/accounts/codyscott-9578-resource" }
    "sidekick-search"          = { amount = 3, resource = "${local.rg_id}/providers/microsoft.search/searchservices/sidekick-labs-search" }
    "sidekick-bot"             = { amount = 2, resource = "${local.rg_id}/providers/microsoft.botservice/botservices/sidekick-bot-dev" }
  }
  budget_thresholds = [
    { threshold = 50, type = "Actual" },
    { threshold = 80, type = "Actual" },
    { threshold = 100, type = "Actual" },
    { threshold = 100, type = "Forecasted" },
  ]
}

resource "azurerm_consumption_budget_subscription" "budget" {
  for_each        = local.budgets
  name            = each.key
  subscription_id = "/subscriptions/${var.subscription_id}"
  amount          = each.value.amount
  time_grain      = "Monthly"

  time_period {
    start_date = var.budget_start
    end_date   = "2028-09-30T00:00:00Z"
  }

  dynamic "filter" {
    for_each = each.value.resource == null ? [] : [lower(each.value.resource)]
    content {
      dimension {
        name   = "ResourceId"
        values = [filter.value]
      }
    }
  }

  dynamic "notification" {
    for_each = local.budget_thresholds
    content {
      enabled        = true
      operator       = "GreaterThan"
      threshold      = notification.value.threshold
      threshold_type = notification.value.type
      contact_emails = var.budget_emails
      # Only the whole-subscription budget, only at 100% actual, calls the freeze.
      contact_groups = each.key == "sidekick-total-50" && notification.value.threshold == 100 && notification.value.type == "Actual" ? [local.freeze_ag_id_lc] : []
    }
  }

  lifecycle {
    # Azure refuses to change a budget's start date ("Start date of budgets cannot be updated").
    ignore_changes = [time_period[0].start_date]
  }
  depends_on = [azurerm_monitor_action_group.freeze]
}

# The older $25 budget (80% actual, 100% forecast, one address). Optional: var.keep_legacy_budget.
resource "azurerm_consumption_budget_subscription" "legacy" {
  count           = var.keep_legacy_budget ? 1 : 0
  name            = "sidekick-monthly-25"
  subscription_id = "/subscriptions/${var.subscription_id}"
  amount          = 25
  time_grain      = "Monthly"
  time_period {
    start_date = var.budget_start
    end_date   = "2028-09-30T00:00:00Z"
  }
  notification {
    operator       = "GreaterThan"
    threshold      = 80
    threshold_type = "Actual"
    contact_emails = [var.budget_emails[0]]
  }
  notification {
    operator       = "GreaterThan"
    threshold      = 100
    threshold_type = "Forecasted"
    contact_emails = [var.budget_emails[0]]
  }
  lifecycle {
    ignore_changes = [time_period[0].start_date]
  }
}

# --- The freeze -----------------------------------------------------------------------------------------------

resource "azurerm_role_definition" "freeze" {
  name        = "Sidekick Freeze"
  scope       = local.rg_id
  description = "Budget freeze Logic App: stop/start sidekick-app and the Postgres server. Nothing else."
  permissions {
    actions = [
      "Microsoft.App/containerApps/read",
      "Microsoft.App/containerApps/stop/action",
      "Microsoft.App/containerApps/start/action",
      "Microsoft.DBforPostgreSQL/flexibleServers/read",
      "Microsoft.DBforPostgreSQL/flexibleServers/stop/action",
      "Microsoft.DBforPostgreSQL/flexibleServers/start/action",
    ]
  }
  assignable_scopes = [local.rg_id]
}

# Written with azapi because azurerm's Logic App actions can't sign in with the Logic App's managed identity.
# Trigger: an HTTP request (the action group's call). Actions: stop the app and the database, side by side.
resource "azapi_resource" "freeze" {
  type      = "Microsoft.Logic/workflows@2019-05-01"
  name      = "sidekick-freeze"
  parent_id = local.rg_id
  location  = local.location
  identity {
    type         = "SystemAssigned"
    identity_ids = []
  }
  body = {
    properties = {
      state      = "Enabled"
      parameters = {}
      definition = {
        "$schema"      = "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#"
        contentVersion = "1.0.0.0"
        outputs        = {}
        triggers = {
          budget_alert = { type = "Request", kind = "Http", inputs = { schema = {} } }
        }
        actions = {
          Stop_Sidekick_app = {
            type     = "Http"
            runAfter = {}
            inputs = {
              method         = "POST"
              uri            = "https://management.azure.com${azurerm_container_app.app.id}/stop?api-version=2024-03-01"
              authentication = { type = "ManagedServiceIdentity", audience = "https://management.azure.com/" }
            }
          }
          Stop_database = {
            type     = "Http"
            runAfter = {}
            inputs = {
              method         = "POST"
              uri            = "https://management.azure.com${local.rg_id}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${local.db_name}/stop?api-version=2022-12-01"
              authentication = { type = "ManagedServiceIdentity", audience = "https://management.azure.com/" }
            }
          }
        }
      }
    }
  }
  tags = { purpose = "sidekick budget freeze" }
}

resource "azurerm_role_assignment" "freeze" {
  scope              = local.rg_id
  role_definition_id = azurerm_role_definition.freeze.role_definition_resource_id
  principal_id       = azapi_resource.freeze.identity[0].principal_id
  principal_type     = "ServicePrincipal"
}

# The trigger's address (it carries a signature, so it's marked sensitive; it can only start the freeze).
# A data source, so a plan already knows it (listCallbackUrl only reads; it changes nothing).
data "azapi_resource_action" "freeze_callback" {
  type                             = "Microsoft.Logic/workflows/triggers@2019-05-01"
  resource_id                      = "${azapi_resource.freeze.id}/triggers/budget_alert"
  action                           = "listCallbackUrl"
  method                           = "POST"
  sensitive_response_export_values = ["value"]
}

resource "azurerm_monitor_action_group" "freeze" {
  name                = "sidekick-freeze-ag"
  resource_group_name = azurerm_resource_group.sidekick.name
  short_name          = "skfreeze"
  logic_app_receiver {
    name                    = "freeze-logic-app"
    resource_id             = azapi_resource.freeze.id
    callback_url            = data.azapi_resource_action.freeze_callback.sensitive_output.value
    use_common_alert_schema = true
  }
}
