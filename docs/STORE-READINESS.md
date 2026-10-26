# Teams Store / AppSource readiness

> Last updated October 25, 2026. Everything up to the **Submit** button in Partner Center. Nothing has been submitted:
> that needs Cody's Partner Center account and the decisions in [What Cody does in Partner Center](#what-cody-does-in-partner-center).

Sidekick is a **bot** (personal, group chat, team), a **personal static tab** ("Meetings") and a **configurable tab**
(chat, channel, meeting chat, meeting details, meeting side panel) with **Teams SSO**, **resource-specific consent**
(RSC: `ChatMessage.Read.Chat`, `ChannelMessage.Read.Group`) and **Microsoft Graph application permissions**
(lib/graph-permissions.ts). The rules below are the ones from Microsoft Learn that apply to that mix:

- [Teams Store validation guidelines](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/appsource/prepare/teams-store-validation-guidelines) (read October 25, 2026)
- [Prepare for Teams Store submission](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/appsource/prepare/submission-checklist) (page dated August 2026)
- Microsoft's [Teams app validation tool](https://dev.teams.microsoft.com/tools/store-validation) runs the same automated checks; upload the live package there before submitting.

Columns: **Status** is ✅ pass, 🔧 fixed in this change, ⚠️ open (code), 👤 Cody (account, money or decision).
"MF" = Microsoft marks it *Must fix*, "GF" = *Good to fix*.

## How to check the package

```bash
npm --prefix app run teams:package
```

builds `teams/build/sidekick-teams-live.zip` and now refuses to build a package that fails Microsoft's JSON schema
(kept offline in `teams/schema/`) or the Store rules a schema can't express (`validateManifest` in
`app/scripts/teams-manifest.mjs`: https links, valid domains without protocols, wildcards or tunnels, no Microsoft
product names in the name, semantic version, bot commands). The test suite runs the same check on the template
(`tests/db.test.mjs` → "Teams Store").

## Checklist

### Manifest and package

| Rule | Status | Notes |
|---|---|---|
| Public schema, 1.25+ with `supportsChannelFeatures: "tier1"` for channel apps (MF, July 2026) | ✅ | v1.30, `tier1`. |
| SemVer version, bumped for every change (MF) | 🔧 | 1.6.0 → **1.7.0** (new descriptions, welcome and help changes). |
| Bot id matches the published one; app id = bot id (MF) | ✅ | `{{BOT_ID}}` from `CLIENT_ID`. Never change it after the first listing. |
| `webApplicationInfo` for SSO and admin consent (MF) | ✅ | `ENTRA_CLIENT_ID` app; resource `api://<host>/<id>`. |
| No extra files in the zip (MF) | ✅ | manifest.json, color.png, outline.png only. |
| Color icon 192×192 PNG, solid or transparent background (MF) | ✅ | Checked by the test (PNG header). Solid Indigo background. |
| Outline icon 32×32, white on transparent (MF) | ✅ | Only white pixels plus transparency. |
| Name: no Microsoft product names, no "Beta/Dev/Preview", doesn't lead with a Teams feature (MF) | ✅ | Checked by `validateManifest`. |
| Name: generic nouns should carry the developer name ("Contoso Tasks") (MF) | 👤 | "Sidekick" is a working name, and an unrelated Store app "Sydekick" exists. Pick the real brand first (lib/brand.ts). |
| Full name avoids "Teams" as a word | 👤 | Full name is "Sidekick: AI teammate for client teams" (BRAND.tagline). A reviewer may read "teams" as the product name; consider a tagline without it. |
| Short description: one sentence, no "app", ≤80 chars (MF/GF) | ✅ | 67 characters. Checked. |
| Long description: audience, value, prerequisites, admin dependencies, limitations; "Microsoft Teams" first, ≤4,000 chars and <500 words (MF) | 🔧 | Rewritten (1,377 characters, 241 words): sign-up and one-time admin approval first, transcription needed for notes, only Team Leads/admins add it, AI disclosure, no training. |
| `privacyUrl` / `termsOfUseUrl` on the website, https, no sign-in, same as in Partner Center (MF) | ✅ | `{{WEBSITE_URL}}/privacy` and `/terms`, public pages. |
| Privacy and terms hosted on **your own domain**, not a staging or beta address (MF) | 👤 | Today the website is the Azure container address. Needs the real domain, then `SIDEKICK_WEBSITE_URL`. |
| `validDomains`: only domains you control; no protocol, `www`, wildcards, tunnels or Microsoft domains (MF) | ✅ / 👤 | Checked by `validateManifest`. The live package's app host is `*.azurecontainerapps.io` (not forbidden, but not "a domain you control"): use the custom domain for the app too. |
| `token.botframework.com` only if the bot uses OAuthCard | ✅ | Not used (Teams SSO in the tab, no bot sign-in card). |
| Scopes and contexts declared are all visible in the app (MF) | ✅ | Bot in personal/team/group chat; tab in personal, chat, channel and meeting contexts. |
| Microsoft Cloud Partner Program ID in `developer.mpnId` (GF) | 👤 | Add once Cody has a partner account. |

