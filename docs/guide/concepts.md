# Sidekick concepts

Sidekick is an AI teammate for consulting teams. It reads your project's documents and meeting transcripts, answers questions with sources, writes meeting notes, and keeps track of what the team knows and doesn't. These are the ideas behind it.

## Organization
Your company's Sidekick account. Everything in it (people, workspaces, documents, meetings) is completely separate from every other organization. Nothing is shared between organizations, ever.

## Group (workspace)
One client team, like "Payments Platform" for the client Northwind Bank. The portal calls it a **group**; some screens still say workspace, which means the same thing. Each group has a **Team Lead** who runs it day to day. Each workspace has its own documents, meetings, memory and members. **Sidekick only ever searches the workspace you're in**, so an answer for one client can never use another client's material.

## People and roles

The full rulebook, with every action and which roles may do it, is [Roles and permissions](roles-and-permissions.md).
| Role | Can do |
|---|---|
| **Org Owner** | Everything, including the organization itself |
| **Org Admin** | People, workspaces, Teams channels, usage and the audit log, across all workspaces |
| **Team Lead** | Everything a Member can do, plus the people side of the workspaces they lead (the ones they belong to): add people to them as Member or Viewer, take people off them, and link Teams chats to them. Can't create workspaces or organizations, change anyone's role, remove people from the organization, or see other workspaces |
| **Billing Admin** | Usage and billing only |
| **Member** | Work inside the workspaces they belong to: upload, import meetings, ask, update action items |
| **Viewer** | Read-only inside the workspaces they belong to |

Owners and Admins see every workspace. Everyone else, Team Leads included, sees only the workspaces they've been added to. Only an Org Owner or Org Admin can make someone a Team Lead.

The workspace you're in shows at the top of the pages that belong to one workspace (**Knowledge & docs**, **Meetings**, **Memory & gaps**). If you're in just one workspace it's a plain label; if you're in two or more it's a small menu to switch between them. Org-wide pages (Overview, Usage & billing, Users & access, Activity, Security & audit, Settings and the rest) don't show a workspace at all.

## Using Sidekick on a phone
On a phone (or any narrow window) the sidebar makes way for two things:
- A **tab bar** floating at the bottom with the pages you use most: **Home**, **Groups**, **Knowledge** and **Meetings**, plus **Ask**, which opens the assistant and "I need help" (it replaces the round button, and shows the same dot when the Sidekick team has replied to you). If you're not in a group yet (a Billing Admin, for example), the tabs are **Home**, **Usage** (if your role pays the bills), **Settings** and **Help** instead.
- The **menu button** (three lines, top left) opens everything else: every page your role can use (the same list as the sidebar), the switcher between your groups if you're in two or more, and **Sign out**. Tap outside it, press the ✕ or Escape to close it.

## Sources and citations
When Sidekick answers, it first searches the group, and your organization's **firm library**, for the passages most related to your question (by keyword and by meaning, so different wording still finds the right passage), then answers **only from those passages**. Every claim is tagged with its source, like **[S1]**, and the source list shows the document or meeting, the page or timestamp, its date and a short excerpt. Sources from the firm library are labelled **Firm policy**. If two sources disagree, Sidekick says so ("the sources disagree") and cites both.

Before answering, Sidekick puts the passages it found in order of how well they fit your whole question, and:
- **Newer wins**: on the same topic a recent meeting or document counts a little more than an old one.
- **Out of date is flagged**: a firm document marked *superseded*, or a group document with a newer version uploaded (same name apart from "v2", "final" or a date), counts less and is shown as "may be out of date".
- **Notes first**: the meeting notes Sidekick wrote (summary and decisions) come before raw transcript lines, which are still there for the detail.
- **No duplicates**: the same document uploaded twice, or a chat reply quoting the message it answers, is used once.
- **Policy vs. project**: for policy questions (expenses, travel, approvals, rate cards, data handling) the firm library comes first; for facts about the engagement, the group's own sources do.

