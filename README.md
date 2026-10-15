# Sidekick

An AI teammate for Microsoft Teams. This folder holds the step 1 build: a working web dashboard where Sidekick reads your documents and meeting transcripts, writes meeting notes, answers questions with sources, and maps what the team knows and doesn't.

- `app/` – the Next.js (React) app: dashboard + server API
- `docs/BLUEPRINT.md` – the full product blueprint (steps 1–3, architecture, security)
- `docs/sidekick-dashboard*.html` – the original clickable mockups
- `samples/` – a sample Teams transcript and documents for demos

## Run it

1. Put your Claude API key in `app/.env.local` (`ANTHROPIC_API_KEY=...`). The file is private and ignored by git.
2. Start the app:

   ```bash
   npm --prefix app run dev
   ```

3. Open http://localhost:3000. The first visit asks you to set up your organization; you become the Org Owner.

## Owner Console (for you, the Sidekick operator)

Open http://localhost:3000/owner. The first visit creates your owner account (only possible on this computer). It's separate from any client login.

- **Overview:** AI spend (today, month, projected), clients, error rate, response time, spend per day, spend by client, latest errors
- **Clients:** every client organization with users, workspaces, meetings, docs, monthly spend and errors. Add a client (creates their Org Owner with a one-time password) or pause/resume their access
- **Performance & errors:** typical and slowest response times, error rates and cache savings per feature and model, failed requests, processing health per client
- **Releases & switches:** the running version and commit, models in use, kill switches that pause a feature for every client, and the operator log

## Sidekick in Teams: test locally with Microsoft 365 Agents Playground

The Teams bot lives in the same app at `/api/messages`. Agents Playground is a local Teams-like chat window from Microsoft, so you can try it **without a Microsoft 365 tenant, Azure Bot or tunnel**. It uses its own test data folder (`app/.playground-data`), so your real Sidekick data is never touched.

1. Start the test copy of Sidekick (port 3100, separate data, Playground mode on):

   ```bash
   npm --prefix app run dev:teams
   ```

2. In a second terminal, start Agents Playground:

   ```bash
   npm --prefix app run playground
   ```

   It opens http://localhost:56150, a Teams-style chat with Sidekick. Sidekick greets you with an **8-character link code**.

3. Open http://localhost:3100, set up a test organization (made-up details), create a workspace and add the files from `samples/` (mark them Shareable).
4. **Workspaces → Link Teams channel**: enter the code, pick the workspace, Link. Sidekick confirms in the Playground chat.
5. In Playground ask: “Why did we choose Cosmos DB?” You get an answer card with sources.
6. **Meetings → Import transcript** → `samples/Contoso - Sprint 14 planning.vtt`. The notes card and one card per action item appear in Playground. Type a name and click **Assign**, or **Mark done**: the change shows on the Memory & gaps page.
7. In Playground, `help` shows the commands and `link` shows which workspace the chat is linked to.

To start the test copy over, stop it and delete `app/.playground-data` (and `app/.next-playground`). If `next dev` adds `.next-playground` lines to `app/tsconfig.json`, undo them with `git checkout app/tsconfig.json`.

**Security:** Playground mode skips Microsoft's sign-in check on bot messages, so it only switches on when `TEAMS_LOCAL_PLAYGROUND=true`, never in production builds, and only accepts requests from this computer. In real Teams every message must carry a token signed by Microsoft for Sidekick's Azure Bot (`CLIENT_ID`/`CLIENT_SECRET`/`TENANT_ID` in `app/.env.local`).

**Rules in Teams:** Sidekick only answers from the workspace linked to that channel or chat. If the channel is marked “Client guests”, answers use Shareable sources only and notes from internal-only meetings are not posted there. Only Org Owners and Admins can link or unlink. Everything is in the audit log.

## Demo script (5 minutes)

1. **Workspaces** → create “Contoso Retail – Cloud Migration”.
2. **Knowledge & docs** → drop in the two files from `samples/` (mark them Shareable).
3. **Meetings** → Import transcript → `samples/Contoso - Sprint 14 planning.vtt`, tick “Client guests attended”. Notes appear in ~15 seconds.
4. **Knowledge & docs** → Ask: “Why did we choose Cosmos DB?” and “When is wave 2 and how many stores?” (it flags the 48 vs 52 conflict).
5. Ask something it can't know, like “What's Sam's hourly rate?”: it says so and logs a knowledge gap.
6. **Memory & gaps** → Refresh knowledge map: topics with coverage, gaps, and the action-item tracker.
7. **Usage & billing** → what each AI feature cost.

## What step 1 does and doesn't do

| Works now | Comes later |
|---|---|
| Sign-in, roles, workspace walls, audit log | Microsoft (Entra ID) sign-in – step 2 |
| Upload PDF / Word / text / Teams transcripts, keyword search | Azure AI Search with meaning-based search – step 2 |
| Meeting notes, Q&A with sources, knowledge map, gaps, action items | Jira/DevOps stories – step 2 |
| Teams bot: @Sidekick answers, notes and action-item cards (tested in Agents Playground) | Real Teams install (Azure Bot, manifest, tunnel) – step 2 |
| Usage and cost metering per feature/model | Live meetings with voice and virtual hand-raise – step 3 |
| Branding (logo + color) | Connectors (Outlook, SharePoint, Jira, …) – step 2 |
| Owner Console: all clients, spend, errors, kill switches | Release pipeline and staged rollouts – step 2 |

Data lives in `app/data/sidekick.db` (SQLite, local only). Delete that file to start fresh.
