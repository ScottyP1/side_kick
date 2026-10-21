# Going multi-tenant: Cody's checklist

The code for serving **many customer companies** is ready (chat picker, directory import, `@Sidekick add`,
unknown-company card, per-tenant sign-in checks). It stays **off** until the switches below are made, so the
live site keeps working exactly as today (single tenant, Sidekick Labs). Everything here is done by Cody in
Azure, Entra, Teams admin and Partner Center; nothing in the repo changes these.

💲 = costs money. Everything else is free.

## How it fits together (why these steps)
- **Azure Bot stays single-tenant.** Since July 31, 2025 Microsoft no longer creates multi-tenant Azure Bots
  (existing ones keep working). A single-tenant bot can still serve other companies once the Teams app is
  **published in the Teams Store**: Sidekick's bot keeps its home tenant (Sidekick Labs) for its own tokens,
  and Teams delivers chats from every tenant that installed it. Before the Store listing is live, other
  tenants generally can't use it (custom uploads in another tenant aren't a supported route for a
  single-tenant bot), so customer testing waits for the Store, or uses guest accounts in Sidekick Labs.
- **A second Entra app for sign-in and the directory.** Microsoft sign-in for other companies, and reading
  their directory (Graph `User.Read.All`), need an app registration set to *multiple organizations*. Keep the
  bot's app ("Sidekick Bot") as it is, and create a new one ("Sidekick") for this. The code already reads it
  from `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`.
