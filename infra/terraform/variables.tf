# Inputs for Sidekick's Azure setup. Values that identify Cody's subscription, people or the live address live in
# `sidekick.tfvars` on the Mac (git-ignored; `./export-tfvars.sh` writes it from Azure, `sidekick.tfvars.example`
# shows its shape). None of them is a secret: secrets stay in Key Vault and are never a Terraform input.

variable "subscription_id" {
  description = "The Sidekick Labs Azure subscription (az account show --query id)."
  type        = string
}

variable "tenant_id" {
  description = "The Sidekick Labs Microsoft Entra tenant (az account show --query tenantId)."
  type        = string
}

variable "owner_object_id" {
  description = "Cody's Entra object id: Key Vault Administrator on sidekick-kv (az ad signed-in-user show --query id)."
  type        = string
}

variable "entra_app_id" {
  description = "The portal's Entra app id, which is also the Azure Bot's app id (the app setting CLIENT_ID)."
  type        = string
}

variable "alert_emails" {
  description = "Who the 'site down' and 'app restarts' alerts email (action group sidekick-alerts-ag), in the group's order."
  type        = list(object({ name = string, email = string }))
}

variable "budget_emails" {
  description = "Who the monthly budgets email at 50/80/100% and at 100% forecast."
  type        = list(string)
}

variable "meetbot_budget_emails" {
  description = "Who the meeting bot's budget sidekick-meetbot-monthly emails (meetbot-setup.sh's BUDGET_EMAIL)."
  type        = list(string)
}

variable "db_admin_login" {
  description = "Postgres admin user name. Must match the user inside Key Vault's `database-url` (export-tfvars.sh reads it from there)."
  type        = string
}

variable "db_password_version" {
  description = <<-EOT
    Bump by one to send the database admin password again. The password itself is never a Terraform input: it is
    read from Key Vault `database-url` while planning and sent write-only, so it is not stored in the state. Bump
    this after rotating the password in Key Vault (docs/RUNBOOKS.md → Rotate secrets).
  EOT
  type        = number
  default     = 1
}

variable "app_settings" {
  description = <<-EOT
    The app's plain (non-secret) settings, name => value, as they are on sidekick-app now: CLIENT_ID, TENANT_ID,
    SIDEKICK_PUBLIC_URL (the live address), AZURE_SEARCH_*, AZURE_OPENAI_*, SIDEKICK_OWNER_MS_ACCOUNTS, the
    SIDEKICK_MEETBOT_* settings, SIDEKICK_COMMIT / SIDEKICK_RELEASED_AT (set by each deploy) and so on.
    export-tfvars.sh copies them from the live app so a plan shows no setting changes. Settings that are secrets
    are not here: they are Key Vault references in app.tf.
  EOT
  type        = map(string)
}

variable "app_env_order" {
  description = "The order of the app's settings in Azure (names only; export-tfvars.sh writes it). New settings go after, sorted."
  type        = list(string)
  default     = []
}

variable "first_build" {
  description = <<-EOT
    true only when building from nothing (the app and the meeting bot job don't exist yet). Their managed identities
    are created by Azure together with them, so the very first apply makes them with a public placeholder image and
    without registry or Key Vault references (which the identities can't read yet); the roles are granted in the same
    apply. Then apply again with false. README → Rebuild from nothing.
  EOT
  type        = bool
  default     = false
}

variable "monitoring_enabled" {
  description = "Uptime check and its two alerts on. false = how the Nov 11, 2026 pause left them (switched off, kept)."
  type        = bool
  default     = true
}

variable "app_min_replicas" {
  description = "Copies of the app always running. 1 when live; the pause left 0 (with the app stopped)."
  type        = number
  default     = 1
}

variable "app_image" {
  description = "Image the app is created with. Only used when the app is created: after that deploys (GitHub Deploy, deploy.sh) own the image and Terraform ignores it."
  type        = string
  default     = "sidekicklabsacr.azurecr.io/sidekick:latest"
}

variable "meetbot_enabled" {
  description = "Create the live-meeting bot: Speech, the job, its database, roles and budget (docs/LIVE-MEETINGS.md)."
  type        = bool
  default     = true
}

variable "meetbot_image" {
  description = "Image the meeting bot job is created with. Only used at creation: meetbot-setup.sh builds and sets the real one."
  type        = string
  default     = "mcr.microsoft.com/k8se/quickstart-jobs:latest"
}

variable "meetbot_cpu" {
  description = "vCPUs in the bot job's template (live: 4). The app picks each meeting's size itself, so this is only the default (README → Known differences)."
  type        = number
  default     = 4
}

variable "meetbot_memory" {
  description = "Memory per meeting for the bot job (goes with meetbot_cpu: 2 GiB per vCPU)."
  type        = string
  default     = "8Gi"
}

variable "github_repo" {
  description = "The GitHub repository whose main branch may deploy (federated credential subject)."
  type        = string
  default     = "ScottyP1/side_kick"
}

variable "github_repo_ids_subject" {
  description = "The same repository's main branch in GitHub's immutable-id form (second federated credential, github-main-ids). Empty = not created."
  type        = string
  default     = ""
}

variable "keep_legacy_budget" {
  description = "Keep the older sidekick-monthly-25 budget (docs/HOSTING.md → Budgets: delete it if the extra early warning isn't wanted)."
  type        = bool
  default     = true
}

variable "budget_start" {
  description = "Start of the monthly budgets (first of a month). Azure won't change a budget's start date, so it's only used when one is created."
  type        = string
  default     = "2026-10-01T00:00:00Z"
}
