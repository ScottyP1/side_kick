# Roles and permissions

Every person in a Sidekick organization has exactly one of six roles. The role decides **what they can do**;
the workspaces they're added to decide **which client work they can see**. This page is the rulebook.

<!-- help-center:skip -->
For developers: an automated test (`app/tests/permissions-matrix.mjs`, run by `npm --prefix app test`) checks
every row below against the real app for every role, so the page and the code can't drift apart.
<!-- /help-center:skip -->

## The roles

| Role | In one line | Sees which workspaces |
|---|---|---|
| **Org Owner** | Runs the whole organization, including sign-in and the company-wide guardrails. One per organization. | All |
| **Org Admin** | Runs people, workspaces and Teams links day to day. | All |
| **Team Lead** | A Member who also runs the people side of the workspaces they lead: adds Members and Viewers, takes them off, links Teams chats. Made by Org Owners/Admins. | Only ones they're added to (the ones they lead) |
| **Billing Admin** | Watches usage and AI spend, and pays for, changes or cancels the plan. Changes no content. | Only ones they're added to (usually none) |
| **Member** | Does the client work: uploads, adds meetings, asks, updates action items, saves decisions to knowledge. | Only ones they're added to |
| **Viewer** | Reads and asks, never changes anything. | Only ones they're added to |

Separately, the **Sidekick team** uses the **Owner Console** (its own accounts, not a role in any
organization) to set up client organizations and watch platform health. It never sees client documents.

## Who can do what

✓ = allowed. Workspace actions also need the person to be in that workspace (Org Owners and Org Admins
are in all of them). Anything not allowed is refused with a message naming who can do it, e.g. "Only the
Org Owner can do this" or "Only Org Owners, Org Admins and Billing Admins can do this". Pages a role can't
use (Usage & billing, Activity, Security & audit) show the same kind of message instead of their content.

