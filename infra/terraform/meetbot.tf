# The live-meeting bot (docs/LIVE-MEETINGS.md, docs/RUNBOOKS.md → Meeting bot): Container Apps job sidekick-meetbot
# in sidekick-env, started by the app once per meeting (manual trigger, one replica, at most 4.5 hours, no retries),
# plus Speech (services.tf), database `attendee` (database.tf) and the budget on everything tagged
# sidekick-meetbot=1. All of it only when var.meetbot_enabled.
#
# Split with infra/azure/meetbot-setup.sh: Terraform makes the resources, roles and budget; the script still does
# what Terraform shouldn't (it would put secrets or build output in the state): copy the Speech key into Key Vault,
# generate the bot's own secrets once, build the attendee/meetbot images and point the job and the app's
# SIDEKICK_MEETBOT_IMAGE at the new one. Its create steps find everything there already and do nothing.

locals {
  # Job secret name => Key Vault secret name, and the setting that reads it.
  job_secrets = {
    "credentials-key" = { kv = "meetbot-credentials-key", env = "CREDENTIALS_ENCRYPTION_KEY" }
    "database-url"    = { kv = "meetbot-database-url", env = "DATABASE_URL" }
    "django-secret"   = { kv = "meetbot-django-secret", env = "DJANGO_SECRET_KEY" }
    "speech-key"      = { kv = "azure-speech-key", env = "AZURE_SPEECH_KEY" }
  }
  job_secrets_now = var.first_build ? {} : local.job_secrets
  # The order the job's settings have in Azure (a reordered list shows as a change in every plan).
  job_secret_order = var.first_build ? [] : ["database-url", "django-secret", "credentials-key", "speech-key"]
}

resource "azurerm_container_app_job" "meetbot" {
  count                        = var.meetbot_enabled ? 1 : 0
  name                         = local.job_name
  resource_group_name          = azurerm_resource_group.sidekick.name
  location                     = local.location
  container_app_environment_id = azurerm_container_app_environment.env.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 16200 # 4.5 hours: a stuck bot can't run on
  replica_retry_limit          = 0
  tags                         = local.meetbot_tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type = "SystemAssigned"
  }

  dynamic "registry" {
    for_each = var.first_build ? [] : [1]
    content {
      server   = "${local.acr_name}.azurecr.io" # by name: known even while the registry is being made
      identity = "System"
    }
  }

  dynamic "secret" {
    for_each = local.job_secrets_now
    content {
      name                = secret.key
      key_vault_secret_id = "${local.vault_url}/${secret.value.kv}"
      identity            = "System"
    }
  }

  template {
    container {
      name   = local.job_name
      image  = var.first_build ? "mcr.microsoft.com/k8se/quickstart-jobs:latest" : var.meetbot_image
      cpu    = var.meetbot_cpu
      memory = var.meetbot_memory

      # Secret settings first, then the plain ones: the order the job has them (an order change shows as a diff).
      dynamic "env" {
        for_each = local.job_secret_order
        content {
          name        = local.job_secrets[env.value].env
          secret_name = env.value
        }
      }
      env {
        name  = "AZURE_SPEECH_REGION"
        value = local.location
      }
      env {
        name  = "POSTGRES_SSL_REQUIRE"
        value = "true"
      }
    }
  }

  lifecycle {
    # meetbot-setup.sh owns the image (attendee/meetbot builds in the registry).
    ignore_changes = [template[0].container[0].image]
  }
}

resource "azurerm_role_assignment" "job_acr_pull" {
  count                = var.meetbot_enabled ? 1 : 0
  scope                = azurerm_container_registry.acr.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_container_app_job.meetbot[0].identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "job_kv_reader" {
  count                = var.meetbot_enabled ? 1 : 0
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_container_app_job.meetbot[0].identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

# The app may start and stop the job (Contributor on the job only, nothing else).
resource "azurerm_role_assignment" "app_runs_job" {
  count                = var.meetbot_enabled ? 1 : 0
  scope                = azurerm_container_app_job.meetbot[0].id
  role_definition_name = "Contributor"
  principal_id         = azurerm_container_app.app.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

# Azure budgets only warn; the app's own cap (Owner Console → Live meetings) is what stops new meetings.
resource "azurerm_consumption_budget_resource_group" "meetbot" {
  count             = var.meetbot_enabled ? 1 : 0
  name              = "sidekick-meetbot-monthly"
  resource_group_id = azurerm_resource_group.sidekick.id
  amount            = 50
  time_grain        = "Monthly"
  time_period {
    start_date = var.budget_start
    end_date   = "2036-10-01T00:00:00Z"
  }
  filter {
    tag {
      name   = "sidekick-meetbot"
      values = ["1"]
    }
  }
  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      enabled        = true
      operator       = "GreaterThanOrEqualTo"
      threshold      = notification.value
      threshold_type = "Actual"
      contact_emails = var.meetbot_budget_emails
    }
  }
  lifecycle {
    ignore_changes = [time_period[0].start_date]
  }
}
