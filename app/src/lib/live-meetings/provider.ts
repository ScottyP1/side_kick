/**
 * @file The hosted meeting-bot provider behind "Sidekick live in Teams meetings" (docs/LIVE-MEETINGS.md). Sidekick
 * doesn't run its own media bot (Microsoft's real-time media platform needs a Windows/.NET bot): a provider's bot joins
 * the meeting as a participant called "Sidekick (notes)", streams what is said to Sidekick by webhook, and can post into
 * the meeting chat. This file is the provider-agnostic contract; `recall.ts` implements it for Recall.ai (and for the
 * tests' fake server, which speaks the same API).
 *
 * Concepts
 * - **Which provider**: `SIDEKICK_LIVE_PROVIDER` (`recall`; unset = live meetings are off everywhere, and the group
 *   switch says "not set up yet"). Nothing else in Sidekick names a provider; `lib/live-meetings/sessions.ts` only uses
 *   `LiveProvider`.
 * - **Events** (`LiveEvent`): a status change of the bot (joining, waiting in the lobby, in the call, ended, failed), a
 *   line of what was said or typed in the meeting chat, and a participant joining. Providers send several per webhook.
 * - **Webhook signatures**: every webhook must carry a valid signature (`verify`), or it's refused with 401 before
 *   anything is read. Recall.ai (and Svix-style providers) use the Standard Webhooks scheme, `verifyStandardWebhook`.
 *
 * Who may call: lib/live-meetings/sessions.ts only. Secrets come from the environment (Key Vault on Azure), never from
 * the database or chat.
 */
import "server-only";
import { recallProvider } from "./recall";

/** A bot status, in Sidekick's words: `waiting` = in the lobby; `in_call` = admitted and listening. */
export type LiveStatus = "joining" | "waiting" | "in_call" | "ended" | "failed";

/** One thing a provider tells Sidekick about a bot (see the file header). `botId` is the provider's id for the bot. */
export type LiveEvent =
  | { kind: "status"; botId: string; status: LiveStatus; detail: string | null }
  | { kind: "line"; botId: string; speaker: string | null; text: string; source: "speech" | "chat" }
  | { kind: "participant"; botId: string; name: string | null; tenantId: string | null; guest: boolean };

/** What Sidekick asks a provider to do. Each call throws on failure (a plain message, no secrets). */
export interface LiveProvider {
  /** Short id saved on each session (`live_sessions.provider`). */
  readonly id: string;
  /** Sends a bot to the meeting at `meetingUrl` with display name `botName`; its events go to `webhookUrl`. */
  join(o: { meetingUrl: string; botName: string; webhookUrl: string; sessionId: string }): Promise<{ botId: string }>;
  /** Makes the bot leave the meeting. A bot that already left is not an error. */
  stop(botId: string): Promise<void>;
  /** Posts `text` (plain text, at most about 4,000 characters) to everyone in the meeting chat. */
  sendChatMessage(botId: string, text: string): Promise<void>;
  /** Whether a webhook request really came from the provider (signature over the raw body). */
  verify(headers: Headers, rawBody: string): boolean;
  /** The events in one webhook body; anything Sidekick doesn't use is dropped. */
  parse(body: unknown): LiveEvent[];
}

/**
 * The configured provider, or null when live meetings aren't set up on this copy of Sidekick (no
 * `SIDEKICK_LIVE_PROVIDER`, or its keys are missing). Cheap; reads the environment each time.
 */
export function liveProvider(): LiveProvider | null {
  const id = process.env.SIDEKICK_LIVE_PROVIDER?.trim().toLowerCase();
  if (id === "recall") return recallProvider();
  return null;
}

export { verifyStandardWebhook } from "./signature";
