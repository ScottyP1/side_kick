# Sidekick

An AI teammate for Microsoft Teams, built for consultancies and tech firms that run many client
engagements. Each client engagement gets a **group** (a walled-off workspace with its own Team Lead,
people, documents, meetings and Teams chats). Sidekick answers questions in Teams and the portal **with
sources**, writes meeting notes and action items, posts reminders about what's still open, and maps what the
team knows and doesn't, inside guardrails each company sets.

> **Private repository.** This repo stays private (a ground rule). Personal accounts and made-up sample
> data only: nothing from Accenture or real clients. Secrets live only in `app/.env.local` (git-ignored)
> and in Azure; never commit them. The public website is served *by* the app; the code is never published.

## Status (October 2026)

- **Live on Azure** (Container Apps + Postgres + Azure AI Search + Azure Bot), health-checked, with uptime
  and restart alerts, 35-day database backups and budgets on every service. Teams works in the Sidekick
  Labs test tenant.
- **Built:** portal (groups, documents, meetings, Ask, memory & gaps, guardrails, roles incl. Team Lead,
  activity, audit, usage), Teams bot (answers, notes, reminders with Assign / Mark done / Snooze / Not
  relevant, chat tracking), Microsoft sign-in, Owner Console (all clients, switches, errors, plans),
  self-service sign-up with a **test-mode** checkout (off by default), public pricing/privacy/terms/support
  pages, Indigo design.
- **What's next and who does what:** `docs/PROGRESS.md` → **Roadmap & queue** (the single source of truth).

## Where things live

| Path | What |
|---|---|
| `app/` | The Next.js app: portal, public pages, Owner Console (`/owner`), API, Teams bot (`/api/messages`) |
| `app/src/lib/` | Server logic. Claude only via `claude.ts`, search via `search.ts`, database via `db.ts`, guardrails via `guardrails.ts` |
| `app/tests/` | End-to-end and database tests (both SQLite and Postgres) |
| `teams/` | Teams app package: manifest template + icons (`npm --prefix app run teams:package`) |
| `infra/azure/` | Deploy, status, freeze/unfreeze scripts |
| `docs/PROGRESS.md` | Status, roadmap & queue, handoff notes: **read first** |
| `docs/guide/` | User guides: concepts, roles & permissions, admin, Teams, Owner Console |
| `docs/ARCHITECTURE.md` | How the code fits together and the rules every change keeps |
| `docs/HOSTING.md` | What runs where in Azure, costs, budgets, monitoring, Teams package |
| `docs/RUNBOOKS.md` | Roll back, restore the database, rotate secrets, incidents, site down |
| `docs/security/` | Security & operations reviews (Oct 2026) |
| `docs/BLUEPRINT.md` | The full product blueprint |
| `docs/mockups/`, `docs/sidekick-dashboard*.html` | Clickable design mockups (onboarding/groups, original dashboard) |
| `samples/` | Made-up Contoso engagement: documents and Teams transcripts for demos and tests |

## Run it

1. Put your Claude API key in `app/.env.local` (`ANTHROPIC_API_KEY=...`). The file is private and ignored by git.
2. Start the app:

   ```bash
   npm --prefix app run dev
   ```

3. Open http://localhost:3000. The first visit asks you to set up your organization; you become the Org Owner.

## Tests

```bash
npm --prefix app test
```

Runs about 200 automated tests (the exact count is in `CLAUDE.md`) on **both** databases (SQLite and Postgres): the database layer, plus end-to-end checks of sign-in and the sign-in limit, temporary passwords, organization and group walls, every role's permissions, the client-guest filter, uploads, meeting notes, guardrails, sign-up and test-mode billing, failures, the Teams bot and reminders, the in-app assistant, Microsoft sign-in (including forged and replayed replies), kill switches, security headers and suspension. They use a throwaway database, a fake Claude (free, canned answers, test mode only), a fake Teams connector and a fake Microsoft sign-in service, so nothing real is touched or paid for. The Postgres half needs Postgres running on this Mac (`brew services start postgresql@17`); without it those are skipped with a warning.

Last, it runs a **production build** (`next build`, the same step as the Docker image and the Azure deploy) in a throwaway build folder, so it works while your dev server is running and never touches `app/data`. The other tests use `next dev`, which allows some things a production build refuses; if the build fails, the run fails and prints the end of the build error. It adds a minute or two; `SKIP_BUILD=1 npm --prefix app test` leaves it out while you iterate, but run the full thing before committing.

