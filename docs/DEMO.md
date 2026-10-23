# Demo world (local only)

A big, realistic, **made-up** test world for a local copy of Sidekick: one consulting firm with ~115 people in every
role, ten client engagements full of documents, meeting notes, Teams chats and questions, and three smaller client
organizations for the Owner Console. Use it to try every feature, see how each role's view differs, and demo.

**Local only.** It runs on your Mac with its own data (never `app/data`, never the live site, Azure, Microsoft 365 or
real Teams). Teams is simulated through the app's local Teams test path, so the 135 people cost no Microsoft licenses.
Every company and person is invented (Microsoft's sample names: Contoso, Fabrikam, Litware, Tailwind Traders, Adatum,
Woodgrove, Wide World Importers, Alpine Ski House, Coho Winery, Fourth Coffee, Tailspin…). It never runs on deploy.

## Seed it (or reset it)

```bash
npm --prefix app run seed:demo
```

About a minute. It wipes and rebuilds `app/.demo-data` every time (idempotent), so run it again to reset the demo to the
start. Passwords are generated once and **kept between runs**; they are written only to `app/.demo-logins.json` and the
logins guide `app/.demo-logins.md` (both git-ignored, readable only by you), never printed. To also put the guide
somewhere else (e.g. the pitch folder): add `-- --logins-out "<file>"`.

Options (after `--`): `--postgres [postgres:///sidekick_demo]` seeds a local Postgres database instead of SQLite;
`--with-real-claude` writes the notes, answers and knowledge maps with the real Claude (key from `app/.env.local`; it
prints the expected cost, about $3–4, and asks first); `--port <n>` (default 3329) for the seeding copy; `--verbose`.

## Start it

In Claude Code: preview **`sidekick-demo`** (or `sidekick-demo-pg` after a Postgres seed) from `.claude/launch.json`.
It runs on **http://localhost:3330** with `app/.demo-data`, fake Claude, the reminder timer off and every outside
service blanked. Sign in at `/login` (portal) or `/owner/login` (Owner Console) with the accounts in
`app/.demo-logins.md`: one per role (Org Owner, Org Admin, Billing Admin, Team Lead, Member, Viewer, the Owner Console
operator, and the Org Owner of a second client), each with things to try. Stop the demo copy before seeding again
(the seed refuses while port 3330 is in use).

**Connectors**: the launch config also starts a fake Azure DevOps and Jira (`app/scripts/fake-tools.mjs`, made-up
Northwind projects) on port 3331, so Connectors shows both tools connected: the "Wave 2 Cutover" board and the Jira
project STORE feed the Contoso group ("What's blocking the payment gateway cutover?"), "Data Platform" feeds Litware
and shows a problem ("refused access", also a "Connector not working" finding for Litware's managers): press **Sync now**
to fix it.
**Sync now**, Reconnect and the work item links work against the fake; the demo copy and the seed share a made-up
encryption key so the sealed sign-ins open. `--tools-port <n>` moves the fake when seeding.

With fake Claude, new questions get short "Test answer…" replies; the seeded history, notes and maps are realistic.
Start the copy without `SIDEKICK_FAKE_CLAUDE=1` to use the real Claude (costs money). Importing a new meeting tries to
post notes to the simulated Teams chats, which aren't running: a harmless "Teams notes post failed" line in the terminal.

## What's in it

| | |
|---|---|
| **Northwind Consulting** (Business plan, test mode) | 1 Org Owner, 3 Org Admins, 1 Billing Admin, 10 Team Leads, 80 Members, 20 Viewers |
| **10 groups** (+ 1 new) | One per engagement, each with a Team Lead and members (plus a new bid team with no Team Lead yet, for Needs attention). Contoso reuses `samples/contoso/`; the other nine are generated from a profile each in `app/scripts/demo-world.mjs` |
| **Per group** | 7–8 documents (SOW, runbook, RAID log, architecture, status report, internal staffing note, glossary), 5–8 meeting transcripts imported through the normal import with notes (decisions, action items with owners and dates, open questions, risks), a tracked Teams chat, questions with 👍/👎, a knowledge map with gaps, reminder states |
| **Firm library** | Expense policy v3 (replaces v2), travel, rate card, data handling, information security, RAID-log standard, status-report template |
| **Edge cases** | Alpine Ski House **Ending** (roll-off, deleted in 21 days); Fabrikam Bank with stricter guardrails and a custom rule; a Contoso chat with **client guests** (Shareable-only answers); overdue and unowned action items; a document that contradicts a later meeting in every group (runbook date vs. moved milestone) and a scope conflict; AI credit at ~83% (the 80% notice) |
| **Needs attention** (watchers) | The seed runs the job queue once, so Home and the groups' Overview tabs show findings of every kind: unanswered questions, a Teams chat whose posts fail, one Sidekick was removed from, two chats waiting in Northwind's Microsoft tenant, overdue and unowned action items, the Contoso runbook a later decision changed, a new "Bid team – Woodgrove RFP" group with no Team Lead and no notes chat, Azure DevOps and Jira connectors that stopped working. Sign in as different roles to see who sees what. The demo copy runs with its job heartbeat off; findings stay as seeded |
| **Support** | Tickets from four roles with the Sidekick team's replies, an internal note, a resolved one, and one from the public form |
| **Other clients** | Tailspin Partners (Starter, 14 of 15 people, 1 of 1 group, knowledge map turned off by the Sidekick team), Trey Research Group (trial ending in 4 days), Lucerne Partners (payment failed) |
| **Owner Console** | An operator account; ~8 weeks of AI usage history per client for Business, Clients and Performance |

## How it works

`app/scripts/seed-demo.mjs` starts its own copy of the app and loads everything **through the app's own API** (setup,
Owner Console, users, groups, uploads, meeting imports, Teams messages through the bot endpoint in local test mode,
guardrails, Ask, 👍/👎, support), so audit entries and traces exist like in real use. Then, with the copy stopped, it fills
in what has no API through `lib/db.ts`: realistic notes/answers/maps in place of fake Claude's placeholders, dates moved
back to when things happened, action item and gap states, sign-in times and usage history. It starts the copy once more
so the app re-indexes the rewritten notes, sends two Teams reminders and sets one group to Ending.
The world itself (people, profiles, texts) is in `app/scripts/demo-world.mjs`; the logins guide in
`app/scripts/demo-logins.mjs`. `app/tests/seed-demo.test.mjs` (part of `npm test`) seeds a fresh SQLite copy twice.
