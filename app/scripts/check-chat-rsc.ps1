# Why can't Sidekick read a Teams chat? (docs/RUNBOOKS.md → Automatic meeting notes → "Sidekick can't see calls in a
# chat"). Sidekick reads a chat's call events with the chat-scoped permission ChatMessage.Read.Chat (resource-specific
# consent, RSC). Teams grants it only when Sidekick is added to (or updated in) that chat AND the tenant lets chat
# members consent to it. Graph's 403 "Resource specific consent grants on the request ''" means no grant reached the
# token for that chat. This script shows which of the three causes it is, read-only unless -EnableChatRsc:
#   1. Tenant chat RSC setting (Learn: Set-MgBetaChatRscConfiguration -State ManagedByMicrosoft | EnabledForAllApps |
#      DisabledForAllApps). Read from the authorization policy's permissionGrantPoliciesAssigned; the mapping of policy
#      ids to states below is inferred, not documented on Learn.
#   2. The grants in the chat: GET /beta/chats/{chatId}/permissionGrants (Learn: "Check your app for added RSC
#      permissions in a chat"); Sidekick's row has clientAppId = its app id with ChatMessage.Read.Chat.
#   3. Which Sidekick version is installed in the chat vs the org catalog (a chat keeps the version it was added with
#      until someone updates the app there, and consent covers that version's permissions).
# Fix: if the state is DisabledForAllApps (or ManagedByMicrosoft and the grant is missing), run with -EnableChatRsc
# (Set-MgBetaChatRscConfiguration -State EnabledForAllApps), then remove Sidekick from the chat and add it again.
#
# Sign-in: Graph PowerShell's interactive browser sign-in as a Global Administrator (or Teams Administrator +
# Privileged Role Administrator), asking for the scopes Learn lists for RSC settings. NOT tested against the tenant yet.
# Run: pwsh -File app/scripts/check-chat-rsc.ps1 -ChatId '19:…@thread.v2' [-AppId <Sidekick app id>] [-EnableChatRsc]
#   (needs: Install-Module Microsoft.Graph.Authentication -Scope CurrentUser; for -EnableChatRsc also Microsoft.Graph.Beta)
param(
  [Parameter(Mandatory = $true)][string]$ChatId,
  [string]$AppId = "ba9f8d71-4467-498b-bdfd-198f366c9d88",
  [switch]$EnableChatRsc
)
$ErrorActionPreference = "Stop"
Import-Module Microsoft.Graph.Authentication
$scopes = @("Policy.Read.All", "ResourceSpecificPermissionGrant.ReadForChat", "TeamsAppInstallation.ReadForChat", "AppCatalog.Read.All")
if ($EnableChatRsc) { $scopes += @("TeamworkAppSettings.ReadWrite.All", "Policy.ReadWrite.Authorization", "Policy.ReadWrite.PermissionGrant") }
Connect-MgGraph -Scopes $scopes -NoWelcome
$chat = [uri]::EscapeDataString($ChatId)

# 1. Tenant chat RSC setting.
$policy = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/policies/authorizationPolicy"
$assigned = @($policy.defaultUserRolePermissions.permissionGrantPoliciesAssigned) | Where-Object { $_ -like "*for-chat*" }
$state = if ($assigned -like "*all-application-permissions-for-chat*") { "EnabledForAllApps" }
  elseif ($assigned -like "*dynamically-managed-permissions-for-chat*") { "ManagedByMicrosoft" }
  elseif ($assigned) { "Custom" } else { "DisabledForAllApps" }
Write-Host "Chat RSC setting (inferred): $state   [$($assigned -join ', ')]"

# 2. Grants in this chat.
try {
  $grants = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/beta/chats/$chat/permissionGrants").value
  $mine = @($grants | Where-Object { $_.clientAppId -eq $AppId })
  if ($mine.Count) { $mine | ForEach-Object { Write-Host "Granted to Sidekick here: $($_.permission) ($($_.permissionType))" } }
  else { Write-Host "No resource-specific grant for Sidekick ($AppId) in this chat." }
} catch { Write-Host "Couldn't list the chat's grants: $($_.Exception.Message)" }

# 3. Installed version vs catalog.
try {
  $apps = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/chats/$chat/installedApps?`$expand=teamsAppDefinition").value
  $here = $apps | Where-Object { $_.teamsAppDefinition.authorization.clientAppId -eq $AppId -or $_.teamsAppDefinition.displayName -like "Sidekick*" } | Select-Object -First 1
  if ($here) {
    Write-Host "Installed here: $($here.teamsAppDefinition.displayName) $($here.teamsAppDefinition.version)"
    $cat = (Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps?`$filter=id eq '$($here.teamsAppDefinition.teamsAppId)'&`$expand=appDefinitions").value | Select-Object -First 1
    if ($cat) { Write-Host "Org catalog version: $(@($cat.appDefinitions)[-1].version)" }
  } else { Write-Host "Sidekick isn't installed in this chat." }
} catch { Write-Host "Couldn't list the chat's apps: $($_.Exception.Message)" }

if ($EnableChatRsc) {
  if (-not (Get-Command Set-MgBetaChatRscConfiguration -ErrorAction SilentlyContinue)) {
    throw "Set-MgBetaChatRscConfiguration isn't installed. Run: Install-Module Microsoft.Graph.Beta -Scope CurrentUser (Find-MgGraphCommand -Command Set-MgBetaChatRscConfiguration names its module)."
  }
  Set-MgBetaChatRscConfiguration -State EnabledForAllApps
  Write-Host "Chat RSC set to EnabledForAllApps. Now remove Sidekick from the chat and add it again (consent happens on install)."
}
Write-Host "DONE"