### Bot

| Rule | Status | Notes |
|---|---|---|
| Commands have title + description, no duplicates, no leading "/", list scopes = bot scopes (MF) | ✅ | Checked by `validateManifest`. 7 commands. |
| At least 3 prompt starters, all working (GF/MF) | ✅ | The 7 commands are the prompt starters; each has a handler in `lib/teams/bot.ts`. |
| Every input gets a valid reply, including "hi", "help" and nonsense; never a dead end (MF) | ✅ / 🔧 | Anything that isn't a command is answered as a question (or "I don't know" + logged gap). Unlinked chats now say what has to happen next, and every first-run card links the help center (a **Help center (opens in browser)** button; the action-free "not set up yet" card has the address in its text). |
| Help answers inside Teams, doesn't only redirect out (MF) | ✅ | `@Sidekick help` → help card with all commands. |
| Welcome message: once on install, not on every command or on help (MF) | ✅ | Sent only from `install.add`; `help` sends the help card without the greeting. |
| Welcome states the app name, value, setup steps and a command summary; calls out admin dependencies and limitations (MF) | 🔧 | `helpCard`/`linkCard`/`notSetUpCard` with `installer`: greeting, what Sidekick does, the AI note, setup and admin dependency note (`SETUP_NOTE`), "mention me with help". |
| Group chat / channel welcome mentions the installer, no individual DMs to members (MF) | 🔧 | Real @mention (`msteams.entities`) of the person who added it; one message in the chat. |
| No AppSource links, no redirects to other Teams apps (MF) | ✅ | |
| Not spammy: one post with threaded replies, reminders rate-limited (MF) | ✅ | Notes post once (action items in the thread in channels); reminders on schedule; transcription reminder max one per chat per 30 min. |
| Replies within 2 s or show typing (MF) | ✅ | Typing indicator first, answer sent after (`after()`). |
| Graceful error messages (MF) | ✅ | Paused org, too-long question, unknown tenant, wrong org all get plain replies. |
| Links that leave Teams say so (MF) | 🔧 | "Open in Sidekick" (portal) and the new "Help center (opens in browser)". |
| Responsive cards on mobile (MF) | ✅ | Adaptive Cards 1.5, wrapping text, no fixed widths. Check on a phone during the screenshot capture. |
| User attribution on messages triggered by a user (MF) | ✅ | Cards name who assigned, closed or saved ("Saved by …", "Turned on by …"). |
| `isNotificationOnly: false` because it answers (MF) | ✅ | |

### Tabs (personal, configurable, meeting)

