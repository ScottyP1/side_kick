# Sidekick's tech stack, in plain words

What Sidekick is built from, where each piece runs, and why. No secrets here; costs and settings are in
`docs/HOSTING.md`, accounts in `docs/ACCOUNTS.md`, how the code fits together in `docs/ARCHITECTURE.md`.

## The one-paragraph version

Sidekick is **one web application** written in **TypeScript** with **Next.js** (React). That single app is
the public website, the customer portal, your Owner Console, the API behind them, and the Teams bot. It runs
as **one container in Azure Container Apps**, keeps its data in **Postgres**, finds things with **Azure AI
Search**, thinks with **Claude** (Anthropic), and talks to Microsoft through the **Teams bot** and **Microsoft
Graph / Entra ID**. **GitHub** holds the code, tests every change and deploys every merge automatically.

## The picture

```
People ──► Microsoft Teams ──(bot messages)──┐
People ──► Browser: website · portal · Owner Console ─┤
                                                      ▼
                         Sidekick app (Next.js / TypeScript, one container)
                         Azure Container Apps · East US
                           │        │            │              │
                           ▼        ▼            ▼              ▼
                     Postgres   Azure AI      Claude API     Microsoft Graph / Entra ID
                     (all data) Search        (Anthropic)    (sign-in, directory, Teams,
                                (finding      answers, notes  meeting transcripts)
                                 passages)    reminders, checks
                           ▲
                 Secrets: Azure Key Vault · Logs/alerts: Log Analytics + App Insights
                 Code & deploys: GitHub (tests on every PR, auto-deploy on merge)
```

## Front end and back end: it's the same app

People often expect a separate "backend". Sidekick deliberately has **one** app (no microservices):

| Part | What it is | Where in the code |
|---|---|---|
| **Front end** (what people see) | React pages rendered by Next.js: the public website, the portal, the Owner Console, the bottom-left assistant | `app/src/app/` (pages), `app/src/components/` |
| **Back end** (the logic and data) | Next.js **API routes** (`/api/...`) running on Node.js on the server: sign-in, groups, documents, Ask, meetings, billing, support… | `app/src/app/api/` (routes), `app/src/lib/` (the business logic) |
| **Teams bot** | The same app answers Teams at `/api/messages` | `app/src/lib/teams/` |
| **Background work** | A job queue in the database (`jobs` table) runs meeting notes, reminders, connector syncs, watchers and roll-off deletions; a heartbeat inside the app ticks it every 30 seconds | `app/src/instrumentation.ts`, `lib/jobs.ts`, `lib/job-kinds.ts` |

So your **backend = Next.js API routes on Node.js 26**, in the same container as the front end.

## Each piece

| Layer | Technology | What it does for Sidekick |
|---|---|---|
| Language | **TypeScript** | All the code, front and back |
| Web framework | **Next.js 16** with **React 19** | Pages, API routes, server rendering |
| Runtime | **Node.js 26** in a Docker container (`node:26-slim`, runs as a non-root user) | Runs the app |
| Hosting | **Azure Container Apps** (`sidekick-app`, East US) | Runs the container, HTTPS, health probes, revisions for rollback |
| Database | **PostgreSQL 17** (Azure Database for PostgreSQL Flexible Server, Central US); **SQLite** for local copies | Every record: organizations, groups, people, documents' text, meetings, action items, chats, tickets, audit log, usage |
| Search | **Azure AI Search** (hybrid: keywords + meaning) with **embeddings** from Azure AI Foundry (`text-embedding-3-small`); a local keyword index as the fallback | Finds the right passages for each question, always walled to one company and group (+ the firm library) |
| AI | **Claude** via the Anthropic API (`@anthropic-ai/sdk`): **Claude Opus 5.5** by default; **Claude Haiku 5.5** for the cheap jobs (public help bot, rewriting follow-ups); each feature's model is a setting | Answers with sources, meeting notes, reminders, guardrail checks, the assistants |
| Microsoft / Teams | **Microsoft Teams SDK** (`@microsoft/teams.*`), **Azure Bot**, **Microsoft Entra ID** sign-in (`jose` verifies tokens), **Microsoft Graph** (directory import, removing itself from chats, meeting transcripts for automatic notes) | Sidekick in Teams chats/channels, "Sign in with Microsoft", importing people |
| Documents | `unpdf` (PDF), `mammoth` (Word) | Reads uploads into text |
| Sign-in security | Passwords (hashed), **passkeys** (`@simplewebauthn`), authenticator apps (encrypted secrets), sign-in limits | Accounts and two-step sign-in |
| Validation | `zod` | Checks inputs and Claude's structured outputs |
| Secrets | **Azure Key Vault** (`sidekick-kv`), read only by the app's managed identity | API keys, database URL, encryption key |
| Monitoring | **Log Analytics** (logs), **Application Insights** uptime test, Azure alerts by email; the app's own **Activity** page and Owner Console | Know when something breaks |
| Code & delivery | **GitHub** (private repo), **GitHub Actions** (tests on every PR; deploy on merge via a managed identity, no stored password), GitGuardian, CodeRabbit | Reviews, tests, automatic deploys with health check and rollback |
| Images | **Azure Container Registry** (`sidekicklabsacr`) | Stores each built version |

## Where your data lives

- **Postgres** (Azure, Central US): everything customers create, with 35-day backups.
- **Azure AI Search**: a searchable copy of documents' passages (rebuilt from Postgres if needed).
- **Claude**: only receives the few passages needed for one answer; nothing is stored there between questions,
  and API data isn't used to train models by default.
- **Uploaded files**: their text is kept in Postgres; original files aren't stored except support attachments.

## Running it

- **Live**: Azure (see `docs/HOSTING.md`); every merge to `main` deploys itself.
- **Visual walkthrough**: `docs/HOW-IT-WORKS.html` (services, client setup, a question's and a meeting's journey,
  the walls between clients, common questions).
- **On the Mac**: `npm --prefix app run dev` (or the `sidekick-preview` / `e2e-*` copies with their own data);
  SQLite and fake Claude unless configured otherwise. Tests: `npm --prefix app test` (both databases + build).
