# Roles and permissions

Every person in a Sidekick organization has exactly one role. The role decides **what they can do**;
the workspaces they're added to decide **which client work they can see**. This page is the rulebook,
and an automated test (`app/tests/permissions-matrix.mjs`, run by `npm --prefix app test`) checks every
row below against the real app for every role, so the page and the code can't drift apart.

## The roles

| Role | In one line | Sees which workspaces |
|---|---|---|
| **Org Owner** | Runs the whole organization, including sign-in and the company-wide guardrails. One per organization. | All |
| **Org Admin** | Runs people, workspaces and Teams links day to day. | All |
| **Billing Admin** | Watches usage and AI spend. Changes nothing. | Only ones they're added to (usually none) |
| **Member** | Does the client work: uploads, imports meetings, asks, updates action items. | Only ones they're added to |
| **Viewer** | Reads and asks, never changes anything. | Only ones they're added to |

Separately, the **Sidekick team** uses the **Owner Console** (its own accounts, not a role in any
organization) to set up client organizations and watch platform health. It never sees client documents.

## Who can do what

✓ = allowed. Workspace actions also need the person to be in that workspace (Org Owners and Org Admins
are in all of them). Anything not allowed is refused with "Your role doesn't allow this".

| What | Org Owner | Org Admin | Billing Admin | Member | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| **Everyone signed in** | | | | | |
| See the home page, their profile and their workspace list | ✓ | ✓ | ✓ | ✓ | ✓ |
| See live status on the home page (names of who's active: admins only) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Use the home assistant (it only offers actions their role allows) | ✓ | ✓ | ✓ | ✓ | ✓ |
| See the guardrails in force | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Inside their workspaces: read** | | | | | |
| Read documents, meetings, notes and the knowledge map | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ask Sidekick questions (portal and Teams) | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Inside their workspaces: change** | | | | | |
| Upload, rename or delete documents | ✓ | ✓ | | ✓ | |
| Import, reprocess or delete meetings | ✓ | ✓ | | ✓ | |
| Update action items (portal and Teams card buttons) | ✓ | ✓ | | ✓ | |
| Refresh the knowledge map, resolve or dismiss gaps | ✓ | ✓ | | ✓ | |
| **Money** | | | | | |
| See their own AI use this month on the home page | ✓ | ✓ | ✓ | ✓ | ✓ |
| See Usage & billing and the whole company's AI spend | ✓ | ✓ | ✓ | | |
| **Running the organization** | | | | | |
| Create workspaces | ✓ | ✓ | | | |
| See, add, change or remove people (not the Org Owner) | ✓ | ✓ | | | |
| Link, change or unlink Teams channels and chats | ✓ | ✓ | | | |
| See the audit log and Activity (traces, performance) | ✓ | ✓ | | | |
| Change branding (logo, brand color) | ✓ | ✓ | | | |
| Make a workspace's guardrails stricter, write custom rules, use "Test it" | ✓ | ✓ | | | |
| **Org Owner only** | | | | | |
| Turn company-wide guardrail switches on or off | ✓ | | | | |
| Connect, require or disconnect Microsoft sign-in | ✓ | | | | |

## Rules that always hold

- **Walls first.** Nobody sees a workspace they aren't in; asking for one returns "not found", so people
  can't even tell it exists. Organizations never see each other at all.
- **Role before data.** Every change checks the role first, so a refused person learns nothing about
  what exists.
- **No one makes an Org Owner** from Users & access, and the Org Owner can't be changed or removed there.
  Org Admins can add other Org Admins.
- **AI use is personal unless you handle billing.** Every AI call is recorded with the person it was for
  (in the portal, or from a linked Microsoft account in Teams). Members and Viewers see only their own;
  Org Owners, Org Admins and Billing Admins see the company total. Work Sidekick does on its own, and
  questions from Teams guests, count only toward the company total.
- **Client guests** in a Teams chat only ever get answers from Shareable documents, whatever the asker's role.
- **Same rules everywhere.** The portal, Teams and the home assistant use the same checks; the assistant
  never offers an action the role can't do, and the server refuses it again if it tried.
- **Guardrails can only get stricter** below the company level: a workspace or a custom rule can add
  limits, never remove the locked floor.

## Changing a rule

Change the code, the matching row in `app/tests/permissions-matrix.mjs`, and this page together; the test
fails if any of the three disagree.
