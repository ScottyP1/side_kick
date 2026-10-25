/**
 * @file The public changelog (/changelog): what changed for customers, newest first. Plain data, written for
 * people who use Sidekick (no internal names, hosting details or addresses). Seeded from the feature history
 * in docs/PROGRESS.md; add an entry here when a user-visible change ships.
 */

/** One release: when (ISO date for the <time> tag, and how to show it), a headline and what changed. */
import { BRAND } from "./brand";
export type ChangelogEntry = { date: string; label: string; title: string; changes: string[] };

/** Every release, newest first. */
export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    date: "2026-10-25",
    label: "October 25, 2026",
    title: "A nudge to start transcription",
    changes: [
      `When a call starts in one of a group's Teams chats (Meet now or the call button) and nobody has started transcription after about two minutes, ${BRAND.name} posts one short reminder showing where the button is. No transcript means no notes.`,
      `On for every group to start with. The Team Lead switches it on the group's Teams chats tab, or types “@${BRAND.name} stop transcription reminders” in the chat.`,
      "For scheduled meetings, the help center explains the Teams option that makes them transcribe by themselves (Transcribe only), with no Teams Premium needed.",
    ],
  },
  {
    date: "2026-10-24",
    label: "October 24, 2026",
    title: "Documents land where they belong",
    changes: [
      "Every upload says which group it goes to, in the group's colour, and people in several groups confirm the group each time (also when adding a past or outside meeting).",
      `If a file looks like it's about another of your clients (their name or engagement code), ${BRAND.name} holds it: it isn't used in any answer until you keep it or move it to the right group. Moving takes it out of the old group's search completely.`,
      "Firm library: client material is held before it can reach every group, and a firm document can now apply to chosen groups only.",
      "A file kept anyway shows up under Needs attention for the group's Team Lead (firm library: the admins), with It belongs here.",
    ],
  },
  {
    date: "2026-10-24",
    label: "October 24, 2026",
    title: "Billing is for Org Owners and Org Admins",
    changes: [
      "The Billing Admin role is gone: Usage & billing, the AI credit and its notices are for Org Owners and Org Admins, and only the Org Owner pays, changes the plan or cancels.",
      "Anyone who was a Billing Admin is now a Member. The change is on Security & audit, and the Org Owner sees a note on Home: make them an Org Admin if they should keep seeing billing.",
      "A simpler menu: Members and Viewers see the pages for their client work, Settings is just your own account unless you run the organization, and AI models & agent, Guardrails, Activity and Security & audit are for Org Owners and Org Admins. Connectors is for them and Team Leads.",
      "Each group's page lists the tools that feed it (Sources), and its Team Lead sees the group's last 30 days: questions, answers, meetings, documents and its share of the organization's AI use.",
      "Help & support lists the rules Sidekick follows: the ones that are always on, your organization's switches, and how many extra rules apply.",
    ],
  },
  {
    date: "2026-10-23",
    label: "October 23, 2026",
    title: "SharePoint and OneDrive files",
    changes: [
      `Connect Microsoft 365 (read-only, with your Microsoft work account) and link a SharePoint document library, one of its folders, or a OneDrive folder shared with you to a group: its Word, PDF, PowerPoint and text files become part of the group's documents, kept up to date as people edit them, and answers cite them with an Open in SharePoint link.`,
      "Files larger than 25 MB aren't read; Connectors shows how many, and answers can still point to them by name.",
      "You can now upload PowerPoint (.pptx) files too; answers say which slide a fact came from.",
    ],
  },
  {
    date: "2026-10-23",
    label: "October 23, 2026",
    title: "GitHub and Confluence connectors",
    changes: [
      `Connect GitHub (read-only, through the ${BRAND.name} GitHub App) and link a repository to a group: its issues and pull requests, with state, assignees, labels, milestones and the latest comments, become part of the group's knowledge, cited with a link.`,
      "Connect Confluence (read-only, with your Atlassian account) and link a space to a group: its pages are searched like the group's documents and cited with an Open in Confluence link.",
      `When a tool asks ${BRAND.name} to slow down, syncing pauses and carries on from where it stopped; Connectors says so in plain words.`,
    ],
  },
  {
    date: "2026-10-23",
    label: "October 23, 2026",
    title: "Automatic notes after every Teams meeting",
    changes: [
      `Turn on automatic notes and ${BRAND.name} writes the notes after every Teams meeting of a group's people, from the meeting's transcript (no bot joins the call), puts them in the right group and posts them to the group's notes chat. A meeting several groups were in waits for a Team Lead or admin to pick the group.`,
      "Save to knowledge: keep a decision, requirement, risk or fact from a meeting as lasting group knowledge, right from the notes card in Teams or the meeting's page. Answers find saved items first.",
      `${BRAND.name} in the Teams app bar and as a tab in chats, channels and meetings: the group's meetings, notes and open action items, signed in with your Microsoft account.`,
      "Importing a transcript is now called “Add a past or outside meeting”, for meetings held before automatic notes were on or outside Teams.",
    ],
  },
  {
    date: "2026-10-23",
    label: "October 23, 2026",
    title: "Needs attention: Sidekick keeps watch",
    changes: [
      `${BRAND.name} now checks every group in the background and lists what needs a person under Needs attention, on Home and on each group's page: unanswered questions, Teams posts that didn't get through, chats waiting to be assigned or that ${BRAND.name} was removed from, overdue and unowned action items, documents a newer decision changed, groups without a Team Lead or a notes chat, and connectors that stopped working.`,
      "Each item has a next step and a button to fix it, clears itself once fixed, and can be snoozed for a week by admins and the group's Team Lead. Everyone only sees items for their own groups.",
      "More reliable background work: reminders and other scheduled tasks now run from a queue that retries on its own.",
    ],
  },
  {
    date: "2026-10-21",
    label: "October 21, 2026",
    title: "Firm library, sharper answers and follow-up questions",
    changes: [
      "The firm library: your organization's policies, standards and templates, added once and used in every group's answers (cited as “Firm policy”). Client guests only see Shareable ones.",
      "Sharper answers: sources are ranked by how well they fit the whole question, newer ones count more, out-of-date versions are flagged, duplicates are used once, and meeting notes come before raw transcripts. When sources disagree, the answer says so.",
      "Filters in Ask: documents, meetings, Teams chats, decisions or the firm library, and a date range.",
      "Follow-up questions in Ask and in Teams (same thread, or within 30 minutes in a chat), with “Following up on…” and New question.",
      "👍/👎 on every answer, with the counts for your admins.",
    ],
  },
  {
    date: "2026-10-21",
    label: "October 21, 2026",
    title: "Website, help center and setup wizard",
    changes: [
      "A public website: features, how it works, security & trust, pricing, an FAQ and this changelog.",
      "The help center: the guides are now public pages at /docs, with search.",
      `A setup wizard after sign-up: connect Microsoft 365, add ${BRAND.name} to Teams, pick your rules and create your first groups. A "Finish setting up" note takes you back if you leave halfway.`,
      "Signed-in people who open the website go straight to their portal.",
      "Redesigned How it works (a step-by-step journey with screen previews) and Security & trust (trust pillars, a diagram of the walls, where your data lives), and tidier pricing cards.",
      "Illustrations and real product pictures across the website: the chat, a phone and the portal, in light and dark.",
    ],
  },
  {
    date: "2026-10-20",
    label: "October 20, 2026",
    title: "Groups, sign-up and Microsoft 365 for every company",
    changes: [
      "Groups: one page per client team with an overview checklist, people, Teams chats, documents and settings; health labels on every group card; a one-page New group form with the client, Team Lead and first members.",
      "Self-service sign-up (when open) with a free trial, three plans and a test-mode checkout; public pricing, privacy, terms and support pages.",
      `Any company's Microsoft 365 can use ${BRAND.name}: chats wait to be assigned to a group in the portal, people can be imported from Microsoft 365, and Team Leads can type @${BRAND.name} add @name.`,
      `Only Team Leads and admins can add ${BRAND.name} to a chat; chats nobody assigns are left after 7 days.`,
      "A new look (Indigo), in light and dark mode.",
      "Security: stricter browser protections, sign-in pauses after repeated wrong passwords, changing your password signs out your other sessions, upload size limits, and an Unlock button for admins.",
      "Fixes: times in chat messages are no longer hidden as if they were phone numbers, questions about rates and fees are answered, and groups can be renamed and deleted.",
    ],
  },
  {
    date: "2026-10-17",
    label: "October 17, 2026",
    title: "Reminders and Team Leads",
    changes: [
      "Reminders in Teams chats: overdue and unowned action items, decisions still waiting, and documents that look out of date or conflict.",
      `Per-chat settings: meeting notes on or off, and whether ${BRAND.name} follows the chat.`,
      "The Team Lead role: runs the people side of the groups they lead and links their chats.",
      "Roles and permissions written down as one rulebook, and checked automatically for every role.",
    ],
  },
  {
    date: "2026-10-16",
    label: "October 16, 2026",
    title: "Microsoft sign-in, guardrails and Activity",
    changes: [
      "Sign in with Microsoft, which an Org Owner can make required.",
      "Guardrails: company-wide switches, stricter rules per group, custom rules and a Test it box.",
      `Activity: what ${BRAND.name} did step by step (timings and counts, never document text), and live status on the home page.`,
      "A home-page assistant for quick admin jobs that changes nothing until you confirm.",
      "Search that understands meaning as well as keywords.",
      "Every error shows a reference code you can send to support.",
    ],
  },
  {
    date: "2026-10-15",
    label: "October 15, 2026",
    title: "First version",
    changes: [
      `The ${BRAND.name} portal: workspaces per client, documents, meetings, and answers with sources.`,
      "Meeting notes: summary, decisions, open questions and action items.",
      "A knowledge map with coverage and gaps from unanswered questions.",
      `${BRAND.name} in Microsoft Teams: answer cards with sources and meeting-notes cards.`,
      "An audit log and usage per workspace.",
    ],
  },
];
