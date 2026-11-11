# The outside services Sidekick talks to: the Teams bot registration, AI Search and Azure AI Speech.

# Azure Bot sidekick-bot-dev (F0, single tenant). Its app id is the portal's Entra app; Teams sends the bot's
# messages to the live address + /api/messages (local.app_host, main.tf), so the address is never written down.
# The Entra app and its client secret are made in the Entra admin center, not here (README → Not covered).
resource "azurerm_bot_service_azure_bot" "bot" {
  name                    = "sidekick-bot-dev"
  resource_group_name     = azurerm_resource_group.sidekick.name
  location                = "global"
  sku                     = "F0"
  microsoft_app_id        = var.entra_app_id
  microsoft_app_type      = "SingleTenant"
  microsoft_app_tenant_id = var.tenant_id
  endpoint                = "https://${local.app_host}/api/messages"
  lifecycle {
    # Not set on the live bot (Azure's default: reachable, which Teams needs); the import reads it as false.
    ignore_changes = [icon_url, public_network_access_enabled]
  }
}

resource "azurerm_bot_channel_ms_teams" "teams" {
  bot_name            = azurerm_bot_service_azure_bot.bot.name
  location            = azurerm_bot_service_azure_bot.bot.location
  resource_group_name = azurerm_resource_group.sidekick.name
}

# AI Search sidekick-labs-search (Free: 50 MB, 3 indexes; index sidekick-cloud). A subscription may have only one
# free search service, and replacing it would lose the indexes, so it is protected. Moving up a tier is a new
# service (docs/RUNBOOKS.md → Search almost full), not an edit here.
resource "azurerm_search_service" "search" {
  name                = "sidekick-labs-search"
  resource_group_name = azurerm_resource_group.sidekick.name
  location            = local.db_location
  sku                 = "free"
  # Keys or Microsoft sign-in both accepted; a failed sign-in answers 401 with a bearer challenge (as set up).
  authentication_failure_mode = "http401WithBearerChallenge"
  lifecycle {
    prevent_destroy = true
    # Azure turns the free semantic ranker on by itself for this service.
    ignore_changes = [semantic_search_sku]
  }
}

# Azure AI Speech sidekick-speech (S0): the meeting bot's voice and captions. Its key is copied into Key Vault
# `azure-speech-key` by meetbot-setup.sh, not by Terraform (that would put the key in the state).
resource "azurerm_cognitive_account" "speech" {
  count               = var.meetbot_enabled ? 1 : 0
  name                = "sidekick-speech"
  resource_group_name = azurerm_resource_group.sidekick.name
  location            = local.location
  kind                = "SpeechServices"
  sku_name            = "S0"
  tags                = local.meetbot_tags
}
