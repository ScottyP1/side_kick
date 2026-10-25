# One-time Teams setup for Sidekick automatic meeting notes (docs/RUNBOOKS.md → Automatic meeting notes, step 3):
# creates the application access policy that lets the Sidekick app read online meetings and transcripts, grants it
# org-wide, turns Teams transcription on in the Global meeting policy, and turns on the tenant's "Transcript API
# access" switch (EnableGraphTranscriptAccess, off by default since Microsoft's 2026 change; without it Graph answers
# 403 GraphAccessToTranscriptsDisabled) plus speaker names in transcripts (EnableAttributedTranscripts, so notes know
# who said what). Safe to run again.
#
# Why this way: on a Mac, Connect-MicrosoftTeams' normal sign-in crashes (it loads a Windows-only library) and the
# device-code sign-in is blocked by Entra security defaults (error 530035). So it reuses the Azure CLI's sign-in
# (`az login` as a Global Administrator) and passes those access tokens in. Tokens are never printed or saved.
# Run: pwsh -File app/scripts/teams-access-policy.ps1   (needs: brew install powershell; az login)
$ErrorActionPreference = "Stop"
Import-Module MicrosoftTeams
$graph = az account get-access-token --resource 00000003-0000-0000-c000-000000000000 --query accessToken -o tsv
$teams = az account get-access-token --resource 48ac35b8-9aa8-4d74-927d-1f4a14a0b239 --query accessToken -o tsv
Connect-MicrosoftTeams -AccessTokens @($graph, $teams) | Out-Null
Write-Host "Connected to Teams as Global Admin."

$existing = $null
try { $existing = Get-CsApplicationAccessPolicy -Identity "Sidekick-Meetings" } catch { $existing = $null }
if (-not $existing) {
  New-CsApplicationAccessPolicy -Identity "Sidekick-Meetings" -AppIds "ba9f8d71-4467-498b-bdfd-198f366c9d88" -Description "Sidekick reads meeting transcripts" | Out-Null
  Write-Host "Created access policy Sidekick-Meetings."
} else { Write-Host "Access policy Sidekick-Meetings already exists." }
Grant-CsApplicationAccessPolicy -PolicyName "Sidekick-Meetings" -Global
Write-Host "Granted it for the whole organization."

Set-CsTeamsMeetingPolicy -Identity Global -AllowTranscription $true
$t = (Get-CsTeamsMeetingPolicy -Identity Global).AllowTranscription
Write-Host "Transcription on for everyone: $t"
Set-CsTeamsMeetingConfiguration -Identity Global -EnableGraphTranscriptAccess $true -EnableAttributedTranscripts $true
$c = Get-CsTeamsMeetingConfiguration -Identity Global
Write-Host "Apps may read transcripts (Graph): $($c.EnableGraphTranscriptAccess); speaker names: $($c.EnableAttributedTranscripts)"
Write-Host "DONE (Microsoft says changes can take up to 30 minutes to apply)."
