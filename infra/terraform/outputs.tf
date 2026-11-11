# What a finished apply prints. The live address is printed on the Mac only (it's never written into the repo).

output "app_url" {
  description = "The live address (health: /api/health)."
  value       = "https://${local.app_host}"
}

output "deployer_client_id" {
  description = "GitHub repository variable AZURE_CLIENT_ID for the Deploy workflow (docs/HOSTING.md → Automatic deploys)."
  value       = azurerm_user_assigned_identity.deployer.client_id
}

output "app_principal_id" {
  description = "The app's managed identity (AcrPull, Key Vault Secrets User, Contributor on the meeting bot job)."
  value       = azurerm_container_app.app.identity[0].principal_id
}

output "database_host" {
  description = "Postgres host name; after-apply.sh restores the backups here."
  value       = azurerm_postgresql_flexible_server.db.fqdn
}
