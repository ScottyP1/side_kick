# The GitHub deploy identity (docs/HOSTING.md → Automatic deploys). No stored Azure password: GitHub's own login
# token (OIDC) is exchanged for the user-assigned managed identity sidekick-deployer, which trusts only this repo's
# main branch. Its only role is the custom role "Sidekick Deployer", on the registry and on the app: run image
# builds and read their logs, read the app and its revisions, update the app (image and settings). It can't list
# the app's secrets, read registry passwords, delete anything or grant access.
#
# The workflow finds it through the repository variables AZURE_CLIENT_ID (output deployer_client_id),
# AZURE_TENANT_ID and AZURE_SUBSCRIPTION_ID; set those again if the identity is ever made anew.

resource "azurerm_user_assigned_identity" "deployer" {
  name                = "sidekick-deployer"
  resource_group_name = azurerm_resource_group.sidekick.name
  location            = local.location
}

resource "azurerm_federated_identity_credential" "github_main" {
  name                      = "github-main"
  user_assigned_identity_id = azurerm_user_assigned_identity.deployer.id
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "repo:${var.github_repo}:ref:refs/heads/main"
  audience                  = ["api://AzureADTokenExchange"]
}

# The same branch in GitHub's immutable-id subject form (owner@id/repo@id), which survives a repository rename.
resource "azurerm_federated_identity_credential" "github_main_ids" {
  count                     = var.github_repo_ids_subject == "" ? 0 : 1
  name                      = "github-main-ids"
  user_assigned_identity_id = azurerm_user_assigned_identity.deployer.id
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = var.github_repo_ids_subject
  audience                  = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_definition" "deployer" {
  name        = "Sidekick Deployer"
  scope       = local.rg_id
  description = "GitHub deploys: run image builds in the registry and switch sidekick-app's image and settings. Cannot read secrets (no listSecrets / listCredentials), delete anything or grant access."
  permissions {
    actions = [
      "Microsoft.ContainerRegistry/registries/read",
      "Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action",
      "Microsoft.ContainerRegistry/registries/scheduleRun/action",
      "Microsoft.ContainerRegistry/registries/runs/read",
      "Microsoft.ContainerRegistry/registries/runs/listLogSasUrl/action",
      "Microsoft.ContainerRegistry/registries/runs/cancel/action",
      "Microsoft.App/containerApps/read",
      "Microsoft.App/containerApps/write",
      "Microsoft.App/containerApps/revisions/read",
    ]
  }
  assignable_scopes = [local.rg_id]
}

resource "azurerm_role_assignment" "deployer_acr" {
  scope              = azurerm_container_registry.acr.id
  role_definition_id = azurerm_role_definition.deployer.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.deployer.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "deployer_app" {
  scope              = azurerm_container_app.app.id
  role_definition_id = azurerm_role_definition.deployer.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.deployer.principal_id
  principal_type     = "ServicePrincipal"
  # The existing assignment spells the scope ".../containerapps/..."; the same app, so don't replace it over that.
  lifecycle {
    ignore_changes = [scope]
  }
}
