# Terraform and provider versions for Sidekick's Azure setup (infra/terraform/README.md).
#
# azurerm covers almost everything; azapi is used only where azurerm can't say it: the budget-freeze Logic App's
# workflow (HTTP actions signed in with the Logic App's own managed identity) and reading that Logic App's trigger
# address for the action group. The exact provider builds are pinned in .terraform.lock.hcl (committed).
#
# State: the "local" backend with no path here. `terraform init` gets the path from the command line (README →
# First time on a Mac), so the state file lives on Cody's Mac next to the database backups, never in the repo.
# The state holds no database password (it is sent write-only, see database.tf) but does hold resource ids and the
# freeze Logic App's trigger address, so treat it like the backups: keep it, don't share it.
terraform {
  required_version = ">= 1.11" # write-only arguments (administrator_password_wo) and ephemeral resources
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.50" }
    azapi   = { source = "azure/azapi", version = "~> 2.5" }
  }
  backend "local" {}
}

# Signs in the way the az CLI is signed in (`az login` as the Sidekick Labs admin). Nothing secret is configured
# here. Resource providers are not auto-registered: the subscription already has the ones Sidekick uses.
provider "azurerm" {
  subscription_id                 = var.subscription_id
  resource_provider_registrations = "none"
  features {
    key_vault {
      # Never purge the vault or its secrets on destroy (purge protection forbids it anyway), and recover a
      # soft-deleted vault instead of failing when it is created again under the same name.
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}

provider "azapi" {
  subscription_id = var.subscription_id
}
