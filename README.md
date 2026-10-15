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
| Meeting notes, Q&A with sources, knowledge map, gaps, action items | Sidekick in Teams chat, Jira/DevOps stories – step 2 |
| Usage and cost metering per feature/model | Live meetings with voice and virtual hand-raise – step 3 |
| Branding (logo + color) | Connectors (Outlook, SharePoint, Jira, …) – step 2 |

Data lives in `app/data/sidekick.db` (SQLite, local only). Delete that file to start fresh.
