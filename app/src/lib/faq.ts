/**
 * @file Sidekick's frequently asked questions: the one place buyer and user questions are answered in plain
 * words. The /faq page shows them all; Pricing, Security & trust and How it works show the ones tagged for
 * them (components/faq-list.tsx). Pure data with no I/O, so the future public "Ask about Sidekick" chat can
 * use the same answers (and only public content).
 *
 * Keep answers consistent with the guides in docs/guide/ (`guide` names the help-center page with the
 * details). Answers marked `legalReview` are placeholders a lawyer still has to check, and say so on the page.
 */

/** Where a question is shown besides /faq. */
export type FaqTopic = "pricing" | "security" | "how-it-works";

/** One question and its answer (plain text, one or more short paragraphs). */
export type FaqItem = {
  /** Stable id, also the anchor on /faq (e.g. /faq#training). */
  id: string;
  q: string;
  a: string[];
  topics: FaqTopic[];
  /** Help-center guide (and section) with the details, e.g. "/docs/admin-guide#4-add-people". */
  guide?: string;
  /** True when the wording is a placeholder for legal review. */
  legalReview?: boolean;
};

/** Every question, in the order /faq shows them. */
export const FAQ: readonly FaqItem[] = [
  {
    id: "what-can-it-see",
    q: "What can Sidekick see?",
    a: [
      "Only what your organization gives it: the documents and meeting transcripts people add to a group, and the Teams chats a Team Lead or admin assigns to that group.",
      "It answers from one group at a time, so it never uses another group's or another client's material. It can't see the rest of your Microsoft 365: no mailboxes, files or other chats.",
    ],
    topics: ["security"],
    guide: "/docs/teams-guide",
  },
  {
    id: "every-chat",
    q: "Does Sidekick read every Teams chat?",
    a: [
      "No. Sidekick only reads chats it has been added to and that a Team Lead or admin has assigned to a group in the portal. Until a chat is assigned, Sidekick reads, saves and answers nothing there.",
      "Once a chat is assigned, Sidekick follows that chat (it says so in the chat) so it can answer, take notes and send reminders. A chat nobody assigns is left after 7 days.",
    ],
    topics: ["security", "how-it-works"],
    guide: "/docs/teams-guide#getting-started",
  },
  {
    id: "where-data",
    q: "Where is our data stored?",
    a: [
      "In Microsoft Azure: the Sidekick app, its database and its search index all run there. Everything travels encrypted (HTTPS only), including the connection to the database.",
      "Org Owners and Org Admins can delete documents, meetings and whole groups at any time; to have your organization removed entirely, contact support.",
    ],
    topics: ["security"],
  },
  {
    id: "training",
    q: "Is our data used to train AI models?",
    a: [
      "Sidekick's answers are written by Claude, an AI model made by Anthropic, through Anthropic's API. Anthropic's commercial terms say data sent through its API isn't used to train its models by default, and Sidekick doesn't use your data to train anything either.",
      "This wording is a draft for legal review; Anthropic's own terms are what count.",
    ],
    topics: ["security"],
    legalReview: true,
  },
  {
    id: "walls",
    q: "How are companies and client groups kept apart?",
    a: [
      "Every company's Sidekick is completely separate: nothing is shared between organizations. Inside a company, each client group is walled off too: searches are limited to the group before anything is ranked, and each Teams chat belongs to exactly one group.",
      "Org Owners and Org Admins see every group; everyone else, Team Leads included, sees only the groups they've been added to. Automated tests check these walls on every change.",
    ],
    topics: ["security"],
    guide: "/docs/concepts#how-your-data-is-protected",
  },
  {
    id: "client-guests",
    q: "What about client guests in our chats?",
    a: [
      "Every document is tagged Internal (your team only) or Shareable (fine with the client in the room). In chats marked as having client guests, Sidekick only uses Shareable material and never posts notes from internal-only meetings there. Client guests are free: they don't count as people on your plan.",
    ],
    topics: ["security", "pricing"],
    guide: "/docs/concepts#internal-and-shareable-and-client-guests",
  },
  {
    id: "ai-limit",
    q: "What happens when we reach our plan's AI allowance?",
    a: [
      "Each plan includes a monthly AI credit. Admins see a warning when you've used 80% of it. At the limit Sidekick keeps the essentials running and pauses the rest until the next month or until you change plan, so nothing is lost and nothing is billed by surprise.",
      "The amounts may still change while pricing is being decided.",
    ],
    topics: ["pricing"],
  },
  {
    id: "cancel",
    q: "Can we cancel any time?",
    a: [
      "Yes. The Org Owner or a Billing Admin can change plan or cancel from Usage & billing. After canceling, Sidekick stays fully usable until the end of what you paid for, then turns read-only: everyone can still sign in and see everything, and nothing is deleted. Paying again turns everything back on straight away.",
    ],
    topics: ["pricing"],
    guide: "/docs/admin-guide#15-sign-up-plan-and-billing",
  },
  {
    id: "trial",
    q: "Is there a free trial?",
    a: ["Yes, every plan starts with a free trial. While prices are being decided, payments are in test mode: no money moves and Sidekick never asks for card details."],
    topics: ["pricing"],
  },
  {
    id: "microsoft-permissions",
    q: "Which Microsoft 365 permissions does Sidekick need?",
    a: [
      "A Microsoft admin at your company (Global Administrator, Privileged Role Administrator or Cloud Application Administrator) approves Sidekick once. That approval lets people sign in with their work account, lets Sidekick look people up in your directory (names, work emails, job titles; it never changes anything), and lets Sidekick remove itself from a chat.",
      "Reading Teams messages is not part of it: Teams asks the chat's owner separately when Sidekick is added to a chat. Your admin can withdraw the approval any time in the Microsoft Entra admin center.",
    ],
    topics: ["security", "how-it-works"],
    guide: "/docs/admin-guide#4-add-people",
  },
  {
    id: "teams-install",
    q: "How do we install Sidekick in Teams?",
    a: [
      "Your Teams admin makes the Sidekick app available to the people who should have it (we recommend Team Leads and admins only). They then add it to a group chat or a channel from Teams' Manage apps (meeting chats come with automatic meeting notes, coming soon), and assign the chat to a group in the Sidekick portal. The setup wizard after sign-up walks you through it.",
    ],
    topics: ["how-it-works"],
    guide: "/docs/teams-guide#getting-started",
  },
  {
    id: "who-adds",
    q: "Who can add Sidekick to a chat?",
    a: [
      "Only Team Leads and admins. If anyone else adds it, Sidekick says so and leaves the chat. Team Leads can then add people to their group, from the portal or by typing @Sidekick add @name in the chat.",
    ],
    topics: ["how-it-works", "security"],
    guide: "/docs/roles-and-permissions#who-can-do-what",
  },
  {
    id: "support",
    q: "How do we get help?",
    a: [
      "Start with the help center, which has the guides for admins and for Teams. For anything else, contact support; if you saw an error, include its reference code so we can find exactly what happened. Never send passwords or payment details.",
    ],
    topics: ["pricing", "how-it-works"],
    guide: "/docs",
  },
];

/** The questions shown on a page besides /faq, in FAQ order. */
export function faqFor(topic: FaqTopic): FaqItem[] {
  return FAQ.filter((f) => f.topics.includes(topic));
}
