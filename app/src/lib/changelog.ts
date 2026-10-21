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
