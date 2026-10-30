/**
 * @file Sidekick's sub-processors: the outside services that process customer data on Sidekick's behalf, with what
 * each does, what data it sees and where. Pure data (no imports besides the brand, no I/O), shown on the public page
 * /privacy/subprocessors and referenced from the privacy policy and docs/STORE-READINESS.md.
 *
 * Keep it in step with the code: hosting and search (docs/HOSTING.md, lib/azure-search.ts), the AI (lib/claude.ts:
 * Anthropic's API), and Microsoft Graph and the Teams bot service (lib/meetings-graph.ts, lib/teams/bot.ts). Tools a
 * group connects (lib/connectors.ts) aren't sub-processors: they're the customer's own services, which Sidekick
 * only reads with the customer's permission. A test checks the page lists every entry. Entries with `onlyWhen` apply only
 * to organizations that opted in (the hosted meeting bot, lib/live-meetings/provider.ts).
 */
import { BRAND } from "./brand";

/** One sub-processor: who, what for, which data and where it's processed. */
export type Subprocessor = { name: string; company: string; purpose: string; data: string; location: string; terms: string; onlyWhen?: string };

/** Every sub-processor, in the order the page shows them. */
export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: "Microsoft Azure",
    company: "Microsoft Corporation",
    purpose: `Hosts ${BRAND.name}: the web app and Teams bot endpoint, the database and its backups, the search index, secrets (Key Vault) and technical logs. When cloud search is on, an embedding model (Azure OpenAI) turns short passages into search vectors. In live meetings (Enterprise), ${BRAND.name}'s own meeting bot runs here too, and Azure AI Speech turns its short spoken answers into speech.`,
    data: "Everything Sidekick stores (see the privacy policy), encrypted in transit and at rest.",
    location: "United States (East US, Central US, East US 2)",
    terms: "https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA",
  },
  {
    name: "Anthropic (Claude)",
    company: "Anthropic, PBC",
    purpose: "The AI model that writes answers, meeting notes and reminders, and checks questions and custom rules against the guardrails.",
    data: "Only what one task needs: a question with the few passages that answer it, or one meeting's transcript. Not used to train models.",
    location: "United States",
    terms: "https://www.anthropic.com/legal/commercial-terms",
  },
  {
    name: "Microsoft Graph and Microsoft Teams (Azure Bot Service)",
    company: "Microsoft Corporation",
    purpose: `How ${BRAND.name} reads what your Microsoft 365 admin approved (people, meeting details and transcripts, messages in assigned chats) and how its messages reach Teams.`,
    data: "Your organization's own Microsoft 365 data, read with the permissions listed in the privacy policy; Sidekick's replies and cards.",
    location: "Your Microsoft 365 organization's own data location; the bot service is global",
    terms: "https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA",
  },
  {
    name: "Recall.ai (hosted meeting bot)",
    company: "Recall.ai, Inc.",
    purpose: `Runs the meeting bot that joins Teams meetings live and transcribes them, instead of ${BRAND.name}'s own meeting bot (lib/live-meetings/).`,
    data: "The audio, captions and chat of the Teams meetings the bot joins, for as short a time as Recall.ai allows; no recordings are downloaded.",
    location: "The Recall.ai region Sidekick uses (United States or the EU)",
    terms: "https://www.recall.ai/data-processing-agreement",
    onlyWhen: "Only for organizations whose Org Owner chose the hosted meeting bot for live meetings. Otherwise Recall.ai receives nothing.",
  },
];
