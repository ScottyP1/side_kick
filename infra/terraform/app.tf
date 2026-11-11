# The web app and Teams bot endpoint: Container App sidekick-app (0.5 vCPU / 1 GiB, one copy, web address on port
# 8080) with its own system-assigned managed identity. That identity pulls the image (AcrPull, main.tf) and reads
# the app's secrets straight from Key Vault (Key Vault Secrets User, keyvault.tf): every secret below is a Key Vault
# reference with no version, so changing a value in the vault reaches the app within ~30 minutes or on restart, and
# no secret value ever passes through Terraform.
#
# Who owns what after creation:
#   - the image belongs to the deploys (GitHub Deploy workflow, infra/azure/deploy.sh): ignored here;
#   - the plain settings come from var.app_settings (export-tfvars.sh copies the live ones before a plan), so a
#     plan only shows setting changes someone made on purpose.

locals {
  # Container App secret name => Key Vault secret name, and the setting that reads it.
  app_secrets = merge(
    {
      "anthropic-api-key"    = { kv = "anthropic-api-key", env = "ANTHROPIC_API_KEY" }
      "client-secret"        = { kv = "client-secret", env = "CLIENT_SECRET" }
      "azure-search-api-key" = { kv = "azure-search-api-key", env = "AZURE_SEARCH_API_KEY" }
      "azure-openai-api-key" = { kv = "azure-openai-api-key", env = "AZURE_OPENAI_API_KEY" }
      "database-url"         = { kv = "database-url", env = "DATABASE_URL" }
      "encryption-key"       = { kv = "encryption-key", env = "SIDEKICK_ENCRYPTION_KEY" }
    },
    var.meetbot_enabled ? {
      "meetbot-secret"   = { kv = "meetbot-secret", env = "SIDEKICK_MEETBOT_SECRET" }
      "azure-speech-key" = { kv = "azure-speech-key", env = "AZURE_SPEECH_KEY" }
    } : {}
  )
  # On a first build the identity can't read the vault yet (it is created with the app), so no references then.
  app_secrets_now = var.first_build ? {} : local.app_secrets

  # Every setting, plain or secret, by name. Azure keeps settings as an ordered list, so they're written in the
  # order the live app has them (var.app_env_order, from export-tfvars.sh) and any new ones after, sorted:
  # otherwise every plan would show the whole list as changed.
  app_env = merge(
    { for k, v in var.app_settings : k => { value = v, secret = null } },
    { for k, s in local.app_secrets_now : s.env => { value = null, secret = k } }
  )
  app_env_names = concat(
    [for n in var.app_env_order : n if contains(keys(local.app_env), n)],
    sort([for n in keys(local.app_env) : n if !contains(var.app_env_order, n)])
  )
}

resource "azurerm_container_app" "app" {
  name                         = local.app_name
  resource_group_name          = azurerm_resource_group.sidekick.name
  container_app_environment_id = azurerm_container_app_environment.env.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  max_inactive_revisions       = 100

  identity {
    type = "SystemAssigned"
  }

  # identity = "System" (registry and secrets). The az CLI stored it as "system"; azurerm only accepts "System", so
  # the first plan after the import shows that spelling change once (same meaning).
  dynamic "registry" {
    for_each = var.first_build ? [] : [1]
    content {
      server   = "${local.acr_name}.azurecr.io" # by name: known even while the registry is being made
      identity = "System"
    }
  }

  dynamic "secret" {
    for_each = local.app_secrets_now
    content {
      name                = secret.key
      key_vault_secret_id = "${local.vault_url}/${secret.value.kv}"
      identity            = "System"
    }
  }

  ingress {
    external_enabled           = true
    target_port                = 8080
    transport                  = "auto"
    allow_insecure_connections = false
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.app_min_replicas
    max_replicas = 1

    container {
      name   = local.app_name
      image  = var.first_build ? "mcr.microsoft.com/k8se/quickstart:latest" : var.app_image
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = local.app_env_names
        content {
          name        = env.value
          value       = local.app_env[env.value].value
          secret_name = local.app_env[env.value].secret
        }
      }

      # Probes (docs/HOSTING.md → Monitoring): startup and readiness call /api/health (200 only when the database
      # answers); liveness is a plain port check, so a database blip takes the app out of traffic instead of
      # restarting it in a loop. Left out on a first build, whose placeholder image doesn't serve /api/health.
      dynamic "startup_probe" {
        for_each = var.first_build ? [] : [1]
        content {
          transport               = "HTTP"
          port                    = 8080
          path                    = "/api/health"
          initial_delay           = 5
          interval_seconds        = 5
          timeout                 = 5
          failure_count_threshold = 24
        }
      }
      dynamic "readiness_probe" {
        for_each = var.first_build ? [] : [1]
        content {
          transport               = "HTTP"
          port                    = 8080
          path                    = "/api/health"
          interval_seconds        = 15
          timeout                 = 5
          failure_count_threshold = 3
          success_count_threshold = 1
        }
      }
      dynamic "liveness_probe" {
        for_each = var.first_build ? [] : [1]
        content {
          transport               = "TCP"
          port                    = 8080
          initial_delay           = 0
          interval_seconds        = 30
          timeout                 = 5
          failure_count_threshold = 3
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }
}
