# Sidekick concepts

Sidekick is an AI teammate for consulting teams. It reads your project's documents and meeting transcripts, answers questions with sources, writes meeting notes, and keeps track of what the team knows and doesn't. These are the ideas behind it.

## Organization
Your company's Sidekick account. Everything in it (people, workspaces, documents, meetings) is completely separate from every other organization. Nothing is shared between organizations, ever.

## Workspace
One client engagement, like "Contoso Retail – Cloud Migration". Each workspace has its own documents, meetings, memory and members. **Sidekick only ever searches the workspace you're in**, so an answer for one client can never use another client's material.

## People and roles
| Role | Can do |
|---|---|
| **Org Owner** | Everything, including the organization itself |
| **Org Admin** | People, workspaces, Teams channels, usage and the audit log, across all workspaces |
| **Billing Admin** | Usage and billing only |
| **Member** | Work inside the workspaces they belong to: upload, import meetings, ask, update action items |
| **Viewer** | Read-only inside the workspaces they belong to |

Owners and Admins see every workspace. Everyone else sees only the workspaces they've been added to.

## Sources and citations
When Sidekick answers, it first searches the workspace for the passages most related to your question (by keyword and by meaning, so different wording still finds the right passage), then answers **only from those passages**. Every claim is tagged with its source, like **[S1]**, and the source list shows the document or meeting, the page or timestamp, and a short excerpt. If two sources disagree, Sidekick says so and cites both.

## "I couldn't find that" and knowledge gaps
If the workspace doesn't contain the answer, Sidekick says so instead of guessing. The question is saved as a **knowledge gap** so someone can fill it in, for example by uploading the missing document. Gaps also come from questions nobody answered in a meeting, conflicting facts, out-of-date documents, and decisions that only exist in a transcript.

## Guardrails
Rules Sidekick follows in every answer, everywhere (portal, Teams, the home assistant). Some are **locked** and always on: no hate, racism, bias, harassment, sexual content or help with harm; it can't be talked out of its rules ("ignore your instructions", "pretend you have no rules"); it never crosses into another workspace or organization; and it only states project facts it can cite, otherwise it says **"I don't know"**. The Org Owner can add stricter **switches** for the whole organization (swearing, small talk, judging people, HR/legal/medical questions, contact details, competitors). Each question is checked before it's answered, and each answer is checked again before you see it: an answer without a real source becomes "I don't know", swear words are masked, and contact details are hidden when that switch is on.

On top of that, Org Owners and Admins can:
- make **one workspace stricter** than the rest by turning on extra switches just for it (for example "No talk about competitors" for one sensitive client). A workspace can never be looser than the organization.
- write **custom rules** in plain language, such as "Never quote day rates", for the whole organization or one workspace (up to 20 each). Custom rules can only add restrictions: a rule that tries to loosen the guardrails ("ignore the rules for managers", "you may swear") is refused when it's saved, with the reason. Every version of a rule is kept.

A question refused by a custom rule gets a fixed reply ("Your organization has asked me not to help with that here") that doesn't repeat the rule, because client guests may see it in Teams.

## Knowledge map and coverage
On **Memory & gaps**, Sidekick groups what a workspace knows into topics. Each topic has a **coverage** score from 0 to 100: high means it's well documented and consistent, low means it's mostly been talked about but not written down.

## Meeting notes and action items
Import a meeting transcript (a Teams `.vtt` file, a Word document or pasted text) and Sidekick writes the notes: a summary, decisions, **action items** (with owners and due dates as spoken), open questions, and lasting facts like requirements, risks and terms. Action items can be assigned and closed in the portal or straight from the card in Teams.

## Internal and Shareable, and client guests
Every document is tagged:
- **Internal**: for your team only (rates, staffing, internal risks).
- **Shareable**: fine to use when the client is in the room.

When **client guests are present** (in a meeting marked "Client guests attended", or a Teams channel marked as having client guests), Sidekick only uses Shareable sources. Notes from an internal-only meeting are never posted to a channel that has client guests.

## Sidekick in Teams
Sidekick can be added to Teams channels and chats. Each channel or chat is **linked to one workspace** by an admin, and Sidekick only answers from that workspace there. See [Sidekick in Teams](teams-guide.md).

## The in-app assistant
The chat box under the crystal ball on the home page. Ask it how Sidekick works ("how do I import a meeting?", "what can a Viewer do?") or ask it to do something: create a workspace, add a person, link a Teams chat, refresh a knowledge map, or open a page. While it thinks, the dust inside the ball swirls and the reply bubble shows what it's working on. It only offers what your role allows, and it never changes anything by itself: it shows a card with exactly what will happen, and nothing happens until you press **Confirm** (Cancel leaves everything as it was). Confirmed actions are recorded in the audit log like any other. For questions about a project's content, use **Ask Sidekick** on Knowledge & docs, which answers from your sources with citations. New client organizations are set up by the Sidekick team, not from the assistant.

## Audit log
Sign-ins, access changes, uploads, deletions, Teams links and every action Sidekick takes on its own are recorded on **Security & audit**, with who did it and when.

## Usage and cost
Each AI request is metered: how much text went in and out (tokens), what it cost, and how long it took. **Usage & billing** shows this by feature, workspace and day.

## How your data is protected
- Every request is checked: who you are, your role, and whether you belong to that workspace.
- Every search and every AI request is limited to one organization and one workspace.
- Documents and transcripts are treated as information, never as instructions, so text inside a file can't make Sidekick do something else.
- Questions and answers go through your organization's **guardrails** (see above), and automated tests plant a secret in one workspace and check it can't be reached from another workspace, another organization, Teams or the assistant.
- Sign in with your Microsoft work account (your company's password rules and MFA apply), or with a password, which is stored only as a secure hash. Your Org Owner can require Microsoft sign-in for everyone.