**Filters** in Ask narrow the sources to documents, meetings, Teams chats, decisions & notes or the firm library, and to a date range.

## Firm library
Your organization's own policies, standards, templates, methods and rate-card rules, kept once for the whole organization on the **Firm library** page and used in **every** group's answers (cited as "Firm policy · Expense policy v3"). Groups still never see each other's documents. Each firm document has a title, an **Internal**/**Shareable** tag (client guests only ever see Shareable ones), an optional **effective date**, and can be marked **superseded** by a newer one. Everyone can see the list; Org Owners and Org Admins manage it. Firm documents count toward your plan's document limit.

## Follow-up questions
Ask builds on your last questions in the same group, so "and wave 3?" after "When is the wave 2 cutover?" is understood as "When is the wave 3 cutover?". The answer shows **Following up on "…"**; press **New question** to start afresh. Your conversation is yours alone, in one group (and one guests setting): nobody else can continue it, and it's forgotten 24 hours after your last question. Guardrails check every turn, so a refused topic can't be reached with a short follow-up. In Teams, a follow-up is a reply in the same channel thread, or a message in the same chat within 30 minutes.

## 👍/👎 on answers
Every answer has **👍 Helpful** and **👎 Not helpful** (portal and Teams). Org Owners and Org Admins see the counts for the last 30 days under Ask; the Sidekick team sees the trend per organization. Only counts are kept with a vote, never the question or answer.

## "I couldn't find that" and knowledge gaps
If the workspace doesn't contain the answer, Sidekick says so instead of guessing. The question is saved as a **knowledge gap** so someone can fill it in, for example by uploading the missing document. Gaps also come from questions nobody answered in a meeting, conflicting facts, out-of-date documents, and decisions that only exist in a transcript.

## Needs attention (watchers)
Sidekick keeps an eye on each group in the background, every 15 minutes, and lists what needs a person under **Needs attention** on Home and on the group's Overview tab. Each item says what's wrong and the **next step**, with a button to the page that fixes it. It watches for:
- questions Sidekick couldn't answer (in the last two weeks),
- Teams chats where Sidekick's posts (answers, notes, reminders) stopped getting through,
- Teams chats waiting to be assigned to a group, and chats someone removed Sidekick from in Teams,
- action items past their due date, and action items nobody owns two days after the meeting,
- documents a newer meeting decision seems to change ("may be out of date"),
- groups without a Team Lead (plans with Team Leads) or without a Teams chat for meeting notes,
- connectors (such as Jira or Azure DevOps) that stopped working.

Each problem is one item, however long it lasts, and it **clears itself** once it's fixed. You only see items for your own groups: everyone in a group sees its action items, unanswered questions and out-of-date documents; the group's Team Lead and the admins also see its Teams problems; organization-wide items (chats waiting, groups without a lead, connectors) are for Org Owners and Org Admins. Admins and the group's Team Lead can **Snooze** an item for a week; it comes back if it's still there. The checks themselves use no AI; only the "may be out of date" check asks the AI, and only about a document and decision that already look related.

## Guardrails
Rules Sidekick follows in every answer, everywhere (portal, Teams, the home assistant). Some are **locked** and always on: no hate, racism, bias, harassment, sexual content or help with harm; it can't be talked out of its rules ("ignore your instructions", "pretend you have no rules"); it never crosses into another workspace or organization; and it only states project facts it can cite, otherwise it says **"I don't know"**. The Org Owner can add stricter **switches** for the whole organization (swearing, small talk, judging people, HR/legal/medical questions, contact details, competitors). Each question is checked before it's answered, and each answer is checked again before you see it: an answer without a real source becomes "I don't know", swear words are masked, and contact details are hidden when that switch is on.

On top of that, Org Owners and Admins can:
- make **one workspace stricter** than the rest by turning on extra switches just for it (for example "No talk about competitors" for one sensitive client). A workspace can never be looser than the organization.
- write **custom rules** in plain language, such as "Never quote day rates", for the whole organization or one workspace (up to 20 each). Custom rules can only add restrictions: a rule that tries to loosen the guardrails ("ignore the rules for managers", "you may swear") is refused when it's saved, with the reason. Every version of a rule is kept.

