/**
 * @file Sidekick's own meeting bot, the **default** live-meeting provider (lib/live-meetings/provider.ts; why:
 * docs/LIVE-MEETINGS.md). Attendee (open source, Elastic License 2.0) plus our raise-hand patch, Redis and a small shim,
 * all in one container image (`meetbot/`), run as **one Azure Container Apps job execution per meeting**
 * (lib/live-meetings/launcher.ts): nothing runs between meetings.
 *
 * Concepts
 * - **No inbound address**: a job execution can't be called. Its shim connects **out** to Sidekick:
 *   - commands (`live_commands`: chat, speak, hand, hearing, leave) are fetched with a long poll on
 *     `GET /api/live/bot/commands`, authenticated with the session's own key;
 *   - events (Attendee's bot state, caption lines, chat messages, who joins and who speaks, plus the shim's own:
 *     hearing switched, captions unavailable, container exiting) are posted to `/api/live/events/attendee`, signed with
 *     that key (`verifyBotEvent`). The key is an HMAC of the session id with `SIDEKICK_MEETBOT_SECRET`, so a container
 *     can only act for its own meeting.
 * - **Hearing**: Teams' own live captions first (free; Microsoft transcribes inside Teams). When captions are off,
 *   missing or stalled, Sidekick tells the shim to switch to **Azure AI Speech speech-to-text** in our subscription
 *   (`setHearing`, rules in lib/live-meetings/rules.ts `hearingNext`); its lines come back marked `azure_stt`.
 * - **Speaking**: the MP3 Sidekick made with Azure AI Speech (lib/live-meetings/speech.ts) goes in the `speak` command;
 *   the shim plays it through Attendee's `output_audio`.
 * - **Raising its hand**: `hand` commands; the shim calls our patch's `raise_hand` in Attendee. `ATTENDEE_RAISE_HAND=1`
 *   says the deployed image has the patch; without it Sidekick puts "✋" in the chat instead.
 * - **Leaving**: a `leave` command; the container exits once Attendee says the bot left. If it doesn't within a few
 *   minutes, `live.watch` stops the execution in Azure (`stopBot`).
 *
 * Configured by: `SIDEKICK_MEETBOT_JOB`, `AZURE_SUBSCRIPTION_ID`, `SIDEKICK_MEETBOT_IMAGE`, `SIDEKICK_MEETBOT_SECRET`
 * and the app's managed identity (launcher.ts). Who may call: lib/live-meetings/provider.ts `providerById("attendee")`.
 */
import "server-only";
import { get, newId, now, run } from "../db";
import { notificationBase } from "../meetings-graph";
import type { LiveEvent, LiveProvider, LiveStatus } from "./provider";
import { botKey, launcherConfigured, startBot, stopBot } from "./launcher";
import { verifyBotEvent } from "./signature";

/** Attendee's bot states in Sidekick's words. Unknown states are ignored. */
function statusOf(state: string): LiveStatus | null {
  if (state === "joining" || state === "staged" || state === "ready") return "joining";
  if (state === "waiting_room") return "waiting";
  if (state.startsWith("joined")) return "in_call";
  if (state === "leaving" || state === "post_processing" || state === "ended" || state === "data_deleted") return "ended";
  if (state === "fatal_error") return "failed";
  return null;
}

/** The kinds of command the shim understands. */
export type BotCommand = "chat" | "speak" | "hand" | "hearing" | "leave";

let seq = 0;
/**
 * A command id that sorts in the order commands were queued (time, then a counter), so the bot does them in order even
 * within one millisecond (hand down → speak → chat).
 */
const commandId = () => `${Date.now().toString(36).padStart(9, "0")}-${(seq = (seq + 1) % 1e6).toString(36).padStart(4, "0")}-${newId().slice(0, 8)}`;

/** Queues a command for a session's bot (the shim fetches it within a second or two), in order. */
export async function queueCommand(sessionId: string, kind: BotCommand, data: Record<string, unknown> = {}) {
  const s = await get<{ org_id: string }>("SELECT org_id FROM live_sessions WHERE id = ?", sessionId);
  if (!s) throw new Error("That live session is gone.");
  await run("INSERT INTO live_commands (id, org_id, session_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", commandId(), s.org_id, sessionId, kind, JSON.stringify(data), now());
}