| Rule | Status | Notes |
|---|---|---|
| Loading message within 2 s (MF) | ✅ | "Connecting to Teams…" straight away. |
| No dead ends; error screen with a way forward when loading fails (MF) | 🔧 | Error state now has **Try again**, **Help (opens in browser)** and the support address. |
| Empty states explain what to do (MF) | 🔧 | "Not in any group yet" says who adds you and what then shows; no meetings / no action items explained. |
| Fully responsive on Android and iOS, no horizontal scroll, no truncation (MF) | ✅ / 🔧 | Single column, wrapping rows; long words now wrap (`overflowWrap: anywhere`). Recheck on a phone at capture. |
| Back navigation on L2 pages (MF) | ✅ | "← All meetings" on a meeting's notes. |
| Navigation doesn't fight Teams' (no icon-only rails) (MF) | ✅ | A group picker and two text tabs. |
| Collaborative tab shows a team view, not "My dashboard" (MF) | ✅ | The group's meetings and open action items. |
| Config page explains value and setup, links contact info (MF) | 🔧 | Added what's needed first, help-center link and support email. |
| Teams theme (GF); **dark only in meetings** (MF) | 🔧 | `app/src/app/teams/teams-theme.ts` follows Teams' theme and switches; side panel and meeting stage are always dark. |
| In-meeting tab: responsive, one close button, back button, no horizontal scroll (MF) | ✅ | Same page; no own close button. |
| Clear sign-in / sign-out; sign-out only leaves the app (MF) | ✅ | Teams SSO is silent (no sign-in screen, nothing to sign out of in the tab). The portal has its own Sign out. |
| Way forward for new users / sign-up (MF) | ✅ / ⚠️ | Unknown organizations get "sign up first" with the website address. See the mobile pricing row. |
| **No pricing, plans or upgrade links on mobile** (MF) | ⚠️ | The tab itself shows none. But the "sign up" card and "Open in Sidekick" lead to the website/portal, whose header links Pricing and whose Usage & billing page shows plans. Before submitting: a sign-up landing page without prices (or hide pricing on phones), or list Sidekick as free in the Store and sell outside it. Needs Cody's pricing decision. |
| Graceful message on unsupported browsers/OS (MF) | ✅ | Outside Teams: "This page works inside Microsoft Teams" with a portal link. |

### AI-generated content

| Rule | Status | Notes |
|---|---|---|
| Describe AI before purchase (MF) | 🔧 | Long description, website, privacy policy. |
| Visible disclaimer where people use AI output (MF) | 🔧 | Welcome/help cards (`AI_NOTE`), "AI-generated: check the sources" on every answer card. |
| Report mechanism, acted on in time (MF) | ✅ / 👤 | 👎 on every answer (counts only) and "report it to support" in the cards, privacy and terms. **The support address must be a real, watched mailbox** (`BRAND.supportEmail` is a placeholder). |
| No harmful output; safeguards against prompt injection (MF) | ✅ | lib/guardrails.ts: locked floor, jailbreak checks before, `cleanOutput`/`checkGrounding` after, fixed refusal wording. |

### Policies, support and publisher

| Rule | Status | Notes |
|---|---|---|
| Privacy policy covers storage, retention, deletion, security, contact (MF) | 🔧 | Rewritten from the code: lib/rolloff-policy.ts, lib/retention.ts, lib/graph-permissions.ts (every permission and why), transcripts, row-level security, AI use, guardrails. **Draft: needs legal review.** |
| Terms specific to the offering (MF) | 🔧 | Rewritten: Teams/Microsoft 365 dependency, your content, AI can be wrong, acceptable use, ending. **Draft: needs legal review** (the "Responsibility" section is placeholder wording). |
| Sub-processor list | 🔧 | New public page `/privacy/subprocessors` (lib/subprocessors.ts): Microsoft Azure, Anthropic, Microsoft Graph/Teams. Linked from the privacy policy, footer and help center. |
| Support URL without sign-in, with contact details (MF) | ✅ / 👤 | `/support` is public. Needs the real mailbox. |
| No ads (MF) | ✅ | |
| Publisher Verification on the Entra app (MF) | 👤 | Partner Center account → verify the publisher on the multi-tenant Entra app (`ENTRA_CLIENT_ID`), with a verified domain. |
| Publisher Attestation (required; only possible after the first listing) | 👤 | Self-assessment of security and data handling after listing. The privacy policy and docs/security/ are the source for the answers. |
| Works in Standard, Shared and Private channels, differences documented (MF, July 2026) | 👤 | Not tested in shared/private channels yet. Test with the Sidekick Labs tenant before submitting; document any difference in the long description. |
| Multi-tenant: any company can install (needed for the Store) | 👤 | Code is ready, off on the live site (`SIDEKICK_MULTI_TENANT=1`, docs/TEAMS-MULTITENANT.md). |

