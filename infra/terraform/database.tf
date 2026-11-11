# The database: Postgres Flexible Server sidekick-labs-db (Burstable B1ms, 32 GB, v17, Central US, 35-day
# point-in-time backups) with the databases `sidekick` (the app) and `attendee` (the meeting bot). TLS is required
# (the server's default) and the firewall lets in Azure services only.
#
# The admin password is never typed, stored in the repo or kept in the Terraform state: it is read from Key Vault
# `database-url` (the app's own connection string) with an ephemeral read while planning, and sent to Azure
# write-only. So the secrets `database-url` and `meetbot-database-url` keep working unchanged when the server is
# made again under the same name (as after the Nov 11, 2026 pause). Rotating it: set the new connection string in
# Key Vault, bump var.db_password_version, apply (docs/RUNBOOKS.md → Rotate secrets).
#
# Terraform makes the empty server and databases; the data comes back from the backups with after-apply.sh.

ephemeral "azurerm_key_vault_secret" "database_url" {
  name         = "database-url"
  key_vault_id = azurerm_key_vault.kv.id
}

locals {
  # postgres://<user>:<password>@<host>/<db>?… ; the password part is percent-decoded below.
  db_password_raw = regex("^postgres(?:ql)?://[^:]+:([^@]+)@", ephemeral.azurerm_key_vault_secret.database_url.value)[0]
  # Terraform has no urldecode(): decode the characters a URL can escape in a password (%XX, either case).
  pct = {
    "20" = " ", "21" = "!", "22" = "\"", "23" = "#", "24" = "$", "25" = "%", "26" = "&", "27" = "'", "28" = "(",
    "29" = ")", "2A" = "*", "2B" = "+", "2C" = ",", "2F" = "/", "3A" = ":", "3B" = ";", "3C" = "<", "3D" = "=",
    "3E" = ">", "3F" = "?", "40" = "@", "5B" = "[", "5C" = "\\", "5D" = "]", "5E" = "^", "60" = "`", "7B" = "{",
    "7C" = "|", "7D" = "}", "7E" = "~"
  }
  db_password_parts = split("%", local.db_password_raw)
  db_password = join("", concat([local.db_password_parts[0]], [
    for p in slice(local.db_password_parts, 1, length(local.db_password_parts)) :
    "${lookup(local.pct, upper(substr(p, 0, 2)), "%${substr(p, 0, 2)}")}${substr(p, 2, -1)}"
  ]))
}

resource "azurerm_postgresql_flexible_server" "db" {
  name                          = local.db_name
  resource_group_name           = azurerm_resource_group.sidekick.name
  location                      = local.db_location
  version                       = "17"
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  backup_retention_days         = 35
  geo_redundant_backup_enabled  = false
  public_network_access_enabled = true

  administrator_login               = var.db_admin_login
  administrator_password_wo         = local.db_password
  administrator_password_wo_version = var.db_password_version

  lifecycle {
    prevent_destroy = true
    # Azure picks the zone and the storage tier for a Burstable server; changing the zone isn't possible in place.
    ignore_changes = [zone, storage_tier]
  }
}

# "Allow public access from any Azure service": the app's outgoing addresses are a long shared list that can change,
# so they aren't pinned (docs/HOSTING.md → Security review). Private networking is the stronger option later.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  name             = "AllowAllAzureServicesAndResourcesWithinAzureIps"
  server_id        = azurerm_postgresql_flexible_server.db.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_postgresql_flexible_server_database" "sidekick" {
  name      = "sidekick"
  server_id = azurerm_postgresql_flexible_server.db.id
  charset   = "UTF8"
  collation = "en_US.utf8"
  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_postgresql_flexible_server_database" "attendee" {
  count     = var.meetbot_enabled ? 1 : 0
  name      = "attendee"
  server_id = azurerm_postgresql_flexible_server.db.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}