On GitHub, every pull request runs the same tests automatically (`.github/workflows/test.yml`, on GitHub's free minutes with its own throwaway Postgres). The result shows as a check on the pull request; don't merge while it's red.

## Postgres and the container

- **Database:** without `DATABASE_URL` the app uses the local SQLite file (`app/data/sidekick.db`). With `DATABASE_URL=postgres://…` it uses Postgres and creates its tables on start (`app/db/schema.postgres.sql`). In production it refuses to run on SQLite, so data can't silently vanish.
- **Move existing data to Postgres** (your SQLite file is only read, never changed; safe to run twice; prints a row-count check):

  ```bash
  DATABASE_URL=postgres://... npm --prefix app run db:copy-to-postgres
  ```

- **Container:** `app/Dockerfile` builds a small production image (no source code, no local data, no `.env` files; runs as a non-root user). Secrets are passed in at run time. `GET /api/health` reports whether the app and database are up (no data or secrets), for Azure's health probe.

## Activity (observability) and the live orb

- **Home page:** "Sidekick live" greets you ("Good morning, Cody", fading in) above a crystal ball (Sidekick) that works harder while Sidekick is busy (while the assistant thinks, its dust swirls in circles and the reply bubble steps through what it's doing: "Reading your question", "Drafting a reply"…), a row with each connection's health (Teams, Claude, Search, Database: Healthy / Slow / Failing / Idle / Not set up) and how many people are active (admins also see names). It pauses when hidden and stays still for people who turn off animations.
- **In-app assistant** (the chat box under the ball): answers questions about using Sidekick ("how do I link a Teams channel?", "what did we spend this month?") and offers actions your role allows: create a workspace, add a person, link a Teams chat, refresh a knowledge map, open a page. **Nothing changes until you press Confirm** on the card it shows; Confirm calls the same API the regular page uses, so role checks and the audit log apply. New client organizations are still created by the Sidekick team in the Owner Console.
- **Activity page** (Org Owners and Admins, like Dynatrace): **Overview** (requests, failures, response times, AI calls and cost, portal vs Teams, busiest operations, requests over time), **Traces** (every request and Teams message; click one for its step-by-step waterfall: search, embeddings, Claude, Teams delivery, database time), **Messages** (what was asked where, answered or not) and the **Audit trail**.
- Traces store timings, counts, model names and costs, never document text, and are deleted after 30 days. The shape follows OpenTelemetry, so it can later also feed Azure Application Insights.

## Hosting in Azure

Sidekick runs in Azure Container Apps with Postgres; see [docs/HOSTING.md](docs/HOSTING.md) for what runs where, costs, budgets, monitoring and alerts, and the `infra/azure/` scripts to deploy (with a health check and the rollback command), freeze and unfreeze it. When something goes wrong in production: [docs/RUNBOOKS.md](docs/RUNBOOKS.md).

## Microsoft sign-in (Entra ID)

- **Sign in with Microsoft** on the sign-in page: people use their Microsoft work account (the one they use for Teams), with their company's own password rules and MFA. Email and password still work unless the Org Owner turns them off.
- **Connect once:** the Org Owner opens **Settings → Microsoft sign-in → Connect with Microsoft** and signs in. That ties the organization to their company's Microsoft tenant; only people from that tenant can use Microsoft sign-in there.
- **Sidekick still decides access:** a person must be added on Users & access first (matched by email the first time, then by their Microsoft account id). Roles and workspace walls don't change.
- **Require Microsoft sign-in** (Org Owner): turns passwords off for everyone and signs out anyone who signed in with a password.
- **Same person in Teams:** once someone has signed in with Microsoft, their Teams messages and card clicks count under their Sidekick name and role (a Viewer can ask in Teams but not change action items). People in a linked chat who aren't in Sidekick still work as before: a Member of that one workspace.
- Setup: the Entra app needs the redirect URI `http://localhost:3000/api/auth/microsoft/callback` (plus the tunnel/hosted address); details and options in `app/.env.example` and `app/src/lib/entra.ts`.

## When something breaks

People always see what happened, never a silent failure:
- **Can't reach Sidekick / something went wrong on our side / paused:** a dialog explains it in plain language, with **Try again**, **Copy details** and, for server problems, a **reference code** like `K7Q2-9XM4`.
- **Smaller problems** (not allowed, not found, bad input): a red message next to the action, or a red toast.
- **A page crashes:** a "This page hit a problem" screen with Try again; the menu keeps working.
- **You (operator):** every reference code is logged with the details in **Owner Console → Performance & errors → App errors**.

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
4. **Workspaces → Link a Teams chat or channel**: enter the code, pick the workspace, Link. Sidekick confirms in the Playground chat.
5. In Playground ask: “Why did we choose Cosmos DB?” You get an answer card with sources.
6. **Meetings → Import transcript** → `samples/Contoso - Sprint 14 planning.vtt`. The notes card and one card per action item appear in Playground. Type a name and click **Assign**, or **Mark done**: the change shows on the Memory & gaps page.
7. In Playground, `help` shows the commands and `link` shows which workspace the chat is linked to.

To start the test copy over, stop it and delete `app/.playground-data` (and `app/.next-playground`). If `next dev` adds `.next-playground` lines to `app/tsconfig.json`, undo them with `git checkout app/tsconfig.json`.

**Security:** Playground mode skips Microsoft's sign-in check on bot messages, so it only switches on when `TEAMS_LOCAL_PLAYGROUND=true`, never in production builds, and only accepts requests from this computer. In real Teams every message must carry a token signed by Microsoft for Sidekick's Azure Bot (`CLIENT_ID`/`CLIENT_SECRET`/`TENANT_ID` in `app/.env.local`).

**Rules in Teams:** Sidekick only answers from the workspace linked to that channel or chat. If the channel is marked “Client guests”, answers use Shareable sources only and notes from internal-only meetings are not posted there. Only Org Owners and Admins can link or unlink. Everything is in the audit log.

## Sidekick in real Teams (when the Microsoft 365 trial is active)

The app package is ready in `teams/` (manifest template + icons). Do these once, in order. Secrets go only into `app/.env.local`, never into chat.

**1. Dev tunnel** (gives your Mac a stable https address Teams can reach)

```bash
brew install --cask devtunnel
```

```bash
devtunnel user login
```

```bash
devtunnel create sidekick --allow-anonymous
```

```bash
devtunnel port create sidekick -p 3000
```

`devtunnel show sidekick` prints the address, like `https://xxxx-3000.usw2.devtunnels.ms`. “Anonymous” is needed because Microsoft's servers call in without a tunnel login; Sidekick checks Microsoft's signed token on every bot message itself. The portal's login page is reachable through the tunnel while it runs, so stop it (Ctrl+C) when you're not testing.

**2. Entra app + Azure Bot**
- Sign in to https://entra.microsoft.com **with the Sidekick Labs admin account** → App registrations → New registration “Sidekick Bot”, *Accounts in this organizational directory only*. Note the Application (client) ID and Directory (tenant) ID. Certificates & secrets → New client secret; copy the value straight into `app/.env.local`.
  (Create it in the Sidekick Labs tenant: a single-tenant bot only works for Teams users in the tenant where its app is registered.)
- In https://portal.azure.com → Create **Azure Bot** → Pricing tier **Free (F0)**, Type of App **Single Tenant**, Creation type **Use existing app registration** with the IDs above.
- In the bot: Configuration → Messaging endpoint `https://<your tunnel address>/api/messages`. Channels → add **Microsoft Teams**.

**3. `app/.env.local`** (add these lines yourself)

```
CLIENT_ID=<Application (client) ID>
CLIENT_SECRET=<client secret value>
TENANT_ID=<Directory (tenant) ID>
SIDEKICK_PUBLIC_URL=https://<your tunnel address>
```

**4. Run it** (three terminals): the app, the tunnel, then build the Teams package.

```bash
npm --prefix app run dev
```

```bash
npm --prefix app run tunnel
```

```bash
npm --prefix app run teams:package -- --local
```

That writes `teams/build/sidekick-teams-local.zip` (it passes Microsoft's 62 app-package validation checks). This is for local testing over the tunnel; the live site has its own package (`npm --prefix app run teams:package`, see `docs/HOSTING.md` → Teams app package). Both are the same app to Teams, so uploading one replaces the other.

**5. Upload to Teams**
- Teams admin center → Teams apps → Setup policies → Global → turn on **Upload custom apps** (it can take a few hours to apply).
- In Teams: Apps → Manage your apps → Upload an app → **Upload a custom app** → pick the zip → Add to a team/channel.
- Mention @Sidekick in the channel: it replies with a link code. Enter it at http://localhost:3000 → Workspaces → Link a Teams chat or channel.

## Demo script (5 minutes)

1. **Groups** → New group “Contoso Retail – Cloud Migration”.
2. **Knowledge & docs** → drop in the two files from `samples/` (mark them Shareable).
3. **Meetings** → Import transcript → `samples/Contoso - Sprint 14 planning.vtt`, tick “Client guests attended”. Notes appear in ~15 seconds.
4. **Knowledge & docs** → Ask: “Why did we choose Cosmos DB?” and “When is wave 2 and how many stores?” (it flags the 48 vs 52 conflict).
5. Ask something it can't know, like “What's Sam's hourly rate?”: it says so and logs a knowledge gap.
6. **Memory & gaps** → Refresh knowledge map: topics with coverage, gaps, and the action-item tracker.
7. **Usage & billing** → what each AI feature cost.

## What works now and what's next

| Works now | Next (see PROGRESS → Roadmap & queue) |
|---|---|
| Sign-in (Microsoft or password, sign-in limit, temporary passwords), six roles incl. Team Lead, group walls, audit log | Multi-tenant Microsoft 365 (any company), directory import, chat picker instead of link codes |
| Groups with Team Leads; documents (PDF / Word / text / transcripts); keyword + Azure AI Search meaning search | Plan limits and monthly AI credit, bring-your-own AI for Enterprise |
| Meeting notes, Q&A with sources, knowledge map, gaps, action items | Notes chat per group with automatic Teams meeting transcripts; "save to knowledge" cards |
| Teams: @Sidekick answers, notes, reminders with card buttons, chat tracking | Azure DevOps and Jira connectors |
| Usage and cost per feature/model; Owner Console (clients, switches, errors, plans) | Support tickets + support assistant; Owner Console business view |
| Sign-up with test-mode checkout (off by default); public pricing/privacy/terms/support | Full public website & help center; real payments; Teams Store listing; own domain |
| Hosted on Azure with probes, uptime alerts, logs, backups, runbooks | Live voice in meetings (step 3) |

Local data lives in `app/data/` (SQLite). Use a separate copy for testing (`SIDEKICK_DATA_DIR`, or the
`sidekick-preview` / `e2e-*` launch configs) so real local data is never touched.
