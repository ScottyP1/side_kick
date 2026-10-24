# Connect your tools: Azure DevOps, Jira, GitHub, Confluence, SharePoint and OneDrive

Sidekick can read your team's work items from **Azure DevOps Boards**, **Jira Cloud** or **GitHub Issues** (issues and pull requests), so answers, the knowledge map and meeting notes know what's open, who owns it, when it's due and what's blocking it. Ask "what's blocking the cutover?" and Sidekick answers from the work item itself, cites it ("Azure DevOps Bug #4821 …", "Jira STORE-15 …" or "GitHub Issue store-pos#41 …") and links straight to it.

It can also read a **Confluence Cloud** space: its pages become part of the group's documents, so answers can quote the runbook or the decision log and link to the page.

And it can read **SharePoint document libraries** and **OneDrive shared folders** (one **Microsoft 365** connection covers both): their Word, PDF, PowerPoint and text files become part of the group's documents, kept up to date as people edit them, and answers link straight to the file.

Sidekick only **reads**. It never creates, changes or comments on anything in these tools, and it never stores a password: you sign in with the tool's own sign-in, and Sidekick keeps an encrypted sign-in it can renew.

## What you need
- **Your plan.** Starter doesn't include connectors; Team includes one connected tool (Azure DevOps, Jira, GitHub, Confluence *or* Microsoft 365; SharePoint and OneDrive together count as one); Business and Enterprise include all of them. Connectors shows what yours includes, and **Usage & billing** lets the Org Owner upgrade.
- **The right role.** An **Org Owner** or **Org Admin** connects (and disconnects) a tool for the whole organization. An Org Owner, Org Admin or a group's **Team Lead** links projects to groups.
- **Access in the tool.** The account you connect with must be able to open the projects (repositories, spaces) you want. Sidekick sees exactly what that account can see, nothing more.

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

## Connect GitHub
1. **Install the Sidekick app on your GitHub organization first** (once): someone who owns the organization on GitHub opens the Sidekick GitHub App's page, presses **Install** and picks the repositories Sidekick may read (all, or only some). The app asks only to *read* issues, pull requests and repository basics.
2. Open **Connectors** and scroll to **GitHub**. There's nothing to type.
3. Press **Connect GitHub**, sign in with your GitHub account and **Authorize** it.

Only repositories the app is installed on, and that your own GitHub account can open, can be linked. Removing a repository from the installation (or uninstalling the app) stops Sidekick reading it.

## Connect Confluence
1. Open **Connectors** and scroll to **Confluence**.
2. If your account can open more than one Atlassian site, type the one to use (the name before `.atlassian.net`). With one site, leave it empty.
3. Press **Connect Confluence**, sign in with your Atlassian account and **Accept** the read-only access. Connecting Confluence is separate from connecting Jira, even on the same site.

## Connect Microsoft 365 (SharePoint and OneDrive)
1. Open **Connectors** and click the **SharePoint** or **OneDrive** tile (both open the **Microsoft 365 files** panel). There's nothing to type.
2. Press **Connect Microsoft 365 files** and sign in with your Microsoft **work** account.
3. Microsoft asks to let Sidekick **read** sites and files you can open (Sites.Read.All, Files.Read.All). Reading SharePoint needs a **Microsoft admin's approval once for your organization**: if you are one, tick "Consent on behalf of your organization" and **Accept**; if not, Microsoft says an admin must approve. Ask your Microsoft 365 admin to connect once themselves (or to approve Sidekick in the Microsoft Entra admin center). After that, anyone who is an Org Owner or Org Admin can connect.
4. If your organization linked its Microsoft tenant in Sidekick (Microsoft sign-in), only work accounts from that tenant can connect.

Sidekick reads only what the account that connected can open, and never changes, moves, shares or deletes a file.

## Link a project to a group
A connected tool doesn't feed any group until you link a project to it, so each group only learns from its own engagement's board, repository or space.
1. On **Connectors**, under the tool, press **Link a project to a group** (GitHub: **Link a repository**, Confluence: **Link a space**, Microsoft 365: **Link a library or folder**).
2. Pick the **project** (Azure DevOps), **project key** (Jira, e.g. `STORE`), **repository** (GitHub, e.g. `northwind/store-pos`), **space** (Confluence) or **library or folder** (Microsoft 365: a whole SharePoint document library like "Store Operations › Documents", one of its top-level folders, or a OneDrive folder someone shared with you), and the **group**.
3. Choose who may see its items in answers:
   - **Internal (team only)**, the default, or
   - **Shareable (also with client guests)**, for a board your client can see anyway.
4. Press **Link and sync**. Sidekick reads the project's work items straight away and shows how many it read.

The same project can feed more than one group. Team Leads see and link only the groups they belong to. Everyone else sees which projects feed their own groups and whether they're healthy.

