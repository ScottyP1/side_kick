# The safety net that says when the app itself is down (docs/HOSTING.md → Monitoring and alerts): a standard
# uptime test of /api/health every 15 minutes from East US and Central US (with a TLS check that warns 14 days
# before the certificate expires, ≈ $2.90/month), and two alerts that email the action group sidekick-alerts-ag.
# var.monitoring_enabled = false switches the test and both alerts off without deleting them (as the pause did).
#
# The alerts name their target and action group with the lower-case resource ids Azure stored (e.g.
# microsoft.insights/...): Terraform compares ids letter by letter, so the canonical spelling would show as a change.

locals {
  insights_id_lc = "${local.rg_id}/providers/microsoft.insights/components/sidekick-insights"
  app_id_lc      = "${local.rg_id}/providers/Microsoft.App/containerapps/${local.app_name}"
  # Azure even stored the subscription id in capitals inside these two.
  alerts_ag_id_lc = "/subscriptions/${upper(var.subscription_id)}/resourceGroups/${local.rg_name}/providers/microsoft.insights/actionGroups/sidekick-alerts-ag"
  freeze_ag_id_lc = "/subscriptions/${upper(var.subscription_id)}/resourceGroups/${local.rg_name}/providers/microsoft.insights/actionGroups/sidekick-freeze-ag"
}

resource "azurerm_monitor_action_group" "alerts" {
  name                = "sidekick-alerts-ag"
  resource_group_name = azurerm_resource_group.sidekick.name
  short_name          = "sk-alerts"
  dynamic "email_receiver" {
    for_each = var.alert_emails
    content {
      name          = email_receiver.value.name
      email_address = email_receiver.value.email
    }
  }
}

resource "azurerm_application_insights_standard_web_test" "health" {
  name                    = "sidekick-health-test"
  resource_group_name     = azurerm_resource_group.sidekick.name
  location                = local.location
  application_insights_id = azurerm_application_insights.insights.id
  description             = "Sidekick /api/health every 15 min from 2 regions"
  enabled                 = var.monitoring_enabled
  frequency               = 900
  timeout                 = 30
  retry_enabled           = true
  geo_locations           = ["us-va-ash-azr", "us-il-ch1-azr"] # East US, Central US

  request {
    url                              = "https://${local.app_host}/api/health"
    http_verb                        = "GET"
    follow_redirects_enabled         = false
    parse_dependent_requests_enabled = false
  }
  validation_rules {
    expected_status_code        = 200
    ssl_check_enabled           = true
    ssl_cert_remaining_lifetime = 14
  }
  lifecycle {
    # Azure adds a hidden-link tag pointing at the Application Insights resource.
    ignore_changes = [tags]
  }
}

# Severity 1: availability below 50% over 30 minutes, i.e. about two failed checks. What to do: RUNBOOKS → The site is down.
resource "azurerm_monitor_metric_alert" "site_down" {
  name                = "sidekick-site-down"
  resource_group_name = azurerm_resource_group.sidekick.name
  description         = "Sidekick /api/health failing from Azure test locations (about 2 failed checks in 30 min). See docs/RUNBOOKS.md → The site is down."
  scopes              = [local.insights_id_lc]
  severity            = 1
  auto_mitigate       = false
  frequency           = "PT15M"
  window_size         = "PT30M"
  enabled             = var.monitoring_enabled
  criteria {
    metric_namespace = "microsoft.insights/components"
    metric_name      = "availabilityResults/availabilityPercentage"
    aggregation      = "Average"
    operator         = "LessThan"
    threshold        = 50
  }
  action {
    action_group_id    = local.alerts_ag_id_lc
    webhook_properties = {}
  }
  depends_on = [azurerm_application_insights.insights, azurerm_container_app.app, azurerm_monitor_action_group.alerts]
}

# Severity 2: the container restarted in the last 15 minutes.
resource "azurerm_monitor_metric_alert" "app_restarts" {
  name                = "sidekick-app-restarts"
  resource_group_name = azurerm_resource_group.sidekick.name
  description         = "The Sidekick container restarted (crash, failed probe or out of memory). Check Log Analytics: ContainerAppConsoleLogs_CL."
  scopes              = [local.app_id_lc]
  severity            = 2
  auto_mitigate       = false
  frequency           = "PT15M"
  window_size         = "PT15M"
  enabled             = var.monitoring_enabled
  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "RestartCount"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 0
  }
  action {
    action_group_id    = local.alerts_ag_id_lc
    webhook_properties = {}
  }
  depends_on = [azurerm_application_insights.insights, azurerm_container_app.app, azurerm_monitor_action_group.alerts]
}
