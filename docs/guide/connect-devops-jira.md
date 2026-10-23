# Connect Azure DevOps or Jira

Sidekick can read your team's work items from **Azure DevOps Boards** or **Jira Cloud**, so answers, the knowledge map and meeting notes know what's open, who owns it, when it's due and what's blocking it. Ask "what's blocking the cutover?" and Sidekick answers from the work item itself, cites it ("Azure DevOps Bug #4821 …" or "Jira STORE-15 …") and links straight to it.

Sidekick only **reads**. It never creates, changes or comments on anything in Azure DevOps or Jira, and it never stores a password: you sign in with the tool's own sign-in, and Sidekick keeps an encrypted sign-in it can renew.

## What you need
- **Your plan.** Starter doesn't include connectors; Team includes one connected tool (Azure DevOps *or* Jira); Business and Enterprise include all of them. Connectors shows what yours includes, and **Usage & billing** lets an Org Owner or Billing Admin upgrade.
- **The right role.** An **Org Owner** or **Org Admin** connects (and disconnects) a tool for the whole organization. An Org Owner, Org Admin or a group's **Team Lead** links projects to groups.
- **Access in the tool.** The account you connect with must be able to open the projects you want. Sidekick sees exactly what that account can see, nothing more.

## Connect Azure DevOps
1. Open **Connectors** in the portal and scroll to **Azure DevOps** (or click its tile).
2. Type your **Azure DevOps organization**: the name after `dev.azure.com/` (for `https://dev.azure.com/northwind` that's `northwind`).
3. Press **Connect Azure DevOps** and sign in with your Microsoft work account. Approve the read-only access ("read your work items").
4. You're back on Connectors, with Azure DevOps **Connected**.

Your Azure DevOps organization must be connected to your company's Microsoft Entra ID (most company organizations are). If your IT team has to approve new apps, they may need to approve Sidekick once.

## Connect Jira
1. Open **Connectors** and scroll to **Jira**.
2. If your account can open more than one Jira site, type the one to use: the name before `.atlassian.net` (for `https://northwind.atlassian.net` that's `northwind`). With one site, leave it empty.
3. Press **Connect Jira**, sign in with your Atlassian account and **Accept** the read-only access.

## Link a project to a group
A connected tool doesn't feed any group until you link a project to it, so each group only learns from its own engagement's board.
1. On **Connectors**, under the tool, press **Link a project to a group**.
2. Pick the **project** (Azure DevOps) or **project key** (Jira, e.g. `STORE`), and the **group**.
3. Choose who may see its items in answers:
   - **Internal (team only)**, the default, or
   - **Shareable (also with client guests)**, for a board your client can see anyway.
4. Press **Link and sync**. Sidekick reads the project's work items straight away and shows how many it read.

The same project can feed more than one group. Team Leads see and link only the groups they belong to. Everyone else sees which projects feed their own groups and whether they're healthy.

## What Sidekick reads
For each work item or issue: its **title**, **type**, **state**, **assignee**, **due date** (or target date), **what blocks it** (Azure DevOps "predecessor" links, Jira "is blocked by" links) and its parent, **tags or labels**, the **description**, and a short **summary of the latest comments** (how many, plus the newest three, shortened). That's what answers can quote, with a link back to the item.

After the first read, Sidekick checks every 15 minutes and only reads what **changed** since the last time. You can also press **Sync now** on a linked project.

Where the items show up:
- **Ask** (portal and Teams): answers cite work items like documents, with **Open in Azure DevOps / Jira** links (in Teams, an **Open #4821** button). The **Work items** filter in Ask keeps only them.
- **Memory & gaps**: the knowledge map sees the group's open items, so an overdue, unassigned or blocked item, or one that contradicts a decision, can show up as a gap.
- **Meeting notes**: when notes are written, Sidekick knows the group's open items and can name the item an action is about (e.g. "Book the war room (#4850)").

## Health: is it working?
Each tool and each linked project shows its status on Connectors:
- **Healthy / OK**: the last sync worked. You see when it last synced and how many items it holds.
- **Problem**: the last sync failed, with the reason in plain words (for example "Azure DevOps refused access to the project: the account that connected it may have lost access"). Nothing is deleted; Sidekick tries again on the next sync. A project that hasn't synced successfully for 6 hours also shows a problem.
- **Sign-in expired**: the tool's sign-in ran out or was revoked (for example the person who connected it left, or an admin removed the app). Syncing pauses until an Org Owner or Org Admin presses **Reconnect** and signs in again; the items already read stay until then.

## Unlink or disconnect
- **Unlink** (on a linked project) removes that project's items from the group's knowledge. The tool stays connected.
- **Disconnect** (Org Owners and Org Admins) forgets the tool's sign-in and removes every linked project and every item Sidekick read from it, from every group. Answers stop citing them straight away.
- Deleting a group removes the projects linked to it and their items. Ending your organization's plan removes everything, as for all other data.

## Good to know
- **Walls hold.** Work items belong to the group their project is linked to, exactly like documents: other groups, other organizations and the Sidekick assistant of someone outside the group never see them. Client guests only ever see items from projects marked Shareable.
- **Nothing is written back.** Sidekick asks only for read access in both tools.
- **Each sync reads at most 2,000 changed items**; a very large board catches up over a few syncs.
- The activity of each sync (how long, how many items) appears on the **Activity** page under **Connectors**, without any item text.
<!-- help-center:skip -->

## For developers
- Code: `app/src/lib/connectors.ts` (framework: sign-in, sealed tokens and refresh, sync, health), `connector-ado.ts`, `connector-jira.ts`, `connector-text.ts`; routes under `app/src/app/api/connectors/`; page `app/src/app/(app)/connectors/`.
- Tests: `app/tests/api.test.mjs` ("connectors: …" and the isolation test) against the fake tools in `app/scripts/fake-tools.mjs`; the demo world connects both (docs/DEMO.md).
- Setting up the real apps: `docs/RUNBOOKS.md` → Connector apps.
<!-- /help-center:skip -->
