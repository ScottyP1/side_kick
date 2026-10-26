# Roles and permissions

Every person in a Sidekick organization has exactly one of five roles. The role decides **what they can do**;
the workspaces they're added to decide **which client work they can see**. This page is the rulebook.

<!-- help-center:skip -->
For developers: an automated test (`app/tests/permissions-matrix.mjs`, run by `npm --prefix app test`) checks
every row below against the real app for every role, so the page and the code can't drift apart.
<!-- /help-center:skip -->

## The roles

| Role | In one line | Sees which workspaces |
|---|---|---|
| **Org Owner** | Runs the whole organization, including sign-in and the company-wide guardrails. One per organization. | All |
| **Org Admin** | Runs people, workspaces and Teams links day to day, and sees Usage & billing (only the Org Owner pays or changes the plan). | All |
| **Team Lead** | A Member who also runs the people side of the workspaces they lead: adds Members and Viewers, takes them off, links Teams chats. Made by Org Owners/Admins. | Only ones they're added to (the ones they lead) |
| **Member** | Does the client work: uploads, adds meetings, asks, updates action items, saves decisions to knowledge. | Only ones they're added to |
| **Viewer** | Reads and asks, never changes anything. | Only ones they're added to |

Separately, the **Sidekick team** uses the **Owner Console** (its own accounts, not a role in any
organization) to set up client organizations and watch platform health. It never sees client documents.

**There's no Billing Admin role any more** (retired in October 2026): only Org Owners and Org Admins see
billing. Anyone who was a Billing Admin became a **Member** with no groups, the change is on Security & audit,
and the Org Owner sees a note on Home ("… was a Billing Admin and is now a Member") for two weeks, or until
they give that person another role. Make them an **Org Admin** if they should keep seeing billing.

## What's in each person's menu