| What | Org Owner | Org Admin | Team Lead | Billing Admin | Member | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| **Everyone signed in** | | | | | | |
| See the home page, their profile and their groups (workspaces) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See who's in their groups (emails: admins and the group's Team Lead only) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See live status on the home page (names of who's active: admins only) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Use the home assistant (it only offers actions their role allows) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See the guardrails in force | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Inside their workspaces: read** | | | | | | |
| Read documents, meetings, notes and the knowledge map | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ask Sidekick questions (portal and Teams), with follow-ups | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Rate answers 👍/👎 (portal and Teams) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See the firm library (the organization's policies and standards) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See which tools are on for the organization (Azure DevOps, Jira, GitHub, Confluence, Microsoft 365), their health and the projects feeding their groups | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Inside their workspaces: change** | | | | | | |
| Upload, rename or delete documents | ✓ | ✓ | ✓ | | ✓ | |
| Add a past or outside meeting, reprocess or delete meetings | ✓ | ✓ | ✓ | | ✓ | |
| Save a meeting's decisions, requirements, risks and facts to knowledge (portal, Teams card and tab) | ✓ | ✓ | ✓ | | ✓ | |
| See the automatic-notes panel and their groups' captured Teams meetings | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See skipped Teams meetings and pick the group for one several groups were in | ✓ | ✓ | ✓ (own groups) | | | |
| Update action items (portal and Teams card buttons) | ✓ | ✓ | ✓ | | ✓ | |
| Refresh the knowledge map, resolve or dismiss gaps | ✓ | ✓ | ✓ | | ✓ | |
| See Needs attention for their groups: action items, unanswered questions, out-of-date documents | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See Needs attention about their groups' Teams chats (posts failing, Sidekick removed, no notes chat) | ✓ | ✓ | ✓ (own groups) | | | |
| See organization-wide Needs attention (chats waiting, groups without a Team Lead, connectors) | ✓ | ✓ | | | | |
| See Needs attention about a tool request for their groups (approved: link it; declined, with the note) | ✓ | ✓ | ✓ (own groups) | | | |
| Snooze a Needs attention item for a week | ✓ | ✓ | ✓ (own groups' items) | | | |
| **Money** | | | | | | |
| See their own AI use this month on the home page | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See Usage & billing and the whole company's AI spend | ✓ | ✓ | | ✓ | | |
| See the plan and subscription (on Usage & billing) | ✓ | ✓ | | ✓ | | |
| Export usage per group as CSV (AI cost by engagement code, for chargeback) | ✓ | ✓ | | ✓ | | |
| See the AI credit notice (80% used, used up) | ✓ | ✓ | | ✓ | | |
| Pay for the plan, change it or its extra groups, or cancel it | ✓ | | | ✓ | | |
| **Running the organization** | | | | | | |
| Create groups (workspaces), picking their client, Team Lead (Team plan and up) and first members | ✓ | ✓ | | | | |
| Rename a group, change its client or engagement code, delete it (and everything in it) | ✓ | ✓ | | | | |
| End a group when the engagement ends (read-only, deleted on a date) or cancel that | ✓ | ✓ | | | | |
| Export a group, or the whole organization's data, as a zip | ✓ | ✓ | | | | |
| See roll-offs and download deletion certificates | ✓ | ✓ | | | | |
| Add, change or delete firm library documents | ✓ | ✓ | | | | |
| Turn automatic notes after Teams meetings on or off, check now, try a skipped meeting again | ✓ | ✓ | | | | |
| Reconnect a tool that's on when its sign-in expired | ✓ | ✓ | | | | |
| Link a tool that's on to their groups (pick projects, repositories, spaces, libraries), sync it now or unlink it | ✓ | ✓ | ✓ (own groups) | | | |
| Ask the Org Owner to turn a tool on for their group (with a reason), see the request's status, cancel their own | | ✓ | ✓ (own groups) | | | |
| See every request to turn a tool on | ✓ | ✓ | ✓ (own groups') | | | |
| See answer quality (👍/👎 and "I don't know" counts, no text) | ✓ | ✓ | | | | |
| Add people to their groups or take them off, change which of them a person is in | ✓ | ✓ | ✓ (Members and Viewers, own groups; not themselves) | | | |
| Change roles, remove people from the organization | ✓ | ✓ | | | | |
| Link, change or unlink Teams channels and chats (turning reminders on: Team plan and up) | ✓ | ✓ | ✓ (own workspaces) | | | |
| Add Sidekick to a Teams chat (anyone else: Sidekick leaves) | ✓ | ✓ | ✓ | | | |
| See and assign Teams chats waiting to be assigned (portal only) | ✓ | ✓ | ✓ (chats they added, to own groups) | | | |
| Remove Sidekick from a Teams chat | ✓ | ✓ | ✓ (own groups' chats, or waiting chats they added) | | | |
| Import people from Microsoft 365 | ✓ | ✓ | ✓ (Members and Viewers, own workspaces) | | | |
| `@Sidekick add` / `remove @name` in a linked Teams chat | ✓ | ✓ | ✓ (Members and Viewers, that chat's workspace if they lead it) | | | |
| Approve Sidekick for the company's Microsoft 365 (starts Microsoft's admin approval) | ✓ | ✓ | | | | |
| See the audit log and Activity (traces, performance) | ✓ | ✓ | | | | |
| Change branding (logo, brand color) | ✓ | ✓ | | | | |
| Make a workspace's guardrails stricter, write custom rules (Team plan and up), use "Test it" | ✓ | ✓ | | | | |
| **Org Owner only** | | | | | | |
| Turn company-wide guardrail switches on or off | ✓ | | | | | |
| Connect, require (Business plan and up) or disconnect Microsoft sign-in | ✓ | | | | | |
| Turn a tool on or off for the organization (the toggle on Connectors: on = its one-time sign-in; off = removes its sign-in and everything it read; within the plan's connectors) | ✓ | | | | | |
| Approve (turns the tool on) or decline (with a note) a request to turn a tool on; see pending requests on Home | ✓ | | | | | |

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
  Org Owners, Org Admins and Billing Admins see the company total. Work Sidekick does on its own, and
  questions from Teams guests, count only toward the company total.
- **A lapsed plan makes everything read-only, for every role.** When a free trial ends unpaid, a failed
  payment isn't fixed within 7 days, or a canceled plan runs out, everyone can still sign in and see
  everything, but nothing can be added or changed and Sidekick doesn't answer (portal, Teams, assistant).
  Org Owners and Billing Admins can still pay, which turns everything back on.
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
