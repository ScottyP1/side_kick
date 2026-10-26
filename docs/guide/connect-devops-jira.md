# Connect your tools: Azure DevOps, Jira, GitHub, Confluence, SharePoint and OneDrive

Sidekick can read your team's work items from **Azure DevOps Boards**, **Jira Cloud** or **GitHub Issues** (issues and pull requests), so answers, the knowledge map and meeting notes know what's open, who owns it, when it's due and what's blocking it. Ask "what's blocking the cutover?" and Sidekick answers from the work item itself, cites it ("Azure DevOps Bug #4821 …", "Jira STORE-15 …" or "GitHub Issue store-pos#41 …") and links straight to it.

It can also read a **Confluence Cloud** space: its pages become part of the group's documents, so answers can quote the runbook or the decision log and link to the page.

And it can read **SharePoint document libraries** and **OneDrive shared folders** (one **Microsoft 365** connection covers both): their Word, PDF, PowerPoint and text files become part of the group's documents, kept up to date as people edit them, and answers link straight to the file.

Sidekick only **reads**. It never creates, changes or comments on anything in these tools, and it never stores a password: you sign in with the tool's own sign-in, and Sidekick keeps an encrypted sign-in it can renew.

## What you need
- **Your plan.** Starter doesn't include connectors; Team allows one tool type (Azure DevOps, Jira, GitHub, Confluence *or* Microsoft 365; SharePoint and OneDrive together count as one); Business and Enterprise allow all of them. However many groups connect an allowed tool, it counts once. Connectors shows what yours includes, and **Usage & billing** lets the Org Owner upgrade.
- **The right role.** The **Org Owner** only chooses which tool *types* the organization allows (a switch per tool on Connectors; the Org Owner never signs in to a client's tool). Each group's **Team Lead** (or an Org Owner/Admin, for any group) then connects an allowed tool **for their group** and links projects. A Team Lead or Org Admin who needs a tool that isn't allowed presses **Request**. **Members and Viewers never sign in to tools** and don't see the Connectors page: answers in a group use that group's connections, and the group's page lists them (**Sources**).
- **An account from the client.** Every client engagement has its own tools and logins, so the Team Lead connects with the account the client gave the team. Everyone in the group will see what this account can read. Best: a **read-only account the client provides for Sidekick**. Sidekick sees exactly what that account can see, nothing more. If not everyone on the team may open everything that account can, choose **Each person signs in** (Jira and Azure DevOps, see "Who sees what" below).

## How it works: the Org Owner allows, each group connects, Team Leads can ask
1. **The Org Owner allows tool types.** On **Connectors**, every tool has an **Allowed / Not allowed** switch (only the Org Owner sees it). Switching one on doesn't sign in to anything: it lets the groups connect it.
2. **Each group connects with its own client's account.** Under an allowed tool, the Team Lead presses **Connect … for a group**, picks the group, reads the account note, and signs in with the client's account (the steps for each tool are below). Each group's connection is its own: two groups using Jira have two separate connections, usually to two different client sites, and one group's connection never feeds another group.
3. **Then they link projects** (see "Link a project to a group").
4. **Team Leads ask for a tool that isn't allowed.** They see **Request**: they pick their group, can add a short reason ("the client tracks the cutover in Jira") and press **Send request**. The Org Owner gets it on **Home** under Needs attention, at the top of **Connectors** (Requests to allow tools) and, if Teams is set up and they chat with Sidekick there, as a Teams message.
   - **Approve** allows the tool type for the organization. The person who asked is told (Home, Connectors and Teams) and connects it for their group.
   - **Decline** can carry a short note, which the person who asked sees.
   - A group can have one open request per tool. The person who asked (or the Org Owner) can **cancel** it while it's waiting. After a decline, they can ask again.
   - Org Admins can ask for any group, and see every request, but only the Org Owner decides.
5. **Switching a tool type off** (Org Owner) asks first, listing every group connected to it, then disconnects all of them: Sidekick stops syncing, forgets their sign-ins and removes everything it read. Past requests stay listed for 30 days.

Your plan decides how many tool types can be allowed: on a plan without connectors (Starter) the switches are off and Team Leads can't ask; on a plan that's full, they can still ask, and approving tells the Org Owner how to upgrade.

## Connect Azure DevOps
1. Open **Connectors** in the portal and scroll to **Azure DevOps** (or click its tile).
2. Press **Connect Azure DevOps for a group**, pick the group and type the client's **Azure DevOps organization**: the name after `dev.azure.com/` (for `https://dev.azure.com/northwind` that's `northwind`).
3. Press **Sign in and connect** and sign in with the client's Microsoft work account. Approve the read-only access ("read your work items").
4. You're back on Connectors, with the group's Azure DevOps connection **Healthy**.