## Store listing copy

**Short name**: Sidekick (working name; from lib/brand.ts)

**Short description** (67 characters, manifest `description.short`):
> Answers from your workspace's documents and meetings, with sources.

**Long description** (the manifest's `description.full`; paste the same text into Partner Center):
> Sidekick is an AI teammate built for Microsoft Teams, for firms that run client work in Teams group chats, channels and meetings. Mention @Sidekick with a question and it answers from the client group's own documents, meeting notes and chats, with the sources it used. After each Teams meeting it writes the notes from the transcript and posts the decisions and action items to the group's chat, where people assign or close them and save decisions to the group's knowledge. In chats an admin chooses to track, it keeps track of decisions and dates and posts reminders about what's still open. The Sidekick tab, in the app bar or added to a chat, channel or meeting, shows the group's meetings, notes and open action items. Each client group is walled off: people only see the groups they belong to. Before you install: your organization needs a Sidekick account (sign up on the Sidekick website), and a Microsoft 365 admin approves Sidekick once. Meeting notes need transcription turned on in Teams. Only a Team Lead or admin can add Sidekick to a chat and assign it to a group; until then it reads and keeps nothing there. Answers and notes are written by AI (Claude, by Anthropic) and can be wrong, so check the sources; your content is not used to train AI models. Report a bad answer with the thumbs-down button. Help, privacy policy and terms are on the Sidekick website.

**Feature bullets** (Partner Center "summary"/highlights; up to three benefits recommended):
- **Answers with sources, in the chat.** Ask @Sidekick in a group chat or channel and get an answer from that client's own documents, meetings and chats, with every source cited.
- **Meeting notes you don't have to write.** After each Teams meeting, the decisions and action items land in the group's chat, ready to assign, close or save.
- **One walled-off group per client.** Each engagement's knowledge stays with its team, enforced down to the database, with guardrails and an audit log.

**Category**: Productivity (primary), Meetings and scheduling (secondary).
**Keywords**: meeting notes, action items, knowledge base, client teams, Q&A, transcripts.
**Industries**: Professional services.

### Screenshots needed (from the final capture)

Microsoft: up to **5**, **1366×768 px**, PNG/JPEG/GIF, **≤1,024 KB** each, real UI, **Teams chrome visible on tab shots**,
a caption per image, never "MS Teams", at least one **mobile** shot (GF).

| # | Shot | Caption |
|---|---|---|
| 1 | Group chat in Teams desktop: an @Sidekick question and the answer card with sources and 👍/👎 | Ask in the chat, get answers with sources |
| 2 | Meeting-notes card in a group chat: summary, decisions with Save to knowledge, action items thread | Meeting notes and action items after every Teams meeting |
| 3 | Sidekick personal app "Meetings" tab in Teams (app bar visible): meeting list and open action items | Your group's meetings, notes and action items in Teams |
| 4 | Teams mobile (iOS or Android) answer card or tab, framed in a 1366×768 canvas | Works on Teams mobile |
| 5 | Welcome card after adding Sidekick to a group chat (installer @mentioned, setup steps) | Set up by your Team Lead in minutes |

Optional video (YouTube or Vimeo, ads off): 60–90 s value video and/or a 3–5 min walkthrough. The pitch capture
(record-walkthroughs notes) can be cut for this.

### Draft test notes for Microsoft's validation team

Microsoft tests the full first run. They need an **admin** and **non-admin** accounts in a test tenant with
**pre-filled data**, plus **one account that isn't set up** (first-run sign-in). Draft:

1. Admin (Org Owner + Microsoft 365 admin) signs in to the portal, approves Microsoft 365 (Settings → Microsoft permissions shows all Approved).
2. Team Lead account adds Sidekick to the group chat "Contoso cutover" (already assigned to the group "Contoso"), mentions `@Sidekick when is the cutover?` → answer with sources.
3. `@Sidekick help` → command list. `@Sidekick link` → which group the chat belongs to.
4. Open the Sidekick app → Meetings tab: the pre-filled meeting "Wave 2 planning" with notes; Mark done on an action item.
5. Add Sidekick as a tab to a chat or meeting: the setup page explains it; Save.
6. Member account adds Sidekick to a new chat → Sidekick explains only Team Leads/admins may add it and leaves.
7. The not-set-up account opens the tab → "You don't have a Sidekick account yet…" with the way forward.
8. Meeting notes: hold a short Teams meeting with transcription on, with two group members; notes post to the group chat within about 15 minutes (polling) or a few minutes (subscription).

Use made-up data only (the demo world seed). The Sidekick Labs Microsoft 365 trial ends **November 14, 2026**, and
validation can take weeks, so the test tenant must outlive the review (see below).

## What Cody does in Partner Center

In order. Everything else above is done in code or listed as an open item.

1. **Decide the brand and domain** (name, tagline without "teams", a domain you own). Update lib/brand.ts and point the domain at the site; set `SIDEKICK_WEBSITE_URL` (and use it for the app host too). The Store requires privacy and terms on your own domain.
2. **Get a real support mailbox** and put it in `BRAND.supportEmail` (Store support and AI-report requirement).
3. **Legal review** of /privacy, /terms and /privacy/subprocessors (all marked "Draft: needs legal review").
4. **Decide pricing in the Store**: free listing with sign-up on the website, or a transactable SaaS offer through Microsoft. Either way, no prices or upgrade links may show on Teams mobile (open item above).
5. **Create a Partner Center account**: enroll in the Microsoft AI Cloud Partner Program, register as a Microsoft 365 and Copilot (Teams) publisher. This needs a business identity (company name, address, a verified domain email) and Microsoft's identity check; there's no fee for Teams apps.
6. **Publisher Verification**: in Entra → App registrations → the multi-tenant Sidekick app (`ENTRA_CLIENT_ID`) → Branding & properties → set the Partner Center publisher ID (MPN ID) and a verified publisher domain. Then add `developer.mpnId` to the manifest.
7. **Switch the live site to multi-tenant** (`SIDEKICK_MULTI_TENANT=1`, checklist in docs/TEAMS-MULTITENANT.md) and open self-service sign-up during the review (Owner Console switch).
8. **Keep a test tenant alive through the review**: extend or replace the Sidekick Labs trial (ends Nov 14), keep admin + non-admin test accounts with the demo data, plus one fresh account. Don't delete the demo users until the review is done (or create review-only ones).
9. **Test in shared and private channels** and note any difference in the long description.
10. **Build and pre-check the package**: `npm --prefix app run teams:package`, then upload the zip to the [Teams app validation tool](https://dev.teams.microsoft.com/tools/store-validation) and work through its preliminary checklist.
11. **Capture the 5 screenshots** (table above) and optionally the video.
12. **Create the offer** in Partner Center → Marketplace offers → New offer → Teams app: upload the zip, paste the listing copy, the screenshots, category, privacy/terms/support URLs (same as the manifest), test notes and test accounts (Partner Center's own form; never in chat or the repo).
13. **Submit** and answer the validation team's report (fixes go out as a new manifest version).
14. **After listing**: complete **Publisher Attestation** (Microsoft 365 App Compliance) using the privacy policy and docs/security/.