/** Sidekick's own meeting bot, or null when it isn't set up on this copy (job, secret, identity). */
export function attendeeProvider(): LiveProvider | null {
  if (!launcherConfigured()) return null;
  return {
    id: "attendee",
    can: { raiseHand: process.env.ATTENDEE_RAISE_HAND === "1", speak: true },
    async join({ meetingUrl, botName, sessionId }) {
      const base = notificationBase();
      if (!base) throw new Error("Sidekick has no public address for its meeting bot to call.");
      const execution = await startBot({ sessionId, meetingUrl, botName, sidekickUrl: base, raiseHand: process.env.ATTENDEE_RAISE_HAND === "1" });
      await run("UPDATE live_sessions SET execution = ?, launched_at = ?, hearing = 'captions', hearing_since = ? WHERE id = ?", execution, now(), now(), sessionId);
      // The bot's id is the session's: the shim reports under it.
      return { botId: sessionId };
    },
    async stop(botId) {
      await queueCommand(botId, "leave");
    },
    async sendChatMessage(botId, text) {
      await queueCommand(botId, "chat", { text: text.slice(0, 4000) });
    },
    async raiseHand(botId, up) {
      await queueCommand(botId, "hand", { raised: up });
    },
    async speak(botId, mp3Base64) {
      await queueCommand(botId, "speak", { mp3: mp3Base64 });
    },
    async setHearing(botId, source) {
      await queueCommand(botId, "hearing", { source });
    },
    verify(headers, rawBody) {
      return verifyBotEvent(botKey, headers, rawBody);
    },
    parse(body) {
      const list = Array.isArray(body) ? body : [body];
      const out: LiveEvent[] = [];
      for (const item of list.slice(0, 50)) {
        if (!item || typeof item !== "object") continue;
        const { bot_id: botId, trigger, data = {} } = item as { bot_id?: unknown; trigger?: unknown; data?: Record<string, unknown> };
        if (typeof botId !== "string" || !botId || typeof trigger !== "string") continue;
        const str = (v: unknown, n = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
        if (trigger === "bot.state_change") {
          const status = statusOf(String(data.new_state ?? ""));
          const meta = (data.event_metadata ?? {}) as Record<string, unknown>;
          const remover = str(meta.remover_name);
          if (status) out.push({ kind: "status", botId, status, detail: remover ? `removed by ${remover}` : str(data.event_type) });
        } else if (trigger === "transcript.update") {
          const text = str((data.transcription as { transcript?: unknown } | undefined)?.transcript, 2000);
          if (text) out.push({ kind: "line", botId, speaker: str(data.speaker_name), text: text.replace(/\s+/g, " "), source: "speech", heardBy: data.source === "azure_stt" ? "stt" : "captions" });
        } else if (trigger === "chat_messages.update") {
          const text = str(data.text, 2000);
          if (text) out.push({ kind: "line", botId, speaker: str(data.sender_name), text: text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), source: "chat" });
        } else if (trigger === "participant_events.join_leave" || trigger === "participant_events.speech_start_stop") {
          const type = String(data.event_type ?? "");
          const name = str(data.participant_name);
          // Guests are told apart by the "(Guest)"/"(External)" Teams adds to their shown name (sessions.ts).
          if (type === "join") out.push({ kind: "participant", botId, name, tenantId: null, guest: false });
          else if (type === "speech_start" || type === "speech_stop") out.push({ kind: "speech", botId, name, speaking: type === "speech_start" });
        } else if (trigger === "sidekick.hearing") {
          out.push({ kind: "hearing", botId, source: data.source === "stt" ? "stt" : "captions", detail: str(data.reason) });
        } else if (trigger === "sidekick.captions_unavailable") {
          out.push({ kind: "captions_unavailable", botId, detail: str(data.reason) });
        } else if (trigger === "sidekick.exit") {
          out.push({ kind: "exit", botId, detail: str(data.reason) });
        }
      }
      return out;
    },
  };
}

/** Stops a session's container in Azure when it didn't leave by itself (live.watch). Never throws. */
export async function reapBot(execution: string): Promise<void> {
  await stopBot(execution).catch((e) => console.error("Couldn't stop the meeting bot's container", e instanceof Error ? e.message : e));
}