The Azure DevOps organization must be connected to the client's Microsoft Entra ID (most company organizations are). If the client's IT team has to approve new apps, they may need to approve Sidekick once.

## Connect Jira
1. Open **Connectors** and scroll to **Jira**.
2. Press **Connect Jira for a group** and pick the group. If the account can open more than one Jira site, type the one to use: the name before `.atlassian.net` (for `https://northwind.atlassian.net` that's `northwind`). With one site, leave it empty.
3. Press **Sign in and connect**, sign in with the client's Atlassian account and **Accept** the read-only access.

## Connect GitHub
1. **Install the Sidekick app on your GitHub organization first** (once): someone who owns the organization on GitHub opens the Sidekick GitHub App's page, presses **Install** and picks the repositories Sidekick may read (all, or only some). The app asks only to *read* issues, pull requests and repository basics.
2. Open **Connectors** and scroll to **GitHub**. There's nothing to type.
3. Press **Connect GitHub for a group**, pick the group, press **Sign in and connect**, sign in with your GitHub account and **Authorize** it.

Only repositories the app is installed on, and that your own GitHub account can open, can be linked. Removing a repository from the installation (or uninstalling the app) stops Sidekick reading it.

## Connect Confluence
1. Open **Connectors** and scroll to **Confluence**.
2. Press **Connect Confluence for a group** and pick the group. If the account can open more than one Atlassian site, type the one to use (the name before `.atlassian.net`). With one site, leave it empty.
3. Press **Sign in and connect**, sign in with your Atlassian account and **Accept** the read-only access. Connecting Confluence is separate from connecting Jira, even on the same site.

## Connect Microsoft 365 (SharePoint and OneDrive)
1. Open **Connectors** and click the **SharePoint** or **OneDrive** tile (both open the **Microsoft 365 files** panel). There's nothing to type.
2. Press **Connect Microsoft 365 files for a group**, pick the group, press **Sign in and connect** and sign in with your Microsoft **work** account.
3. Microsoft asks to let Sidekick **read** sites and files you can open (Sites.Read.All, Files.Read.All). Reading SharePoint needs a **Microsoft admin's approval once for your organization**: if you are one, tick "Consent on behalf of your organization" and **Accept**; if not, Microsoft says an admin must approve. Ask your Microsoft 365 admin to connect once themselves (or to approve Sidekick in the Microsoft Entra admin center). After that, the group can connect.
4. Use the account the client gave you: it's usually in the client's own Microsoft organization, which is fine (it doesn't have to be your firm's).

Sidekick reads only what the account that connected can open, and never changes, moves, shares or deletes a file.

## Link a project to a group
A tool that's on doesn't feed any group until you link a project to it, so each group only learns from its own engagement's board, repository or space.
1. On **Connectors**, under the group's connection, press **Link a project** (GitHub: **Link a repository**, Confluence: **Link a space**, Microsoft 365: **Link a library or folder**).
2. Pick the **project** (Azure DevOps), **project key** (Jira, e.g. `STORE`), **repository** (GitHub, e.g. `northwind/store-pos`), **space** (Confluence) or **library or folder** (Microsoft 365: a whole SharePoint document library like "Store Operations › Documents", one of its top-level folders, or a OneDrive folder someone shared with you), and the **group**.
3. Choose who may see its items in answers:
   - **Internal (team only)**, the default, or
   - **Shareable (also with client guests)**, for a board your client can see anyway.

The project feeds the group whose connection it's read through; the **group** is fixed by the connection.
4. Press **Link and sync**. Sidekick reads the project's work items straight away and shows how many it read.

Team Leads see, connect and link only for the groups they belong to. Everyone else sees which connections and projects feed their own groups and whether they're healthy.

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
- **Sign-in expired**: the tool's sign-in ran out or was revoked (for example the person who connected it left, or an admin removed the app). Syncing pauses until the group's Team Lead (or an admin) presses **Reconnect** and signs in again with the client's account (Home shows it under Needs attention); the items already read stay until then.

## Who sees what: one shared account, or each person signs in
Every group's connection has a **Who sees what** setting on Connectors (the group's Team Lead or an admin changes it):
- **One shared account** (the default): everyone in the group sees what the connection's account can read. Fine when the whole team may open the whole board anyway.
- **Each person signs in** (Jira and Azure DevOps): the group's account still keeps Sidekick up to date, but an answer only uses a ticket or work item **the person asking can open with their own account**. Use it when some issues have a security level, some Azure DevOps areas are restricted, or not everyone on the team has the same access.

