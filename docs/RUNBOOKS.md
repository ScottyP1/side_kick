# Runbooks: what to do when something goes wrong

Step-by-step fixes for the live Azure site (resource group `sidekick-rg`). Run the commands on the Mac after
`az login`. Never paste a secret value into chat, a ticket or this repo: type it into the command, or read
it from where it lives. Background and costs are in `docs/HOSTING.md`; the October 2026 security and
operations review is in `docs/security/`.

**Quick reference**

| Situation | Go to |
|---|---|
| A deploy broke the site | [Roll back](#roll-back-a-bad-deploy) |
| Data deleted or corrupted | [Restore the database](#restore-the-database) |
| A key may have leaked, or it's expiring | [Rotate secrets](#rotate-secrets) |
| Someone broke in, or something is badly wrong | [Incident](#incident-leaked-key-break-in-data-loss) |
| The site is down (uptime alert email) | [Site down](#the-site-is-down) |
| Microsoft 365 trial ends Nov 14, 2026 | [Trial end](#microsoft-365-trial-ending-nov-14-2026) |
| Locked out of the portal or the Owner Console | [Locked out](#locked-out-of-the-portal-or-the-owner-console) |
| A merge didn't deploy ("Deploy skipped") | [Deploy skipped](#deploy-skipped) |
| Set up (or renew) the Azure DevOps / Jira / GitHub / Confluence connector apps | [Connector apps](#connector-apps-azure-devops-jira-github-confluence) |
| A customer's connector shows "Sign-in expired" or a problem | [Connector problems](#connector-problems) |
| Reminders/watchers stopped, Owner Console → Job queue shows a backlog, stuck or dead jobs | [Job queue stuck](#job-queue-stuck) |
| Setting up automatic meeting notes and the Teams tab, or they stopped working | [Automatic meeting notes](#automatic-meeting-notes-microsoft-setup) |
| "Sidekick isn't allowed to remove itself from Teams chats" under Needs attention, or a Teams chat never shows as waiting | [Teams self-removal](#teams-sidekick-cant-remove-itself-from-chats) |

## Roll back a bad deploy

Automatic deploys (GitHub Actions → Deploy) roll back by themselves when the new version isn't answering
`/api/health` with its own commit within ten minutes. `./infra/azure/deploy.sh` prints the version that was live before and, if the new one isn't
healthy, the exact rollback command. To pause automatic deploys: Actions → Deploy → ⋯ → Disable workflow. Every image tag is kept in the registry, so any earlier version
can come back:

```bash
az acr repository show-tags -n sidekicklabsacr --repository sidekick --orderby time_desc --top 10 -o tsv
```

```bash
az containerapp update -g sidekick-rg -n sidekick-app --image sidekicklabsacr.azurecr.io/sidekick:<tag> --set-env-vars SIDEKICK_COMMIT=<tag>
```

Then check `https://<the live address>/api/health` answers `"ok":true` and `"commit":"<tag>"`.

- A rollback changes only the code. Database tables added by the newer version stay (they're
  `CREATE … IF NOT EXISTS`, so the older code just ignores them); nothing is dropped.
- Fix the problem on a branch, merge, and deploy again as usual.

## Restore the database

Postgres (`sidekick-labs-db`) keeps point-in-time backups (35 days, see HOSTING → Data). A restore always
creates a **new** server; the live one is untouched until you switch.

1. Pick a time just before the problem (UTC), then restore to a new server:
   ```bash
   az postgres flexible-server restore -g sidekick-rg --name sidekick-labs-db-restore --source-server sidekick-labs-db --restore-time "2026-10-20T12:00:00Z"
   ```
   This takes about 10–20 minutes and bills a second small server while it exists.
2. Give it the same firewall rule as the live server ("Allow Azure services"):
   ```bash
   az postgres flexible-server firewall-rule create -g sidekick-rg --name sidekick-labs-db-restore --rule-name AllowAzure --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
   ```
3. Check the data is what you expect (connect with `psql` using the same user and password; only the host
   name changes).
4. Switch the app: put the new connection string in Key Vault as a new version of `database-url`
   (type it into the command, or read it into a variable; never paste it into chat), then restart.
   ```bash
   az keyvault secret set --vault-name sidekick-kv -n database-url --value "<new connection string>" -o none
   ```
   ```bash
   az containerapp revision restart -g sidekick-rg -n sidekick-app --revision $(az containerapp show -g sidekick-rg -n sidekick-app --query properties.latestRevisionName -o tsv)
   ```
5. The search index rebuilds itself from Postgres (`reindexAzure` in `app/src/lib/search.ts`); nothing to do.
6. Once happy, delete the old server (or keep it a few days, then delete) and update `docs/HOSTING.md`
   with the new server name and its budget.

**Only one thing to undo?** (one deleted workspace or document): restore to a new server as above, copy
just those rows back, and delete the restored server, instead of switching the whole app.

## Rotate secrets

The live app's secrets live in **Key Vault `sidekick-kv`** (HOSTING → Settings and secrets); the Container App
only holds references to them. Names only: `az keyvault secret list --vault-name sidekick-kv --query "[].name" -o tsv`.
Changing one = adding a new **version** in the vault (the old version stays, so you can go back). The app
picks it up within about 30 minutes; restart (step at the end) to use it straight away.

| Secret | Where it's made | Notes |
|---|---|---|
| `anthropic-api-key` | console.anthropic.com → API keys | Create the new key, set it, restart, check, then delete the old one. |
| `client-secret` | Entra admin center → App registrations → **Sidekick Bot** → Certificates & secrets | Current secret "sidekick dev" **expires 2027-04-13**. Create a new one, set it, delete the old one. Also update `app/.env.local` if the laptop should keep working. |
| `azure-search-api-key` | `az search admin-key renew -g sidekick-rg --service-name sidekick-labs-search --key-kind secondary` | Switch the app to the secondary key, then renew the primary (no downtime). |
| `azure-openai-api-key` | `az cognitiveservices account keys regenerate -g sidekick-rg -n codyscott-9578-resource --key-name key2` | Same two-key swap as Search. |
| `encryption-key` (`SIDEKICK_ENCRYPTION_KEY`) | (exists since Oct 21, 2026) | **Never rotate casually**: authenticator-app secrets encrypted with the old key stop opening, so everyone with an authenticator app must remove and re-add it (passkeys and backup codes keep working). Rotate only if it leaked. |
| `ado-client-secret` (`ADO_CLIENT_SECRET`) | Entra admin center → App registrations → **Sidekick Connectors (Azure DevOps)** → Certificates & secrets | Note its expiry date here when you create it. New secret, set it, restart, connect once from a test org, delete the old one. Customers' connections keep working (their sign-ins aren't tied to the app secret). |
| `jira-client-secret` (`JIRA_CLIENT_SECRET`) | developer.atlassian.com → My apps → **Sidekick** → Settings → Rotate secret | Atlassian keeps the old secret working for a short overlap; set the new one and restart within it. Confluence uses this app too (unless it has its own `confluence-client-secret`). |
| `github-client-secret` (`GITHUB_CLIENT_SECRET`) | github.com → Settings → Developer settings → GitHub Apps → **Sidekick connector** → Client secrets | GitHub allows two secrets at once: generate the new one, set it, restart, connect once from a test org, then delete the old one. |
| `m365-client-secret` (`M365_CLIENT_SECRET`) | Entra admin center → App registrations → **Sidekick Connectors (Microsoft 365)** → Certificates & secrets | Note its expiry date here when you create it (24 months). Create a new one, set it, restart, check a sync, then delete the old one. |
| `database-url` | `az postgres flexible-server update -g sidekick-rg -n sidekick-labs-db --admin-password "<new>"` | Then rebuild the connection string with the new password. |

Set a new value without it showing on screen. Either type it at a hidden prompt:

```bash
read -rs "V?New value: " && az keyvault secret set --vault-name sidekick-kv -n anthropic-api-key --value "$V" -o none; unset V
```

or pipe it straight from the command that makes it (e.g. a renewed Search key):

```bash
az search admin-key show -g sidekick-rg --service-name sidekick-labs-search --query secondaryKey -o tsv | tr -d '\n' | az keyvault secret set --vault-name sidekick-kv -n azure-search-api-key --file /dev/stdin -o none
```

Then restart so the app reads it now:

```bash
az containerapp revision restart -g sidekick-rg -n sidekick-app --revision $(az containerapp show -g sidekick-rg -n sidekick-app --query properties.latestRevisionName -o tsv)
```

Check `/api/health`, ask one question in the portal and one `@Sidekick` question in Teams.

- **Go back to the previous value:** each change is a version. List them with
  `az keyvault secret list-versions --vault-name sidekick-kv -n <name> -o table`, then set the old one again
  (`az keyvault secret show --vault-name sidekick-kv -n <name> --version <id> --query value -o tsv | tr -d '\n' | az keyvault secret set --vault-name sidekick-kv -n <name> --file /dev/stdin -o none`) and restart.
- **App can't start after a change** (health 503, or the revision fails with a Key Vault error in
  `az containerapp logs show -g sidekick-rg -n sidekick-app --type system`): check the app's identity still has
  "Key Vault Secrets User" on the vault (`az role assignment list --scope $(az keyvault show -n sidekick-kv --query id -o tsv) -o table`).
- A secret deleted by mistake: `az keyvault secret recover --vault-name sidekick-kv -n <name>` (kept 90 days).

## Incident: leaked key, break-in, data loss

1. **Stop the damage.** Either the Owner Console kill switch (pauses the portal and Teams for every client,
   data stays) or, if the Azure resources themselves may be abused, `./infra/azure/freeze.sh` (stops the app
   and the database).
2. **Rotate every secret** above, not just the one you suspect. Also change the Azure/Entra admin password
   and sign out its other sessions (Entra → Users → Revoke sessions). Check nobody new has a role on the vault
   or the resource group (`az role assignment list -g sidekick-rg --all -o table`; only Cody, the app's
   identity, "Sidekick Deployer" and "Sidekick Freeze" belong there).
3. **Look at what happened:** the portal's Security & audit page (who did what), Activity → Traces
   (requests, errors), Entra admin center → Sign-in logs (unexpected countries or failed sign-ins), the
   container logs in Log Analytics (`ContainerAppConsoleLogs_CL`), GitHub → Settings → Security log.
4. **Data lost or changed?** [Restore the database](#restore-the-database) to just before it happened.
5. **Bring it back:** `./infra/azure/unfreeze.sh` or turn the kill switch off; check health, sign in, ask
   a question.
6. **Write it down** in `docs/PROGRESS.md`: what happened, when, what was exposed, what changed. If client
   data may have been seen by someone else, the affected organizations must be told.

## The site is down

The uptime alert emails when `/api/health` fails from Azure's test locations (HOSTING → Monitoring).

1. Open `https://<the live address>/api/health`.
   - **503 with `"reachable":false`**: the database is down or unreachable. Check it:
     `az postgres flexible-server show -g sidekick-rg -n sidekick-labs-db --query state -o tsv`
     (`Stopped`: someone froze it or Azure's 7-day auto-start; run `./infra/azure/unfreeze.sh`).
   - **`"ok":true` but `claude`/`teams` false, or the revision won't start**: a Key Vault reference may be
     failing; see [Rotate secrets](#rotate-secrets) → App can't start after a change.
   - **No answer / 404 "Container App – Unavailable"**: the app isn't running. `./infra/azure/status.sh`,
     then the logs: `az containerapp logs show -g sidekick-rg -n sidekick-app --tail 100 --type console`.
2. Just deployed? [Roll back](#roll-back-a-bad-deploy).
3. A budget freeze? `status.sh` shows the app stopped and a budget at 100%: decide whether to raise the
   budget, then `unfreeze.sh`.

## Job queue stuck

Every background task (daily reminders, leaving unassigned Teams chats, roll-off deletions, the watchers,
clean-up) is a job in the `jobs` table, run by a heartbeat every 30 seconds (HOSTING → Scheduled work).
Signs of trouble: reminders or "Needs attention" stop updating, or **Owner Console → Job queue** says
"Needs a look" (backlog waiting more than 5 minutes, stuck jobs, or dead letters).

1. **Is the heartbeat running?** Job queue page → "Last 24 hours … last" should be under a minute or two old.
   If not:
   - Is the app up (`/api/health`)? If not, [Site down](#the-site-is-down).
   - Is `SIDEKICK_SCHEDULER=off` set on the Container App without an external scheduler (HOSTING)? Remove it,
     or set up the Container Apps job.
   - Logs: `az containerapp logs show -g sidekick-rg -n sidekick-app --tail 200 --type console | grep -i "heartbeat\|Job "`.
     "Job heartbeat: the tick answered 5xx" means the tick route itself fails: the reference code in the
     Owner Console → Performance & errors says why (usually the database).
2. **Stuck jobs** (running, lease ran out): the worker stopped mid-job (deploy, crash). Nothing to do: the next
   beat takes the job over (that counts as an attempt). If they keep coming back, the job itself hangs; check
   its kind's logs.
3. **Dead letters** (gave up after its attempts): read "Last error" (a reason, never client content).
   - Fix the cause first (e.g. Teams or Microsoft Graph refusing, a feature paused, the database full).
   - Then **Retry** on the row (fresh attempts) or **Cancel** if it's no longer needed. A recurring job
     (reminders, watchers…) doesn't need a retry: its next slot runs on its own.
4. **Need everything to run now** (after fixing something): **Run all now** on the Job queue page.
5. **Last resort, in the database** (Postgres, `psql` as in [Restore the database](#restore-the-database)):
   ```sql
   -- what's waiting and why
   SELECT kind, status, COUNT(*), MIN(run_at), MAX(attempts) FROM jobs WHERE status IN ('queued','running','dead') GROUP BY kind, status;
   -- release every lease (only when no copy of the app is running a job, e.g. app stopped)
   UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL WHERE status = 'running';
   ```
   Never delete `queued` rows of a kind you don't understand: a roll-off deletion job deletes client data on
   purpose and must finish or be canceled in the Owner Console (Roll-offs) instead.

## Automatic meeting notes: Microsoft setup

Automatic notes after Teams meetings (lib/meetings-graph.ts) and the Sidekick tab in Teams (lib/teams/tab.ts) are
built and tested against a fake Microsoft Graph, but need these **one-time Microsoft settings, done by Cody** (the
app never changes Azure, Entra or Teams settings itself, and no secret is needed in chat or in the repo). Do them
in order; each step says where. "The Entra app" is the multi-tenant sign-in/directory app (`ENTRA_CLIENT_ID` on the
Container App; if that isn't set, the bot's app `CLIENT_ID`).

**Before you start: cost check.** Microsoft meters some Teams Graph APIs. Open Microsoft's page *"Payment models and
licensing requirements for Microsoft Teams APIs"* and check whether meeting transcripts (`getAllTranscripts`,
transcript content) are listed as metered for your licence. If they are, stop and decide first: nothing is charged
until a customer turns automatic notes on.

### 0. Billing for transcripts (Azure, once)
Microsoft charges for reading Teams transcripts through Graph (about **$0.0022 per meeting minute**; ~$6.60 per 100
half-hour meetings; see Microsoft's "Teams licenses" page for Graph). Link the Azure subscription to the Entra app as a
metered-API billing account, once (done Oct 25, 2026 as `sidekick-graph-billing` in `sidekick-rg`):
```bash
az provider register --namespace Microsoft.GraphServices --wait
az resource create -g sidekick-rg -n sidekick-graph-billing --resource-type Microsoft.GraphServices/accounts --location global --properties '{"appId":"<Entra app id>"}'
```
Customers don't need this: the transcripts are read by Sidekick's app, billed to Sidekick.

### 1. Graph permissions on the Entra app (Entra admin center)
1. Entra admin center → App registrations → the Entra app → **API permissions** → Add a permission → Microsoft Graph
   → **Application permissions**: add `OnlineMeetingTranscript.Read.All` (read transcripts of scheduled meetings),
   `OnlineMeetings.Read.All` (read the meeting's subject, times, chat and invitees, to pick the group) and
   **`CallTranscripts.Read.All`** (read transcripts of *ad hoc calls*: a **Meet now** started inside a group chat is
   not an online meeting, and without this permission Graph answers 403 "API requires one of
   'CallTranscripts.Read.All'" and those calls get no notes).
2. **Grant admin consent for Sidekick Labs** (the button on the same page). All three show a green tick.
3. Customers' Microsoft admins approve the new permissions with the same button as before: portal → **Users &
   access → Approve Sidekick for your organization** (it asks for everything the Entra app lists). Tenants that
   approved before `CallTranscripts.Read.All` was added approve once more; until then the Meetings page says
   "approve the new call transcripts permission" and scheduled meetings keep working.

### 2. Teams single sign-on for the tab (Entra admin center, same app)
1. **Expose an API** → Application ID URI: `api://<live host>/<Entra app id>` (the live host without https://, e.g.
   `sidekick-app.<…>.azurecontainerapps.io`; must match the Teams package, which `teams:package` fills the same way).
   If you later move to a custom domain, set `SIDEKICK_TEAMS_SSO_URL` on the Container App to the old address until
   the new package is out, so both audiences are accepted.
2. **Add a scope** `access_as_user`, "Admins and users", display names "Use Sidekick in Teams".
3. **Add a client application** for each of Microsoft's Teams/Microsoft 365 client ids, ticking that scope:
   `1fec8e78-bce4-4aaf-ab1b-5451cc387264` (Teams desktop/mobile), `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` (Teams web),
   `4765445b-32c6-49b0-83e6-1d93765276ca`, `0ec893e0-5785-4de6-99da-4ed124e5296c`, `d3590ed6-52b3-4102-aeff-aad2292ab01c`,
   `bc59ab01-8403-45c6-8796-ac3ef710b3e3`, `27922004-5251-4030-b22d-91ecd9a37ea4` (Microsoft 365 and Outlook).
4. **Manifest** (the app registration's own JSON): set `"accessTokenAcceptedVersion": 2` (Sidekick checks v2 tokens).

### 3 + 4. Allow Sidekick to read meetings, and turn transcription on (Teams PowerShell, once per tenant)
Graph only lets an app read online meetings with an *application access policy*, which only Teams PowerShell can set.
On a Mac (done Oct 25, 2026 for Sidekick Labs):
```bash
brew install powershell
pwsh -File app/scripts/teams-access-policy.ps1
```
The script reuses the `az login` session (a Global Administrator) because Teams PowerShell's own sign-in crashes on
macOS and its device-code sign-in is blocked by Entra security defaults (error 530035). It creates and grants the
`Sidekick-Meetings` policy org-wide, sets **Transcription: On** in the Global meeting policy, and turns on the tenant's
**Transcript API access** (`Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true`, plus
`-EnableAttributedTranscripts $true` for speaker names); it ends with `DONE`. Microsoft made Transcript API access a
separate switch in 2026, **off by default**: without it Graph answers 403 `GraphAccessToTranscriptsDisabled` even with
every permission approved, and the Meetings page says "doesn't let apps read meeting transcripts yet". (Some tenants
also show it in the Teams admin center → Meetings → Meeting settings → Transcript API access; ours didn't.)
Changes can take up to 30 minutes to apply. Customers' Teams admins (usually on Windows) run the equivalent:
`Connect-MicrosoftTeams; New-CsApplicationAccessPolicy -Identity Sidekick-Meetings -AppIds '<Entra app id>'; Grant-CsApplicationAccessPolicy -PolicyName Sidekick-Meetings -Global; Set-CsTeamsMeetingConfiguration -Identity Global -EnableGraphTranscriptAccess $true -EnableAttributedTranscripts $true`
(send them this section). Sidekick can only write notes for meetings with a transcript.

Since Oct 25, 2026 the script also sets **`-AutoRecording Enabled`** in the Global meeting policy (see "Meetings that
transcribe by themselves" below), and takes `-NoVideoRecording` for organizations that want transcripts but never
video. It prints each value it set, and warns if custom meeting policies exist (people assigned one don't get the
Global settings).

### 5. New Teams package (version 1.4.0: Meetings tab, chat/channel/meeting tab)
```bash
npm --prefix app run teams:package
```
Upload `teams/build/sidekick-teams-live.zip` in the Teams admin center → Manage apps → Sidekick → **Upload file**
(replaces 1.3.0). Users see the **Meetings** tab in Sidekick's app bar entry, and can add Sidekick as a tab with **+**
in chats, channels and meetings.

### 6. Turn it on and check (with Jojo Boom and User2)
1. Portal → **Meetings** → *Automatic notes after Teams meetings* → **Turn on**. The panel should say new meetings
   "arrive within minutes" (a Graph subscription exists). If it shows a problem instead, it names the missing step.
2. Jojo and User2 each sign in to the portal **with Microsoft** once and are members of the same group; that group
   has a Teams notes chat.
3. Jojo schedules a short Teams meeting with User2, both join, **start transcription**, talk for a minute about a
   decision and a to-do, end the meeting.
4. Within a few minutes (at most ~15): the meeting appears under Meetings with a **Teams** tag, and the notes card is
   in the group's notes chat. Click **Save to knowledge** on the decision.
5. In Teams, open Sidekick → **Meetings**: the tab shows the group, the meeting and its action items without asking
   to sign in.

### 7. Meetings that transcribe by themselves (scheduled meetings)
People forget **Start transcription**, and without a transcript there are no notes. What Microsoft offers (checked on
Microsoft Learn, Oct 25, 2026):

| Setting | What it does | Licence | Status |
| --- | --- | --- | --- |
| `Set-CsTeamsMeetingPolicy -AutoRecording Enabled` | Shows organizers the **Record and transcribe automatically** meeting option. It is **Off** for each meeting until the organizer turns it on. There is no admin setting that turns it on by default. | Standard Teams (no Premium) | Confirmed (Learn: "Manage Teams meeting auto recording", May 2026) |
| **Transcribe only** (same meeting option) | Organizers choose Off / Record and transcribe / **Transcribe only** when scheduling. Transcribe only makes a transcript and no video. Needs `AllowTranscription` on and `AutoRecording` Enabled. | Standard Teams (no Premium) | Rolled out May–June 2026 (Microsoft message center). The Learn pages don't mention it yet. |
| `AllowCloudRecording $false` (script `-NoVideoRecording`) | Nobody can record video. With MC1508234 / RM570468 (Targeted Release early Nov, worldwide early–mid Dec 2026), organizers see only the choices their policy allows: recording off + transcription on = **Transcribe only** or Off. | Standard Teams | Confirmed in MC1508234. Changing it is a choice for each customer: it also stops manual recordings. |
| Teams Premium **meeting template** with the option on and locked | Every meeting made from the template transcribes with nothing to click. | **Teams Premium** for each organizer | Confirmed (Learn). Organizers still have to pick the template. |
| Graph `onlineMeeting.recordAutomatically` | Turns on automatic recording (video and transcript) for one meeting. Graph has no "transcribe only" property. | Standard. Needs `OnlineMeetings.ReadWrite.All` (a write permission Sidekick doesn't have). | Confirmed in the Graph reference (v1.0 and beta). **Not built**: see the follow-up below. |
| Meet now and calls in a chat | None of the above applies. They have no meeting options. | n/a | Assumed from the docs (the auto-recording page covers meetings, webinars and town halls only). Sidekick's reminder (below) covers these. |

**So, without Premium:** run the script (it sets `AutoRecording Enabled`), then tell organizers to pick
**Transcribe only** in *Meeting options → Record and transcribe automatically* when they schedule a group's meetings.
Customer admins without PowerShell: Teams admin center → Meetings → Meeting policies → Global → *Recording &
transcription*: **Transcription** On. For **Auto recording**, Microsoft documents only PowerShell or a template:
`Set-CsTeamsMeetingPolicy -Identity Global -AutoRecording Enabled`.

**Follow-up (not built):** when Sidekick sees a scheduled meeting whose chat is linked to a group, it could set
`recordAutomatically: true` with `PATCH /users/{organizer}/onlineMeetings/{id}`. That needs the application permission
`OnlineMeetings.ReadWrite.All` (admin consent) and the access policy. It records video as well as the transcript,
because Graph has no transcribe-only property, so we'd want each customer's agreement first.

### 8. "Turn on transcription?" reminders in calls (Meet now, calls in a group chat)
`lib/call-nudge.ts`. When a call starts in a group chat linked to a group, and after about 2 minutes the chat shows
no transcript or recording event for that call, Sidekick posts one card there: *"Turn on transcription? … More (…) →
Record and transcribe → Start transcription …"*, with how to stop these. It posts once per call and at most once per
chat every 30 minutes. It posts nothing on the chat's quiet days if reminders are on there. It only runs while
automatic notes are on. Each group can switch it off: group → **Teams chats** → **Transcription reminders**, or
`@Sidekick stop transcription reminders` / `start transcription reminders` in the chat (Team Lead or admin, audited).

- **How it sees calls:** Teams posts call events (`callStartedEventMessageDetail`, `callEndedEventMessageDetail`,
  `callTranscriptEventMessageDetail`, `callRecordingEventMessageDetail`) as system messages in the chat. Every minute
  the job `calls.watch` reads each watched chat's latest 25 messages:
  `GET /v1.0/chats/{id}/messages?$top=25&$orderby=createdDateTime desc` with `Prefer: include-unknown-enum-members`.
  Bots aren't sent call events for group chats: Teams' meetingStart/End bot events cover only scheduled and channel
  meetings (Learn, "Meeting apps APIs").
- **Permission:** `ChatMessage.Read.Chat` (application, resource-specific consent). It has been in the Teams package
  since 1.1.0, and Teams grants it in each chat when Sidekick is added there. **No new permission and no re-upload are
  needed for the reminders.** Package **1.6.0** only adds "stop transcription reminders" to Sidekick's command menu
  (the command works without it). Re-upload it whenever convenient: `npm --prefix app run teams:package`, then Teams
  admin center → Manage apps → Sidekick → Upload file.
- **Confirmed in the docs:** app-only list messages accepts `ChatMessage.Read.Chat` as the least-privileged permission
  and returns system messages with `eventDetail`. Call events exist for chats. Without the Prefer header they come back
  as `messageType: unknownFutureValue` (Sidekick reads `eventDetail` either way).
- **Assumed, check live:** (1) The transcript event's timing. Microsoft doesn't say if it's posted when transcription
  starts or only when the transcript is ready, so the card says "if someone already started it, ignore this". (2) The
  Oct 25 probe got a 403 from app-only `GET /chats/{id}/messages`. That was probably a chat without Sidekick in it, so
  no permission had been granted there. A chat Graph refuses is listed on the group's Teams chats tab ("can't see calls
  in …"). Fix: remove Sidekick from that chat and add it again. If every chat is refused, check that the tenant allows
  chat resource-specific consent, or add the tenant-wide `Chat.Read.WhereInstalled` application permission instead.
- **Live check:** in a linked group chat, start **Meet now** with Jojo and User2 and don't transcribe. Within about
  3 minutes the card appears, Activity shows "Transcription reminder", and the audit log has "Reminded … to start
  transcription". In a second call, start transcription at once: no card (unless the transcript event only appears at
  the end, which tells us assumption 1).
- **Cost:** one Graph read per watched chat per minute. Microsoft's "Metered APIs" page (updated Apr 2026) says
  Teams APIs stopped being metered on Aug 25, 2025, so these reads cost nothing. The limit to watch is Graph
  throttling: a 429 stops that organization's check until the next minute.

### When it stops working
- **Panel says Sidekick can't read transcripts / isn't approved**: steps 1 and 3 (consent, or the access policy
  missing in that tenant). Fix, then **Check now**.
- **Panel says it can't read calls started with Meet now**: `CallTranscripts.Read.All` isn't approved in that tenant
  (step 1). Approve, then **Check now**: calls from the last 24 hours are still picked up.
- **A Meet now call gives no notes** (permission approved, transcript visible in the call's Recap): run the probe
  **within an hour of the call**, as Sidekick's app, for the people in the call (whoever started transcription is
  the one Graph files it under):
  `node --env-file=app/.env.local app/scripts/probe-call-transcripts.mjs --tenant <tenant id> --user <sign-in name> --user …`
  It lists ad hoc and scheduled transcripts on Graph v1.0 and beta. If only **beta** finds the call, set
  `SIDEKICK_GRAPH_ADHOC_VERSION=beta` on the Container App (Sidekick then reads ad hoc calls through beta).
  Not yet confirmed (Oct 25): an empty list 12 hours after a Meet now, on both versions, may mean these calls'
  transcripts can only be listed for a few hours.
- **Panel says "checked every 15 minutes" (no instant notifications)**: the subscription couldn't be made; the poll
  still works. Check that `SIDEKICK_PUBLIC_URL` is the live https address and `/api/graph/notifications` is reachable.
  Owner Console → Job queue → `meetings.subscription` shows the last error.
- **A meeting shows Skipped**: the reason says why (not one group's meeting, meeting hours used up, AI credit, read-only
  plan). **Failed** = Graph kept refusing after 6 tries: **Try again** after fixing the cause.
- **The tab says "Teams didn't sign you in"**: step 2 (Application ID URI must match the package's
  `webApplicationInfo.resource`; `accessTokenAcceptedVersion` 2; the scope and client ids).
- **The tab says you don't have an account**: the person must exist in Sidekick and sign in with Microsoft once
  (there's no matching by email).

## Teams: Sidekick can't remove itself from chats

**What you see:** Home → Needs attention (Org Owners/Admins): "Sidekick isn't allowed to remove itself from
Teams chats", naming the chats. Sidekick tried to leave them (a Member added it, nobody assigned the chat
within 7 days, or someone pressed Remove in the portal) but Microsoft refused. Sidekick reads and answers
nothing there meanwhile and retries every hour.

**Fix (once per tenant, a Microsoft admin):**
1. Entra admin center (entra.microsoft.com) → **App registrations** → the Sidekick app (the bot's app id,
   `CLIENT_ID`) → **API permissions** → **Add a permission** → Microsoft Graph → **Application permissions**:
   `TeamsAppInstallation.ReadWriteSelfForChat.All` and `TeamsAppInstallation.ReadWriteSelfForTeam.All`
   (if they aren't listed yet).
2. **Grant admin consent for <tenant>** on the same page, and check both show "Granted". (For a customer
   tenant in multi-tenant mode: Users & access → **Approve Sidekick for your organization** does the same.)
3. Wait for the next hourly retry (or Owner Console → Job queue → run `teams.leave`): Sidekick leaves those
   chats and the finding clears itself.

**Or by hand:** remove Sidekick from the chat in Teams (chat → ⋯ → Manage apps → Sidekick → Remove). Teams
tells Sidekick, which forgets the chat; added back by a Team Lead, it waits to be assigned again.

**Related (found in a live walkthrough):** someone added on Users & access by email who never signed in with
Microsoft is now recognised when they add Sidekick (matched by their Microsoft email, needs the directory
permission `User.Read.All` approved). If that isn't approved, or nobody matches, Sidekick says "I don't know
you in Sidekick yet…": sign in to the portal with Microsoft once, then mention @Sidekick in the chat (or add it
again).

## Microsoft 365 trial ending Nov 14, 2026

The Sidekick Labs tenant (Teams, the bot's home, the test users, one of the alert mailboxes) runs on a
Microsoft 365 Business Basic trial that turns into a paid subscription ($8.40/month + tax, 1 license) on
**Nov 15** unless cancelled. **Never turn off recurring billing on a trial: that cancels it.**

- **Keep it:** nothing to do; check the first charge on the Visa.
- **Cancel it** (before Nov 15): Teams, the test chats and the `…@SidekickLabs334.onmicrosoft.com`
  mailbox stop working. Should keep working: the Entra tenant (sign-in to Azure, the Entra app), the Azure
  subscription and the live portal. Before cancelling: turn off the bot's Teams channel and the reminders
  switch (Owner Console), make sure budget and uptime alerts also go to the outlook.com address (they do
  as of Oct 2026), and note in PROGRESS that Teams testing needs a new tenant.

## Locked out of the portal or the Owner Console

Nobody on the web can reset an Org Owner's or an owner's password (on purpose: there is no reset email to
steal). Whoever has the database can, with one command on the Mac. It sets a **one-time temporary
password**, prints it **only in your terminal**, signs that account out everywhere, clears its failed
sign-ins, and records it (the organization's Security & audit page, or the Owner Console's operator log).
The next sign-in must pick a new password before anything else works.

**Live site** (after `az login` as the Sidekick Labs account, from the repo root; `npm --prefix app ci` once):

```bash
./infra/azure/reset-password.sh you@example.com
```

- Use the email you sign in to the portal with. It prints your name, role and organization, then the
  temporary password. Paste it into the sign-in page (or your password manager) straight away; never into
  chat, email or a ticket. Then pick your own password (a password manager can make a long one).
- **Owner Console** account instead: put `--owner` in front of the email. If there's no owner account yet
  on the live site (the first one can otherwise only be made on localhost), this creates it; add
  `--name "Your name"` to set the name.
- Lost your phone **and** your backup codes (two-step sign-in)? Add `--reset-2fa` at the end: it also
  removes the account's authenticator app, passkeys and backup codes (audited). Set them up again once
  you're in. Without it, two-step sign-in stays on and is asked after the temporary password. If the
  organization has **Require two-step sign-in for everyone** on, the portal shows only **Set up two-step
  sign-in** after the new password until a method is added: that's expected, not a lockout.
- The Org Owner turned on **Require two-step sign-in for everyone** and can't set up a method right now?
  Their setup screen has **Turn the requirement off** (Org Owner only, audited). Microsoft sign-in is never
  affected by the switch.
- If your organization has **Require Microsoft sign-in** on and Microsoft sign-in is what's broken, add
  `--allow-password` at the end: it also turns that setting off (audited). Turn it back on in Settings
  once you're in.
- The live database only accepts Azure traffic, so the script lets this Mac's public IP address in for
  the run only (firewall rule `reset-password-tmp`, takes about a minute) and removes it afterwards (an exit
  trap: also when the reset fails or you press Ctrl-C). If it ever says it couldn't remove the rule, run the
  command it prints.
- **Nothing secret is printed** except the temporary password: the `database-url` secret is read into a
  variable (read from Key Vault `sidekick-kv`, so you need "Key Vault Administrator" on it) and handed only
  to the reset script, never shown or saved, and any error has the database URL and
  its password blanked out. Only the database's host name is shown, so you know which one you changed.
- The database must be running (`./infra/azure/status.sh`; if frozen, `./infra/azure/unfreeze.sh`).

**Laptop copy** (SQLite in `app/data`, or whatever `DATABASE_URL` points to):

```bash
npm --prefix app run reset-password -- you@example.com
```

Same options (`--owner`, `--name`, `--allow-password`, `--reset-2fa`). Someone else in your organization locked out? An
Org Owner or Org Admin can also just remove and re-add them on Users & access, without this script.

## Deploy skipped

A merge to `main` whose Deploy run is green but shows **Deploy skipped** (Actions → Deploy → the run → the
warning and summary) wasn't deployed on purpose: the deploy guard (HOSTING → Automatic deploys) only ships the
merge commit of a pull request merged into `main` whose last commit has a green `test` check. The message
says which case it was:

- **"wasn't made by merging a pull request"**: someone pushed straight to `main`. Check the commit is what
  you want (GitHub → Commits). Normally: revert it and send it as a pull request. If it's fine and urgent,
  deploy it by hand (below).
- **"merged without a finished, green test check"** or **"test check failed"**: the PR was merged before its
  tests passed. Look at the failing test on the PR. Fix it in a new PR (that one deploys normally), or, if
  `main` itself is fine, deploy by hand: the manual run still runs the full test suite first and refuses to
  deploy if it fails.

**Deploy by hand:** GitHub → Actions → Deploy → **Run workflow** (branch `main`). Or from the Mac:
`./infra/azure/deploy.sh`. Both deploy the current `main`.

## Connector apps (Azure DevOps, Jira, GitHub, Confluence, Microsoft 365)

Sidekick's connectors (docs/guide/connect-devops-jira.md, code in `app/src/lib/connectors.ts`) need one app
registration per tool (Jira and Confluence share one Atlassian app). **One registration serves every customer and
every group**: since Oct 24, 2026 each group connects with the account its client gave it (so two groups using Jira
sign in to two different client sites through the same Sidekick app), and the customer's Org Owner only chooses which
tool types are allowed. The apps must therefore accept accounts from any organization (multitenant / any Atlassian
site / any GitHub organization that installs the app). **Only Cody creates these** (with his own personal accounts, never a client's), and the
secrets go straight into Key Vault; they are never pasted into chat, a ticket or the repo. Until an app exists, its
tile says "Not set up yet" and nothing else changes. Use the live address for `<site>` (SIDEKICK_PUBLIC_URL).

**Azure DevOps (Microsoft Entra ID; Azure DevOps' own OAuth apps are deprecated)**
1. entra.microsoft.com (the Sidekick Labs tenant) → **App registrations → New registration**.
   - Name: `Sidekick Connectors (Azure DevOps)`.
   - Supported account types: **Accounts in any organizational directory (Multitenant)**.
   - Redirect URI: **Web**, `https://<site>/api/connectors/callback`. After creating, add a second Web redirect
     URI `http://localhost:3000/api/connectors/callback` for the laptop.
2. **API permissions → Add a permission → APIs my organization uses →** search **Azure DevOps**
   (app id `499b84ac-1321-427f-aa17-267ca6975798`) → **Delegated** → tick **vso.work** ("Work items (read)") → Add.
   Nothing else is needed (`offline_access` for the refresh token is asked for at sign-in). Optionally **Grant admin
   consent** for the Sidekick Labs tenant so your own test sign-in doesn't ask.
3. **Certificates & secrets → New client secret** (24 months). Copy the **Value** once and store it at the hidden
   prompt (it never shows on screen):
   ```bash
   read -rs "V?ado-client-secret: " && az keyvault secret set --vault-name sidekick-kv -n ado-client-secret --value "$V" -o none; unset V
   ```
   Write the expiry date into the Rotate secrets table above.
4. Point the app at it (the application (client) id is on the app's Overview page; it isn't a secret):
   ```bash
   az containerapp secret set -g sidekick-rg -n sidekick-app --secrets ado-client-secret=keyvaultref:https://sidekick-kv.vault.azure.net/secrets/ado-client-secret,identityref:system
   az containerapp update -g sidekick-rg -n sidekick-app --set-env-vars ADO_CLIENT_ID=<application id> ADO_CLIENT_SECRET=secretref:ado-client-secret -o none
   ```
   (Deploys keep these: they only change the image and the release settings.) For the laptop, put the same two
   lines in `app/.env.local` (`ADO_CLIENT_ID=…`, `ADO_CLIENT_SECRET=…`).
5. Check: make a free Azure DevOps organization with your personal Microsoft work account (dev.azure.com, connected
   to the Sidekick Labs tenant: Organization settings → Microsoft Entra), add a project with two made-up work items,
   then on the live portal **Connectors → Azure DevOps**, type its name, Connect, link the project to a test group
   and ask about one item. A customer's Azure DevOps organization must be connected to their own Entra tenant, and
   their IT may need to approve the app once (admin consent).

**Jira Cloud (Atlassian OAuth 2.0, "3LO")**
1. developer.atlassian.com → **Console → My apps → Create → OAuth 2.0 integration**. Name: `Sidekick` (the working
   name), with your personal Atlassian account.
2. **Permissions → Jira API → Add → Configure → Edit scopes (Classic)**: tick **read:jira-work** and
   **read:jira-user**. Nothing that writes.
3. **Authorization → OAuth 2.0 (3LO) → Configure**: callback URL `https://<site>/api/connectors/callback`. For the
   laptop, make a second app ("Sidekick dev") with `http://localhost:3000/api/connectors/callback`.
4. **Distribution → Edit → Sharing** (otherwise only you can connect): vendor "Sidekick (working name)", privacy
   policy `https://<site>/privacy`, and answer the personal-data questions: the app **stores personal data**
   (names of assignees and comment authors, as part of work items) and supports Atlassian's personal data
   reporting by deleting everything on disconnect. Save.
5. **Settings**: copy the **Client ID** (not secret) and the **Secret** (store it at the hidden prompt):
   ```bash
   read -rs "V?jira-client-secret: " && az keyvault secret set --vault-name sidekick-kv -n jira-client-secret --value "$V" -o none; unset V
   az containerapp secret set -g sidekick-rg -n sidekick-app --secrets jira-client-secret=keyvaultref:https://sidekick-kv.vault.azure.net/secrets/jira-client-secret,identityref:system
   az containerapp update -g sidekick-rg -n sidekick-app --set-env-vars JIRA_CLIENT_ID=<client id> JIRA_CLIENT_SECRET=secretref:jira-client-secret -o none
   ```
6. Check: a free Jira Cloud site on your personal Atlassian account with one made-up project, then Connect on the
   live Connectors page, link the project, ask about an issue.

**Confluence Cloud (the same Atlassian app as Jira)**
1. developer.atlassian.com → **My apps → Sidekick → Permissions → Confluence API → Add → Configure → Edit scopes
   (Classic)**: tick **read:confluence-content.all**, **read:confluence-space.summary** and **search:confluence**.
   Nothing that writes. Existing Jira connections are unaffected (each tool's sign-in asks only for its own scopes).
   Do the same on the "Sidekick dev" app for the laptop.
2. **Distribution**: add to the personal-data answer that page authors' names are stored (as part of pages).
3. Nothing to set on the Container App: Confluence uses `JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET`. (Only if it ever
   needs its own app: store `confluence-client-secret` like the Jira one and set `CONFLUENCE_CLIENT_ID` +
   `CONFLUENCE_CLIENT_SECRET=secretref:confluence-client-secret`.)
4. Check: add Confluence to your free Atlassian site (same personal account), make a space with two made-up pages,
   then on the live portal **Connectors → Confluence**, Connect, link the space to a test group and ask about a page
   (the answer cites "Confluence page: …" with an Open in Confluence link).

**GitHub Issues (a GitHub App, read-only)**
A GitHub App (not an "OAuth app", whose scopes can't be read-only for private repositories) with read-only
permissions; Sidekick only uses the signed-in person's user token, never the app's private key.
1. github.com (your personal account) → **Settings → Developer settings → GitHub Apps → New GitHub App**.
   - Name: `Sidekick connector` (must be unique on GitHub; add a suffix if taken). Homepage: `https://<site>`.
   - **Callback URL**: `https://<site>/api/connectors/callback`; **Add callback URL**: `http://localhost:3000/api/connectors/callback`.
   - Keep **Expire user authorization tokens** ticked (8-hour tokens with refresh). Leave "Request user
     authorization during installation" and "Device flow" off.
   - **Webhook**: untick **Active** (Sidekick polls every 15 minutes; no webhook needed).
   - **Repository permissions**: **Issues: Read-only**, **Pull requests: Read-only**, **Metadata: Read-only**
     (required). Nothing else, no account or organization permissions.
   - **Where can this GitHub App be installed?** **Any account**. Create.
2. On the app's page copy the **Client ID** (`Iv23…`, not a secret), then **Generate a new client secret** and store it
   at the hidden prompt (no private key is needed):
   ```bash
   read -rs "V?github-client-secret: " && az keyvault secret set --vault-name sidekick-kv -n github-client-secret --value "$V" -o none; unset V
   az containerapp secret set -g sidekick-rg -n sidekick-app --secrets github-client-secret=keyvaultref:https://sidekick-kv.vault.azure.net/secrets/github-client-secret,identityref:system
   az containerapp update -g sidekick-rg -n sidekick-app --set-env-vars GITHUB_CLIENT_ID=<client id> GITHUB_CLIENT_SECRET=secretref:github-client-secret -o none
   ```
   For the laptop, the same two lines in `app/.env.local`.
3. **Customers install it** on their GitHub organization (github.com/apps/<app name> → Install → pick repositories);
   only those repositories can be linked. The guide (docs/guide/connect-devops-jira.md) tells them.
4. Check: a made-up private repository on your personal account with two issues and a pull request, install the app
   on it, then Connect on the live Connectors page, link the repository and ask about an issue.

**Microsoft 365 files (SharePoint libraries, OneDrive shared folders; Microsoft Entra ID, delegated, read-only)**
One Entra app with **delegated** Microsoft Graph permissions only (Sidekick reads as the person who connected, so it
can never see more than they can, and never writes). Do these steps yourself in the Entra admin center; nothing in
Azure or Entra is changed by Claude or by the app.
1. entra.microsoft.com (the Sidekick Labs tenant) → **App registrations → New registration**.
   - Name: `Sidekick Connectors (Microsoft 365)`. (Reusing the Microsoft sign-in app also works, but a separate app
     keeps the portal sign-in's consent screen short.)
   - Supported account types: **Accounts in any organizational directory (Multitenant)**.
   - Redirect URI: **Web**, `https://<site>/api/connectors/callback`; then add `http://localhost:3000/api/connectors/callback`.
2. **API permissions → Add a permission → Microsoft Graph → Delegated permissions** → tick **Sites.Read.All**,
   **Files.Read.All** and **User.Read** (User.Read is usually there already). `offline_access` is asked for at
   sign-in. Nothing with "Write" or "Manage", no Application permissions.
3. **Admin consent**: `Sites.Read.All` needs a Microsoft admin's approval once per customer organization. For the
   Sidekick Labs tenant, press **Grant admin consent for Sidekick Labs** here (you are its admin). A customer's
   admin approves when they first connect (Microsoft shows them the consent screen), or ahead of time with
   `https://login.microsoftonline.com/<their tenant id>/adminconsent?client_id=<application id>`. The guide
   (docs/guide/connect-devops-jira.md → Microsoft 365) tells them; Sidekick never asks for an admin's password.
4. **Certificates & secrets → New client secret** (24 months). Store the **Value** at the hidden prompt:
   ```bash
   read -rs "V?m365-client-secret: " && az keyvault secret set --vault-name sidekick-kv -n m365-client-secret --value "$V" -o none; unset V
   az containerapp secret set -g sidekick-rg -n sidekick-app --secrets m365-client-secret=keyvaultref:https://sidekick-kv.vault.azure.net/secrets/m365-client-secret,identityref:system
   az containerapp update -g sidekick-rg -n sidekick-app --set-env-vars M365_CLIENT_ID=<application id> M365_CLIENT_SECRET=secretref:m365-client-secret -o none
   ```
   Write the expiry date into the Rotate secrets table above. For the laptop, the same two lines in `app/.env.local`.
   Until both are set, the SharePoint and OneDrive tiles say "Not set up yet".
5. Check (made-up data only): in the Sidekick Labs Microsoft 365 trial, make a SharePoint site "Sidekick test" with
   a folder holding a made-up Word file and PDF, then on the live portal **Connectors → Microsoft 365 files**,
   allow it (Org Owner), then **Connect Microsoft 365 files for a group** with your Sidekick Labs account, link the
   folder and ask about a file (the answer cites "SharePoint file: …" with an Open in SharePoint link). Any Microsoft
   work account can connect a group (normally one the client provides, in the client's own tenant); it doesn't
   have to be the tenant the Sidekick organization linked for sign-in.

Costs: none from Microsoft, Atlassian or GitHub for these apps. Each sync is a few API calls per linked project every 15
minutes (no AI calls; items only cost AI when someone asks).

## Connector problems

What the customer sees on **Connectors** and what to do (the group's Team Lead, or an Org Owner/Admin of theirs,
does the fixing; you only help). Connections are per group: one group's problem never affects another's.
- **Sign-in expired**: their refresh was refused (the person who connected left, their password/MFA changed in a
  way that revoked tokens, the client removed the account or the app, or 90 days without any sync). The group's Team
  Lead presses **Reconnect** and signs in again with the client's account. Nothing was deleted. After the Oct 24,
  2026 move to per-group connections, a group that shared an organization-wide connection with another group shows
  "Connections are per group now: sign in again for this group" once: same fix.
- **"refused access to the project …"**: the connected account lost access to that project. Reconnect with an
  account that can open it, or unlink the project.
- **"couldn't find …"**: the project or organization was renamed or deleted. Unlink it and link the new one.
- **"busy or unavailable"**, **"asked Sidekick to slow down (rate limit)"** or **"couldn't reach"**: the tool was
  down or rate limiting (GitHub allows 5,000 calls an hour per signed-in person; Microsoft Graph throttles per
  tenant and app); it carries on from where it stopped on the next sync by itself. If every customer shows it,
  check the tool's status page.
- **"isn't allowed in your organization yet"** when connecting: their Org Owner hasn't allowed that tool type
  (Connectors → the tool's switch), or switched it off. A Team Lead can press **Request**.
- **Microsoft 365: "need admin approval" when connecting** (`consent_required` / `access_denied`): their Microsoft
  admin hasn't approved Sidekick reading SharePoint (Sites.Read.All). The admin connects once themselves, or uses
  the admin consent link above (for a client's tenant, the client's admin).
- **Microsoft 365: "N not read"** on a linked folder: files over 25 MB (or password-protected / damaged ones) are
  kept as a note with a link, not read. Expected; they can save a smaller copy. Spreadsheets, images and videos are
  ignored on purpose.
- **GitHub: no repositories to pick**: the GitHub App isn't installed on their organization (or not on that
  repository). Someone who owns their GitHub organization installs it (github.com/apps/<app name>).
- **Every connection of one tool fails right after a change on our side**: the app secret expired or was rotated
  wrongly ("didn't confirm the sign-in" on connect). Rotate it (Rotate secrets above) and restart.
- Customers also get a **Needs attention** finding ("Connector not working") from the broken-connector watcher. To
  see every broken connector across clients: `connectorProblems()` in `app/src/lib/connectors.ts`; the syncs run as
  `connector.sync` jobs (Owner Console → Job queue).

## Scaling up (the plan in docs/HOSTING.md → Scaling up)
Each step costs money: only with Cody's go-ahead. Do them in order and watch for a day after each one
(Owner Console → Performance and Job queue; Azure Monitor CPU and connections). Signs it's time are in
the HOSTING table; the load test numbers behind them are in docs/SCALE.md.

**1. Search to Basic.** Azure portal → AI Search → create `sidekick-search-basic` (Basic, same region as
the database) → copy its admin key into Key Vault `sidekick-kv` as `azure-search-api-key`, set
`AZURE_SEARCH_ENDPOINT` on the Container App to the new address, restart. The new index is empty, so
the first question after the restart starts copying every passage into it (`reindexAzure` in
`app/src/lib/search.ts`, a few sources at a time; embeddings cost about $0.02 per million words, so
cents today and roughly $50–60 once at 10,000 busy groups). Answers keep working meanwhile. Delete the
Free service a week later.

**2. Database to B2s (later D2ds_v5).** Portal → `sidekick-labs-db` → Compute + storage → pick the size →
Save. It restarts (a minute or two of "very busy" errors), so do it in the evening. Afterwards set the
server parameter `max_connections` to the new size's default (a resize doesn't change it), and
`DATABASE_POOL_MAX=20` on the Container App. Storage only grows, never shrinks: keep 32 GB until 80% full.

**3. Several app copies with auto-scaling.** Container App → Scale → min replicas 2, max 4, rule "HTTP
scaling, 50 concurrent requests". Resources → 1 vCPU / 2 GiB. Check: copies × `DATABASE_POOL_MAX` stays
under the database's connections (B1ms: 35), and 24 × copies Claude calls at once fits the Anthropic
limits. Nothing else changes: the job queue and the heartbeat already run safely on every copy. Sessions
live in the database, so people stay signed in whichever copy answers.

**4. Scale to zero (only if wanted).** Set `SIDEKICK_SCHEDULER=off` and `SIDEKICK_TICK_SECRET`, and create
the Container Apps job from docs/HOSTING.md → Scheduled work. Without it, nothing runs the reminders
and watchers while no copy is up.

**Undo.** Each step can be reversed in the same place (the database can go down a size; search back to
Free only if the passages fit, which they won't after real use).

## Slow pages or "AI is very busy"
1. Owner Console → **Performance**: which requests are slow, and is it database time or AI time?
   Activity traces show `db_ms` per request and `queued_ms` on AI steps (time spent waiting for a turn).
2. Database time high: set `SIDEKICK_SLOW_QUERY_MS=300` on the Container App for a day; the log then shows
   the slow queries (SQL only, never values). Fix with an index (both schemas: `app/src/lib/db.ts` and
   `app/db/schema.postgres.sql`) or step 2 of Scaling up.
3. AI steps waiting (`queued_ms` in the seconds) for one company only: that company is at its
   per-company limit (`SIDEKICK_CLAUDE_ORG_CONCURRENCY`, 6): expected, and it protects everyone else. For
   every company: the per-copy limit (`SIDEKICK_CLAUDE_CONCURRENCY`) or Anthropic's own rate limit; check
   the Anthropic Console's usage page before raising the setting.
4. Job queue behind (Owner Console → Job queue, oldest wait over 15 minutes): add copies (step 3) or raise
   `SIDEKICK_JOB_CONCURRENCY` to 8.