- **The switch** is one setting: `SIDEKICK_MULTI_TENANT=1` (with `TENANT_ID` left as Sidekick Labs' tenant).
  Turning it off again puts everything back (see Rollback).

## Steps, in order

### 1. New multi-tenant Entra app for sign-in + directory (Entra admin center, free)
1. Entra admin center → App registrations → **New registration**: name **Sidekick**, supported account types
   **Accounts in any organizational directory (multitenant)**. Not "personal Microsoft accounts".
2. **Redirect URI** (Web): `https://<live address>/api/auth/microsoft/callback`. Add the custom domain's one
   too once step 5 is done. (The admin-approval round trip comes back to this same address.)
3. **Certificates & secrets** → new client secret (note its expiry, e.g. 180 days; put a reminder in your
   calendar). Copy it straight into Azure (step 4), never into chat or the repo.
4. **API permissions** → Microsoft Graph:
   - Delegated: `openid`, `profile`, `email`, `User.Read` (sign-in).
   - Application: **`User.Read.All`** (directory search for import and `@Sidekick add`).
   - Application: **`TeamsAppInstallation.ReadWriteSelfForChat.All`** and
     **`TeamsAppInstallation.ReadWriteSelfForTeam.All`** (Sidekick removes *itself* from a chat or team: when
     someone other than a Team Lead/admin adds it, when a chat isn't assigned within 7 days, or "Remove
     Sidekick from this chat" in the portal). "Self" only covers the Teams app whose manifest names this Entra
     app in `webApplicationInfo`, which the package does automatically when `ENTRA_CLIENT_ID` is set (step 4).
     **To verify on the first real try**: that Graph accepts this app as "self" for Sidekick's Teams app; if not,
     the same code works with the broader `TeamsAppInstallation.ReadWriteForChat.All` /
     `ReadWriteForTeam.All` instead (only the permission in Entra changes).
   - Press **Grant admin consent for Sidekick Labs** (so it works in your own tenant). Each customer's admin
     approves it in their own tenant from Sidekick (Users & access → Approve Sidekick for your organization).
5. **Branding & properties**: name, logo, publisher domain (step 6), home page, privacy and terms URLs
   (`/privacy`, `/terms` on the site). Customers see these on Microsoft's approval screen.

### 2. Keep the bot as it is (Azure portal, free)
- `sidekick-bot-dev` (Azure Bot, Free tier, single tenant) and its app "Sidekick Bot" stay unchanged:
  `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` on the Container App stay the same.
- Only if Microsoft refuses the Store submission for a single-tenant bot: create a **new** Azure Bot resource
  (the bot type can't be changed on an existing resource) with a *User-assigned managed identity*, point it
  at the same messaging endpoint, and change `CLIENT_ID` + the manifest's bot id. That makes it a new app in
  Teams: every chat re-adds Sidekick. Avoid unless needed.

### 3. Teams admin center: chat RSC setting and who may add Sidekick (free)
**Recommended setup (Cody's rule: only Team Leads and admins add Sidekick to chats):** Teams admin center →
Teams apps → **Permission policies** → a policy that allows Sidekick, assigned only to Team Leads and admins;
everyone else's policy blocks it. Sidekick also checks it itself (it leaves if someone else adds it), but the
policy stops the "Sidekick joined and left" noise. Customers get the same advice in the admin guide.

Sidekick Labs, and later each customer (documented in the admin guide):
Teams admin center → Teams apps → **Manage apps → Actions → Org-wide app settings** →
**Resource-specific consent**: allow it for **chats** as well as teams. Then remove and re-add Sidekick in a
group chat so the read permission is granted. (This is the suspected cause of "plain group-chat messages
not delivered", see PROGRESS.)

### 4. Switch the live app (Azure Container App settings, free)
1. Add `ENTRA_CLIENT_ID` (the new app's id) and `ENTRA_CLIENT_SECRET` (as a **secret**, `secretref:`).
2. Add `SIDEKICK_MULTI_TENANT=1`. Leave `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET` as they are. Don't set
   `ENTRA_TENANT` (multi-tenant mode uses "organizations").
3. New revision starts. Check: `/api/health` OK; sign in with Microsoft as Cody (Sidekick Labs is already
   connected, so nothing changes for you); `@Sidekick help` in the test chat still answers.
4. Settings → Microsoft sign-in stays connected; on Users & access → Import from Microsoft 365, approve
   Sidekick once (it opens Microsoft's page for Sidekick Labs), then try a search.

### 5. Custom domain (💲 domain ~$10–20/year; Azure managed certificate is free)
1. Buy a domain (e.g. `getsidekick.example`) at any registrar.
2. Container App → Custom domains → add it (CNAME + TXT records at the registrar), **managed certificate**.
3. Set `SIDEKICK_PUBLIC_URL` to `https://<domain>` (links in Teams cards, sign-in redirect).
4. Add the new redirect URI to the **Sidekick** Entra app (step 1.2) and, if you use it, the bot's app.
5. Azure Bot → Configuration → messaging endpoint `https://<domain>/api/messages`.
6. Build the package with `SIDEKICK_LIVE_URL=https://<domain> SIDEKICK_WEBSITE_URL=https://<domain> npm --prefix app run teams:package`
   (with `ENTRA_CLIENT_ID` in `app/.env.local`, so `webApplicationInfo` names the multi-tenant app; see step 1.4).

### 6. Partner Center + publisher verification (free account; verification needs the domain from step 5)
1. Create a **Microsoft AI Cloud Partner Program** account (Partner Center), company type matching how
   you'll sell (check the employment-agreement question with the lawyer first, see PROGRESS → Open items).
   Free; needs a work email on your domain and business verification (can take days).
2. Entra → the **Sidekick** app → Branding & properties → **Publisher verification**: enter the Partner
   One/MPN id → the app shows as *verified*. Customers' admins can only approve unverified multi-tenant apps
   if their tenant allows it, so this matters.
3. Teams Developer Portal: link the app to the Partner Center account (Publish → Publish to store).

### 7. Teams Store submission (free; Microsoft validation takes days to weeks)
Microsoft's requirements (Teams Store validation guidelines), with what Sidekick has:
- [ ] Manifest 1.3.0 package built for the custom domain (step 5.6); passes **Developer Portal → App
      validation** with no errors.
- [ ] **Privacy policy** (`/privacy`), **terms of use** (`/terms`), **support** (`/support`) and website URLs
      on your domain, live and specific to Sidekick (the sign-up session builds these pages).
- [ ] Short and long description, accurate (no "AI teammate that does everything"; say what data it reads).
- [ ] Icons: 192×192 colour and 32×32 transparent outline (`teams/color.png`, `teams/outline.png`).
- [ ] **Screenshots** (1–5, 1366×768): an answer card with sources, meeting notes card, reminder card,
      Workspaces → Waiting to be assigned, Users & access → Import. Made-up sample data only.
- [ ] **Test notes + test account** for Microsoft's reviewers: a Sidekick org they can sign in to, a test
      M365 tenant setup or instructions, and steps ("add Sidekick to a group chat, assign it on Workspaces,
      ask `@Sidekick when is the cutover?`"). They need a working, populated environment.
- [ ] Responsible-AI / generative-AI answers in the submission: guardrails, sources, "I don't know",
      reporting inappropriate content (say how: support URL), no training on customer data.
- [ ] Bot responds within a few seconds to every command, has `help`, and handles the welcome on install
      (the waiting/sign-up cards).
- [ ] Optional later: Microsoft 365 Certification / Publisher attestation (questionnaire, free; certification
      by an assessor 💲 thousands of dollars, only if big customers ask).

### 8. After the Store listing is live
- Install from the Store in Sidekick Labs, remove the old custom upload (Manage apps) so there's one Sidekick.
- Walk a fake customer through it end to end with a second test tenant (💲 another M365 Business Basic trial
  is free for a month, then ~$8.40/user/month: cancel before it bills): sign up → connect Microsoft →
  approve → add Sidekick to a chat → assign → `@Sidekick add` → import from directory.

## Rollback
- Remove `SIDEKICK_MULTI_TENANT` (or set it to 0) on the Container App → new revision. Sidekick is back to
  single-tenant: only Sidekick Labs, link codes and waiting chats for Sidekick Labs as before. Customer orgs'
  data stays in the database but their Teams chats get no answers and their people can't sign in with
  Microsoft (the single-tenant sign-in refuses other tenants).
- Remove `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` to go back to the bot's app for sign-in.
- A Store listing can be hidden/unpublished in Partner Center; customers' installed copies keep the app id.
- Nothing in the database needs undoing: the new columns (`added_by`, `added_by_oid`, `graph_consent_at`)
  are unused in single-tenant mode.

## What each setting means (reference)
| Setting | Single-tenant (today) | Multi-tenant |
|---|---|---|
| `TENANT_ID` | Sidekick Labs' tenant | Sidekick Labs' tenant (the bot's home) |
| `SIDEKICK_MULTI_TENANT` | unset | `1` |
| `CLIENT_ID` / `CLIENT_SECRET` | bot app, also used for sign-in | bot app only |
| `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` | unset | the multi-tenant **Sidekick** app |
| `ENTRA_TENANT` | unset | unset ("organizations" is used) |
| `SIDEKICK_PUBLIC_URL` | Azure address | custom domain |