When a group uses **Each person signs in**:
1. Everyone in the group (Viewers too) opens **Knowledge** and, under **Your sign-ins to tools**, presses **Connect your Jira** (or Azure DevOps) and signs in with **their own** account for the client's site. It must be the same Jira site or Azure DevOps organization the group is connected to. Sidekick only reads and stores no password; the sign-in is kept encrypted and renewed by itself.
2. Until someone connects, their answers leave that tool out and say so: "Connect your Jira to include its tickets" with a button. In Teams the answer card has the same button.
3. Sidekick checks with the tool, at the moment of the answer, which of the tickets it found the person can open (it remembers each check for 5 minutes). If the tool doesn't answer quickly, the tickets are left out of that answer rather than guessed. A ticket someone can't open is simply not used: the answer doesn't mention that it exists.
4. If a person's own sign-in expires or is revoked, their answers say **"Your Jira sign-in expired"** with **Reconnect**, and the group's Team Lead sees under Needs attention whose sign-ins expired. On Connectors the group's managers see how many people have connected.
5. **In Teams group chats and channels** everyone in the chat reads the answer, so Sidekick only uses tickets **everyone in the chat** has connected and can open. If someone in the chat isn't in the group, is a client guest, hasn't connected, or the chat has more than 20 people, that tool's tickets are left out and the card says so ("not everyone in this chat has connected Jira"). In a 1:1 chat with Sidekick it's just you, like the portal.
6. Things written for the whole group, such as the knowledge map and meeting notes, leave out the tickets of a connection where each person signs in.

Switching back to **One shared account** removes everyone's own sign-ins. **Disconnect your Jira** (Knowledge) removes only yours. Leaving the group, or being removed from the organization, removes yours too.

GitHub, Confluence and Microsoft 365 use one shared account for now. GitHub's own permissions are per repository (anyone who may open the repository may open all its issues), so the shared account already matches GitHub. Checking each person's access is planned for Confluence (page restrictions) and SharePoint/OneDrive (file permissions).

## Unlink or switch off
- **Unlink** (on a linked project) removes that project's items from the group's knowledge. The connection stays.
- **Disconnect** (the group's Team Lead or an admin, on the group's connection) forgets that group's sign-in and removes every project and item it read. Other groups' connections are untouched.
- **Switching a tool type off** (the Org Owner's switch) disconnects every group's connection of it and forgets their sign-ins and removes every linked project and every item Sidekick read from it, from every group. Answers stop citing them straight away.
- Deleting a group removes the projects linked to it and their items. Ending your organization's plan removes everything, as for all other data.

## Good to know
- **Walls hold.** Each group's connection, its sign-in (and everyone's own sign-ins to it) and what it read belong to that group only. Work items belong to the group their project is linked to, exactly like documents: other groups, other organizations and the Sidekick assistant of someone outside the group never see them. Client guests only ever see items from projects marked Shareable.
- **Nothing is written back.** Sidekick asks only for read access in every tool.
- **Each sync reads at most 2,000 changed items** (Confluence: 1,000 pages; Microsoft 365: 200 files); a very large board, repository, space or library catches up over a few syncs.
- **Deleted items**: a work item, issue or page deleted in the tool stays in Sidekick until you unlink and link the project again. Microsoft 365 is different: deleted files leave on the next sync by themselves.
- The activity of each sync (how long, how many items) appears on the **Activity** page under **Connectors**, without any item text.
<!-- help-center:skip -->

## For developers
- Code: `app/src/lib/connectors.ts` (framework: sign-in, sealed tokens and refresh, rate limits, sync, health, access mode and each person's own sign-in), `connector-access.ts` (each person signs in: the question-time check, cache, Teams readers, "my sign-ins"; design in `docs/ARCHITECTURE.md` → Connectors), `connector-requests.ts` (allowing tool types, requests to allow one: approve, decline, cancel, Home findings via the `connector_request` watcher, Teams notices), `connector-ado.ts`, `connector-jira.ts`, `connector-github.ts`, `connector-confluence.ts`, `connector-text.ts`; routes under `app/src/app/api/connectors/`; page `app/src/app/(app)/connectors/`.
- Tests: `app/tests/api.test.mjs` ("connectors: …" and the isolation test) against the fake tools in `app/scripts/fake-tools.mjs`; the demo world allows Azure DevOps, Jira, Confluence and Microsoft 365 (approved through a request), connects them per group (Contoso's four, Litware's own Azure DevOps) and leaves GitHub not allowed with one declined and one waiting request (docs/DEMO.md). Moving the old one-per-organization connections into groups: `CONNECTOR_GROUP_MIGRATION` in `app/src/lib/db.ts` (tested in `app/tests/db.test.mjs`).
- Setting up the real apps: `docs/RUNBOOKS.md` → Connector apps.
<!-- /help-center:skip -->
