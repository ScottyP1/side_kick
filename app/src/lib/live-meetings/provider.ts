/**
 * @file The meeting-bot providers behind "Sidekick live in Teams meetings" (docs/LIVE-MEETINGS.md). Sidekick doesn't
 * run Microsoft's Windows-only real-time media bot: a browser-based bot joins the meeting as a participant called
 * "Sidekick (notes)", streams what is said and typed to Sidekick by webhook, and can post in the meeting chat, raise
 * its hand and play speech. This file is the provider-agnostic contract and the list of providers.
 *
 * Concepts
 * - **Self-hosted first** (`attendee`): the open-source Attendee bot running in Sidekick's own Azure subscription
 *   (`ATTENDEE_BASE_URL`, `ATTENDEE_API_KEY`, `ATTENDEE_WEBHOOK_SECRET`). Meeting audio stays in Microsoft Teams and
 *   our Azure; no new company receives it. It's every organization's provider unless it opts in to a hosted one.
 * - **Hosted, per-organization opt-in** (`recall`): Recall.ai (`RECALL_API_KEY`, …). Only used for an organization whose
 *   Org Owner chose it (`orgs.live_provider`), and listed as a sub-processor for those organizations only
 *   (lib/subprocessors.ts). Never used as a silent fallback.
 * - **Capabilities** (`can`): whether the bot can raise its hand in Teams and play speech. Without a hand, Sidekick
 *   says "✋" in the chat instead; without speech, it answers in the chat only.
 * - **Events** (`LiveEvent`): a status change of the bot, a line said or typed, a participant joining, someone starting
 *   or stopping speaking (so Sidekick never talks over anyone).
 * - **Webhook signatures**: every webhook must carry the provider's valid signature (`verify`), checked before anything
 *   is read (lib/live-meetings/signature.ts).
 *
 * Who may call: lib/live-meetings/sessions.ts only. Secrets come from the environment (Key Vault on Azure), never from
 * the database or chat.
 */
import "server-only";
import { recallProvider } from "./recall";
import { attendeeProvider } from "./attendee";

/** The providers Sidekick knows. */
export const PROVIDER_IDS = ["attendee", "recall"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** What people are told about each provider: who runs it and where meeting audio and text go. */
export const PROVIDER_INFO: Record<ProviderId, { label: string; hosted: boolean; where: string }> = {
  attendee: {
    label: "Sidekick's own meeting bot",
    hosted: false,
    where: "Meeting audio stays in Microsoft Teams and Sidekick's own Azure subscription (Teams captions, Azure AI Speech for the spoken answers). No other company receives it.",
  },
  recall: {
    label: "Recall.ai (hosted meeting bot)",
    hosted: true,
    where: "Recall.ai (a US company, SOC 2 / ISO 27001) runs the bot and receives the meeting's audio to transcribe it, in the region Sidekick chose; recordings are kept as briefly as Recall allows.",
  },
};

/** A bot status, in Sidekick's words: `waiting` = in the lobby; `in_call` = admitted and listening. */
export type LiveStatus = "joining" | "waiting" | "in_call" | "ended" | "failed";

/** One thing a provider tells Sidekick about a bot (see the file header). `botId` is the provider's id for the bot. */
export type LiveEvent =
  | { kind: "status"; botId: string; status: LiveStatus; detail: string | null }
  | { kind: "line"; botId: string; speaker: string | null; text: string; source: "speech" | "chat" }
  | { kind: "participant"; botId: string; name: string | null; tenantId: string | null; guest: boolean }
  | { kind: "speech"; botId: string; name: string | null; speaking: boolean };

/** What Sidekick asks a provider to do. Each call throws on failure (a plain message, no secrets). */
export interface LiveProvider {
  /** Saved on each session (`live_sessions.provider`) and part of the webhook address (/api/live/events/<id>). */
  readonly id: ProviderId;
  /** What the bot can do besides listening and chatting. */
  readonly can: { raiseHand: boolean; speak: boolean };
  /** Sends a bot to the meeting at `meetingUrl` with display name `botName`; its events go to `webhookUrl`. */
  join(o: { meetingUrl: string; botName: string; webhookUrl: string; sessionId: string }): Promise<{ botId: string }>;
  /** Makes the bot leave the meeting. A bot that already left is not an error. */
  stop(botId: string): Promise<void>;
  /** Posts `text` (plain text, at most about 4,000 characters) to everyone in the meeting chat. */
  sendChatMessage(botId: string, text: string): Promise<void>;
  /** Raises (or lowers) the bot's hand in Teams. Only when `can.raiseHand`. */
  raiseHand(botId: string, up: boolean): Promise<void>;
  /** Plays speech (MP3, base64) through the bot's microphone. Only when `can.speak`. */
  speak(botId: string, mp3Base64: string): Promise<void>;
  /** Whether a webhook request really came from the provider (signature over the raw body). */
  verify(headers: Headers, rawBody: string): boolean;
  /** The events in one webhook body; anything Sidekick doesn't use is dropped. */
  parse(body: unknown): LiveEvent[];
}

/** A provider by id, or null when it isn't configured on this copy of Sidekick (its keys are missing). */
export function providerById(id: string | null | undefined): LiveProvider | null {
  if (id === "attendee") return attendeeProvider();
  if (id === "recall") return recallProvider();
  return null;
}

/** The providers configured on this copy (self-hosted first). */
export const configuredProviders = (): ProviderId[] => PROVIDER_IDS.filter((id) => providerById(id));

export { verifyStandardWebhook } from "./signature";