A question refused by a custom rule gets a fixed reply ("Your organization has a rule that stops me from answering this here…", pointing people to an Org Owner or Admin if that seems wrong) that doesn't repeat the rule, because client guests may see it in Teams.

## Knowledge map and coverage
On **Memory & gaps**, Sidekick groups what a workspace knows into topics. Each topic has a **coverage** score from 0 to 100: high means it's well documented and consistent, low means it's mostly been talked about but not written down.

## Meeting notes and action items
Import a meeting transcript (a Teams `.vtt` file, a Word document or pasted text) and Sidekick writes the notes: a summary, decisions, **action items** (with owners and due dates as spoken), open questions, and lasting facts like requirements, risks and terms. Action items can be assigned and closed in the portal or straight from the card in Teams.

## Internal and Shareable, and client guests
Every document is tagged:
- **Internal**: for your team only (rates, staffing, internal risks).
- **Shareable**: fine to use when the client is in the room.

When **client guests are present** (in a meeting marked "Client guests attended", or a Teams channel marked as having client guests), Sidekick only uses Shareable sources, from the group and from the firm library. Notes from an internal-only meeting are never posted to a channel that has client guests.

## Sidekick in Teams
Sidekick can be added to Teams channels and chats. Each channel or chat is **linked to one workspace** by an admin, and Sidekick only answers from that workspace there. See [Sidekick in Teams](teams-guide.md).

## The in-app assistant
The chat box under the crystal ball on the home page, also behind the **round button in the bottom-left corner** of every portal page, or **Ask** in the tab bar on a phone (same conversation in all of them). Follow-ups build on what you just said ("and for wave 3?"), for 24 hours or until you press **New conversation**. Ask it how Sidekick works ("how do I import a meeting?", "what can a Viewer do?") or ask it to do something: create a workspace, add a person, link a Teams chat, refresh a knowledge map, or open a page. While it thinks, the dust inside the ball swirls and the reply bubble shows what it's working on. It only offers what your role allows, and it never changes anything by itself: it shows a card with exactly what will happen, and nothing happens until you press **Confirm** (Cancel leaves everything as it was). Confirmed actions are recorded in the audit log like any other. For questions about a project's content, use **Ask Sidekick** on Knowledge & docs, which answers from your sources with citations. It only knows **your** organization and the workspaces you can use (names and counts, never document text), so it can't tell you about another client. Nobody can create a new client organization from the assistant, whatever their role: the Sidekick team sets those up in the Owner Console.

## Audit log
Sign-ins, access changes, uploads, deletions, Teams links and every action Sidekick takes on its own are recorded on **Security & audit**, with who did it and when.

## Usage and cost
Each AI request is metered: how much text went in and out (tokens), what it cost, and how long it took. **Usage & billing** shows this by feature, workspace and day.

## Help and support
The round button's **I need help** tab is the **Help chat**: it answers from the help center and Sidekick's support articles, checks your own setup (Teams chats, tracking, paused features, plan limits, AI credit, recent errors) and can turn the conversation into a **support ticket** for the Sidekick team. You can also write to them on **Help & support** and follow your tickets there. The Help chat doesn't use your organization's AI credit. On the public website, the same button opens **Ask about Sidekick**, an AI help bot that answers only from public help content and can pass you to a person.

## How your data is protected
- Every request is checked: who you are, your role, and whether you belong to that workspace.
- Every search and every AI request is limited to one organization and one workspace.
- Documents and transcripts are treated as information, never as instructions, so text inside a file can't make Sidekick do something else.
- Questions and answers go through your organization's **guardrails** (see above), and automated tests plant a secret in one workspace and check it can't be reached from another workspace, another organization, Teams or the assistant.
- Sign in with your Microsoft work account (your company's password rules and MFA apply), or with a password, which is stored only as a secure hash. Your Org Owner can require Microsoft sign-in for everyone.