## What Sidekick reads
For each work item or issue: its **title**, **type**, **state**, **assignee**, **due date** (or target date), **what blocks it** (Azure DevOps "predecessor" links, Jira "is blocked by" links) and its parent, **tags or labels**, the **description**, and a short **summary of the latest comments** (how many, plus the newest three, shortened). That's what answers can quote, with a link back to the item.

From **GitHub**: every issue and pull request of the repository, with its state (Open, Draft, Closed or Merged), assignees, labels, milestone (its due date counts as the due date), description and latest comments.

From **Confluence**: every current page of the space, with its full text (very long pages are cut after about 50,000 characters), where it sits in the page tree, its labels and who changed it last. Pages are treated like the group's **documents**, not like work items: the **Documents** filter in Ask includes them, and they don't show up as open work. Attachments, page comments and blog posts aren't read.

From **SharePoint and OneDrive**: every **Word (.docx), PDF, PowerPoint (.pptx), text, Markdown, CSV and JSON** file in the library or folder, including its subfolders, read the same way as an upload (PDF pages and PowerPoint slides are kept, so answers say "page 3" or "slide 4"), with its folder, who changed it last and a link to it. Files are **documents**: the **Documents** filter includes them. Spreadsheets, images, videos and other files are left out. A file **larger than 25 MB** (or one that's password-protected or damaged) isn't read: it shows as **"not read"** on Connectors and answers can still name it with a link, so you can open it yourself or save a smaller copy. A file that's deleted, or moved out of the linked folder, leaves Sidekick on the next sync.

After the first read, Sidekick checks every 15 minutes and only reads what **changed** since the last time. You can also press **Sync now** on a linked project.

Where the items show up:
- **Ask** (portal and Teams): answers cite work items like documents, with **Open in Azure DevOps / Jira / GitHub** links (in Teams, an **Open #4821** button), Confluence pages with **Open in Confluence**, and files with **Open in SharePoint** / **Open in OneDrive**. The **Work items** filter in Ask keeps only work items.
- **Memory & gaps**: the knowledge map sees the group's open items, so an overdue, unassigned or blocked item, or one that contradicts a decision, can show up as a gap.
- **Meeting notes**: when notes are written, Sidekick knows the group's open items and can name the item an action is about (e.g. "Book the war room (#4850)").

## Health: is it working?
Each tool and each linked project shows its status on Connectors:
- **Healthy / OK**: the last sync worked. You see when it last synced and how many items it holds.
- **Problem**: the last sync failed, with the reason in plain words (for example "Azure DevOps refused access to the project: the account that connected it may have lost access"). Nothing is deleted; Sidekick tries again on the next sync. A project that hasn't synced successfully for 6 hours also shows a problem.
- **"asked Sidekick to slow down (rate limit)"**: the tool limits how many requests it answers per hour (GitHub especially; Microsoft 365 too when many files change at once). Sidekick stops, keeps what it has read, and carries on from where it stopped on a later sync. Nothing to do.
- **Sign-in expired**: the tool's sign-in ran out or was revoked (for example the person who connected it left, or an admin removed the app). Syncing pauses until an Org Owner or Org Admin presses **Reconnect** and signs in again; the items already read stay until then.

## Unlink or disconnect
- **Unlink** (on a linked project) removes that project's items from the group's knowledge. The tool stays connected.
- **Disconnect** (Org Owners and Org Admins) forgets the tool's sign-in and removes every linked project and every item Sidekick read from it, from every group. Answers stop citing them straight away.
- Deleting a group removes the projects linked to it and their items. Ending your organization's plan removes everything, as for all other data.

## Good to know
- **Walls hold.** Work items belong to the group their project is linked to, exactly like documents: other groups, other organizations and the Sidekick assistant of someone outside the group never see them. Client guests only ever see items from projects marked Shareable.
- **Nothing is written back.** Sidekick asks only for read access in every tool.
- **Each sync reads at most 2,000 changed items** (Confluence: 1,000 pages; Microsoft 365: 200 files); a very large board, repository, space or library catches up over a few syncs.
- **Deleted items**: a work item, issue or page deleted in the tool stays in Sidekick until you unlink and link the project again. Microsoft 365 is different: deleted files leave on the next sync by themselves.
- The activity of each sync (how long, how many items) appears on the **Activity** page under **Connectors**, without any item text.
<!-- help-center:skip -->

## For developers
- Code: `app/src/lib/connectors.ts` (framework: sign-in, sealed tokens and refresh, rate limits, sync, health), `connector-ado.ts`, `connector-jira.ts`, `connector-github.ts`, `connector-confluence.ts`, `connector-text.ts`; routes under `app/src/app/api/connectors/`; page `app/src/app/(app)/connectors/`.
- Tests: `app/tests/api.test.mjs` ("connectors: …" and the isolation test) against the fake tools in `app/scripts/fake-tools.mjs`; the demo world connects all four (docs/DEMO.md).
- Setting up the real apps: `docs/RUNBOOKS.md` → Connector apps.
<!-- /help-center:skip -->