Everyone gets the pages for the client work: **Overview**, **Groups**, **Knowledge & docs**, **Firm library**
(read-only unless you're an admin), **Meetings**, **Memory & gaps**, **Settings** and **Help & support**.

- **Org Owners and Org Admins** also get **Usage & billing**, **Guardrails**, **Activity**
  and **Security & audit**, and Settings shows the **company settings** (Microsoft sign-in, two-step sign-in for
  everyone, branding, export and roll-offs) as well as **My account**.
- **Team Leads** also get **Connectors** and **Users & access** (for the groups they lead).
- **Members and Viewers**: Settings is just **My account**. Each group's page shows which tools feed it
  ("Sources"), and **Help & support** lists the rules Sidekick follows.

Typing the address of a page that isn't in your menu shows a short message saying who can use it.

## Who can do what

✓ = allowed. Workspace actions also need the person to be in that workspace (Org Owners and Org Admins
are in all of them). Anything not allowed is refused with a message naming who can do it, e.g. "Only the
Org Owner can do this" or "Only Org Owners and Org Admins can do this". Pages a role can't
use (Usage & billing, Guardrails, Connectors, Activity, Security & audit) show the same kind of message instead of their content.

| What | Org Owner | Org Admin | Team Lead | Member | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| **Everyone signed in** | | | | | |
| See the home page, their profile and their groups (workspaces) | ✓ | ✓ | ✓ | ✓ | ✓ |
| See who's in their groups (emails: admins and the group's Team Lead only) | ✓ | ✓ | ✓ | ✓ | ✓ |
| See live status on the home page (names of who's active: admins only) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Use the home assistant (it only offers actions their role allows) | ✓ | ✓ | ✓ | ✓ | ✓ |
| See the rules Sidekick follows (Help & support: locked rules, the organization's switches On/Off, how many extra rules apply, no rule text) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Settings → My account: password, two-step sign-in, where they're signed in | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Inside their workspaces: read** | | | | | |
| Read documents, meetings, notes and the knowledge map | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ask Sidekick questions (portal and Teams), with follow-ups | ✓ | ✓ | ✓ | ✓ | ✓ |
| Rate answers 👍/👎 (portal and Teams) | ✓ | ✓ | ✓ | ✓ | ✓ |
| See the firm library (the organization's policies and standards) | ✓ | ✓ | ✓ | ✓ | ✓ |
| See which tools feed their group (the group page's Sources line: tool, name, last sync) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Open Connectors: which tool types the organization allows, their groups' connections, health and linked projects (only the connecting Team Lead or admin ever signs in to a tool) | ✓ | ✓ | ✓ (own groups) | | |
| See a group's last 30 days on its page (questions, answers, meetings, documents, share of AI use) | ✓ | ✓ | ✓ (own groups) | | |
| **Inside their workspaces: change** | | | | | |
| Upload, rename or delete documents | ✓ | ✓ | ✓ | ✓ | |
| Keep or move a held document (one that may be another client's) to another of their groups | ✓ | ✓ (any group) | ✓ (own groups) | ✓ (own groups) | |
| Confirm a kept document belongs in its group (**It belongs here**) | ✓ | ✓ | ✓ (own groups) | | |
| Add a past or outside meeting, reprocess or delete meetings | ✓ | ✓ | ✓ | ✓ | |
| Save a meeting's decisions, requirements, risks and facts to knowledge (portal, Teams card and tab) | ✓ | ✓ | ✓ | ✓ | |
| See the automatic-notes panel and their groups' captured Teams meetings | ✓ | ✓ | ✓ | ✓ | ✓ |
| See skipped Teams meetings and pick the group for one several groups were in | ✓ | ✓ | ✓ (own groups) | | |
| See their groups' upcoming meetings that will record by themselves | ✓ | ✓ | ✓ | ✓ | ✓ |
| Update action items (portal and Teams card buttons) | ✓ | ✓ | ✓ | ✓ | |
| Refresh the knowledge map, resolve or dismiss gaps | ✓ | ✓ | ✓ | ✓ | |
| See Needs attention for their groups: action items, unanswered questions, out-of-date documents | ✓ | ✓ | ✓ | ✓ | ✓ |
| See Needs attention about their groups' Teams chats (posts failing, Sidekick removed, no notes chat, pick the notes chat) | ✓ | ✓ | ✓ (own groups) | | |
| See organization-wide Needs attention (chats waiting, groups without a Team Lead, connectors) | ✓ | ✓ | | | |
| See Needs attention about a tool request for their groups (approved: connect it; declined, with the note) | ✓ | ✓ | ✓ (own groups) | | |
| Snooze a Needs attention item for a week | ✓ | ✓ | ✓ (own groups' items) | | |
| **Money** | | | | | |
| See how often Sidekick helped them this month on the home page (a count) | | | ✓ | ✓ | ✓ |
| See the share of this month's AI allowance used, on the home page | ✓ | ✓ | | | |
| See Usage & billing: the whole company's activity counts and AI allowance (a percentage; AI cost and models are never shown) | ✓ | ✓ | | | |
| See the plan and subscription (on Usage & billing) | ✓ | ✓ | | | |
| Export usage per group as CSV (activity counts by engagement code, for chargeback) | ✓ | ✓ | | | |
| See the AI allowance notice (80% used, used up) | ✓ | ✓ | | | |
| Pay for the plan, change it or its extra groups, or cancel it | ✓ | | | | |
| See the note that Sidekick changed someone's role (a retired Billing Admin is now a Member) | ✓ | | | | |
| **Running the organization** | | | | | |
| Create groups (workspaces), picking their client, Team Lead (Team plan and up) and first members | ✓ | ✓ | | | |
| Rename a group, change its client or engagement code, delete it (and everything in it) | ✓ | ✓ | | | |
| End a group when the engagement ends (read-only, deleted on a date) or cancel that | ✓ | ✓ | | | |
| Export a group, or the whole organization's data, as a zip | ✓ | ✓ | | | |
| See roll-offs and download deletion certificates | ✓ | ✓ | | | |
| Add, change or delete firm library documents | ✓ | ✓ | | | |
| Keep, limit to chosen groups or move a held firm library document into a group; choose which groups a firm document applies to | ✓ | ✓ | | | |
| Turn automatic notes after Teams meetings on or off, check now, try a skipped meeting again | ✓ | ✓ | | | |
| Turn "Group meetings record and transcribe by themselves" on or off (Teams also saves a video) | ✓ | ✓ | | | |
| Connect an allowed tool for a group with the account the client gave them, reconnect or disconnect the group's connection | ✓ | ✓ | ✓ (own groups) | | |
| Link projects through a group's connection (repositories, spaces, libraries), sync now or unlink | ✓ | ✓ | ✓ (own groups) | | |
| Ask the Org Owner to allow a tool type for their group (with a reason), see the request's status, cancel their own | | ✓ | ✓ (own groups) | | |
| See every request to allow a tool type | ✓ | ✓ | ✓ (own groups') | | |
| See answer quality (👍/👎 and "I don't know" counts, no text) | ✓ | ✓ | | | |
| Add people to their groups or take them off, change which of them a person is in | ✓ | ✓ | ✓ (Members and Viewers, own groups; not themselves) | | |
| Change roles, remove people from the organization | ✓ | ✓ | | | |
| Link, change or unlink Teams channels and chats (turning reminders on: Team plan and up) | ✓ | ✓ | ✓ (own workspaces) | | |
| Choose which chats get a group's meeting notes ("Meeting notes go to" in the portal, or "@Sidekick post meeting notes here" in the chat; everyone in the group sees it) | ✓ | ✓ | ✓ (own groups) | | |
| Send a test message to one of a group's chats (to see where notes will land; once per chat per minute) | ✓ | ✓ | ✓ (own groups) | | |
| Add Sidekick to a Teams chat (anyone else: Sidekick leaves) | ✓ | ✓ | ✓ | | |
| See and assign Teams chats waiting to be assigned (portal only) | ✓ | ✓ | ✓ (chats they added, to own groups) | | |
| Remove Sidekick from a Teams chat | ✓ | ✓ | ✓ (own groups' chats, or waiting chats they added) | | |
| Import people from Microsoft 365 | ✓ | ✓ | ✓ (Members and Viewers, own workspaces) | | |
| `@Sidekick add` / `remove @name` in a linked Teams chat | ✓ | ✓ | ✓ (Members and Viewers, that chat's workspace if they lead it) | | |
| See the Microsoft permissions checklist (Settings → Microsoft permissions) | ✓ | ✓ | ✓ (read-only) | | |
| Approve Sidekick for the company's Microsoft 365 (starts Microsoft's admin approval), and Check now on Microsoft permissions | ✓ | ✓ | | | |
| See the audit log and Activity (traces, performance) | ✓ | ✓ | | | |
| Change branding (logo, brand color) | ✓ | ✓ | | | |
| Make a workspace's guardrails stricter, write custom rules (Team plan and up), use "Test it" | ✓ | ✓ | | | |
| **Org Owner only** | | | | | |
| Turn company-wide guardrail switches on or off | ✓ | | | | |
| Connect, require (Business plan and up) or disconnect Microsoft sign-in | ✓ | | | | |
| Allow or stop a tool type for the organization (a switch on Connectors, no sign-in; stopping disconnects every group's connection of it; within the plan's connectors) | ✓ | | | | |
| Approve (allows the type) or decline (with a note) a request to allow a tool type; see pending requests on Home | ✓ | | | | |

## Rules that always hold

- **Walls first.** Nobody sees a workspace they aren't in; asking for one returns "not found", so people
  can't even tell it exists. Organizations never see each other at all.
- **Role before data.** Every change checks the role first, so a refused person learns nothing about
  what exists.
- **No one makes an Org Owner** from Users & access, and the Org Owner can't be changed or removed there.
  Org Admins can add other Org Admins and make Team Leads (also by picking a Member or Viewer as a new group's Team Lead).
- **The plan decides some features, the role decides who uses them.** The **Team Lead** role, reminders in
  Teams chats and custom guardrail rules come with the Team plan and up; requiring Microsoft sign-in with
  Business and up. On a plan without one, nobody can switch it on, whatever their role ("Your Starter plan
  doesn't include Team Leads…"). Moving to a smaller plan never takes it away from what already uses it:
  existing Team Leads keep the role and everything it allows, existing rules and reminders keep working, and
  required Microsoft sign-in stays on. Organizations without a subscription (set up by the Sidekick team)
  and Enterprise have every feature. Details: admin guide, section 16.
- **Nobody changes their own role or removes themselves.** An Org Admin who wants a different role, or to
  leave, asks the Org Owner or another Org Admin, so nobody locks themselves out by accident.
- **Temporary passwords first.** Someone added with a temporary password can do nothing but choose a new
  password (or sign out) until they do; every other request is refused. Signing in with Microsoft clears it.
- **Password guessing is slowed down.** 5 wrong passwords for one email (or 20 from one network address)
  in 15 minutes pause password sign-in for 15 minutes. Failed sign-ins and sign-outs go to the audit log.
  Users & access marks a paused person **Sign-in locked**; an Org Owner or Org Admin can press **Unlock**
  (audited), for example when someone else's guessing locked them out.
- **A new password signs you out everywhere else.** Changing your password ends your sessions on every other
  browser and device, and the new password must differ from the old one.
- **Changes only from Sidekick's own pages.** A change (anything but reading) sent by another website is
  refused, and Sidekick can't be shown inside another site's frame.
- **Team Leads stay inside their workspaces.** They only see, add and take off people in the workspaces
  they lead, can only give the Member or Viewer role, and can't change roles, remove anyone from the
  organization, create workspaces, or open admin pages.
- **AI use is personal unless you handle billing.** Every AI call is recorded with the person it was for
  (in the portal, or from a linked Microsoft account in Teams). Members and Viewers see only their own;
  Org Owners and Org Admins see the company total. Work Sidekick does on its own, and
  questions from Teams guests, count only toward the company total.
- **A lapsed plan makes everything read-only, for every role.** When a free trial ends unpaid, a failed
  payment isn't fixed within 7 days, or a canceled plan runs out, everyone can still sign in and see
  everything, but nothing can be added or changed and Sidekick doesn't answer (portal, Teams, assistant).
  The Org Owner can still pay, which turns everything back on.
- **Client guests** in a Teams chat only ever get answers from Shareable documents, whatever the asker's role.
- **Same rules everywhere.** The portal, Teams and the home assistant use the same checks; the assistant
  never offers an action the role can't do, and the server refuses it again if it tried.
- **Guardrails can only get stricter** below the company level: a workspace or a custom rule can add
  limits, never remove the locked floor.

<!-- help-center:skip -->
## Changing a rule

Change the code, the matching row in `app/tests/permissions-matrix.mjs`, and this page together; the test
fails if any of the three disagree.
<!-- /help-center:skip -->
