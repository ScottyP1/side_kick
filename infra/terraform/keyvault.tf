# Secrets: Key Vault sidekick-kv (Standard, Azure RBAC, soft-delete 90 days + purge protection). Terraform manages
# the vault and who may read it, NEVER the secret values: no azurerm_key_vault_secret resource exists here on
# purpose, so no value is ever in the code, a plan or the state. Values are set by hand or by the scripts
# (docs/RUNBOOKS.md → Rotate secrets; infra/azure/meetbot-setup.sh for the meeting bot's).
#
# Who can read values: Cody (Key Vault Administrator) and the app's and meeting bot job's managed identities (Key
# Vault Secrets User, read only). Nothing else has a role on the vault.

resource "azurerm_key_vault" "kv" {
  name                          = local.kv_name
  resource_group_name           = azurerm_resource_group.sidekick.name
  location                      = local.location
  tenant_id                     = var.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  public_network_access_enabled = true
  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "owner_kv_admin" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Administrator"
  principal_id         = var.owner_object_id
  principal_type       = "User"
}

resource "azurerm_role_assignment" "app_kv_reader" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_container_app.app.identity[0].principal_id
  principal_type       = "ServicePrincipal"
}

# The secret NAMES the app and the meeting bot read (never their values). A plan warns when one is missing, e.g.
# when rebuilding into a new vault: set it first (RUNBOOKS → Rotate secrets has the command for each).
data "azurerm_key_vault_secrets" "names" {
  key_vault_id = azurerm_key_vault.kv.id
}

locals {
  required_secrets = concat(
    [for s in values(local.app_secrets) : s.kv],
    var.meetbot_enabled ? ["meetbot-database-url", "meetbot-django-secret", "meetbot-credentials-key"] : []
  )
}

check "secrets_exist" {
  assert {
    condition     = length(setsubtract(local.required_secrets, data.azurerm_key_vault_secrets.names.names)) == 0
    error_message = "Key Vault sidekick-kv is missing: ${join(", ", setsubtract(local.required_secrets, data.azurerm_key_vault_secrets.names.names))}. Set them before the app needs them (docs/RUNBOOKS.md → Rotate secrets, infra/azure/meetbot-setup.sh)."
  }
}
