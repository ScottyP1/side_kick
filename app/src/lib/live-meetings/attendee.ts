/**
 * @file The self-hosted meeting bot: Attendee (https://github.com/attendee-labs/attendee, Elastic License 2.0) running
 * in Sidekick's own Azure subscription, as the default live-meeting provider (lib/live-meetings/provider.ts; why:
 * docs/LIVE-MEETINGS.md). Written from Attendee's API reference and docs (read Oct 29, 2026) and exercised against the
 * tests' fake Attendee server; **not yet run against a real Attendee deployment** (nothing is deployed). Things to
 * confirm on the first real run are marked "Trial:".
 *
 * Concepts
 * - **Where**: `ATTENDEE_BASE_URL` (our own deployment; plain http only outside production), `ATTENDEE_API_KEY`
 *   (`Authorization: Token …`), `ATTENDEE_WEBHOOK_SECRET` (the project's base64 webhook secret).
 * - **Hearing the meeting without another vendor**: the bot turns on Teams' own live captions and sends each caption
 *   line (`transcript.update`, `meeting_closed_captions`), so Microsoft does the speech-to-text inside Teams and the
 *   audio never goes to a third party. Chat messages (`chat_messages.update`), people joining and leaving, and who
 *   starts or stops speaking (`participant_events.*`) come the same way, to /api/live/events/attendee.
 * - **Speaking**: Sidekick makes the speech with Azure AI Speech in its own subscription (lib/live-meetings/speech.ts)
 *   and plays it through the bot's microphone (`POST /bots/:id/output_audio`, `audio/mp3`, documented).
 * - **Raising its hand**: Attendee has no such endpoint. Sidekick's deployment adds one (`POST /bots/:id/raise_hand`
 *   with `{ "raised": true|false }`, a small patch that clicks Teams' Raise hand button the way Attendee already clicks
 *   Join and Leave; docs/LIVE-MEETINGS.md → "Raise hand"). `ATTENDEE_RAISE_HAND=1` says the deployed image has it;
 *   without it Sidekick puts "✋" in the chat instead.
 * - **Chat**: `POST /bots/:id/send_chat_message` (Teams accepts basic HTML: line breaks become <br>).
 *
 * Who may call: lib/live-meetings/provider.ts `providerById("attendee")` only.
 */
import "server-only";
import type { LiveEvent, LiveProvider, LiveStatus } from "./provider";
import { verifyAttendeeWebhook } from "./signature";

/** Attendee's bot states in Sidekick's words. Unknown states are ignored. */
function statusOf(state: string): LiveStatus | null {
  if (state === "joining" || state === "staged" || state === "ready") return "joining";
  if (state === "waiting_room") return "waiting";
  if (state.startsWith("joined")) return "in_call";
  if (state === "leaving" || state === "post_processing" || state === "ended" || state === "data_deleted") return "ended";
  if (state === "fatal_error") return "failed";
  return null;
}

/** Our Attendee's address (see the file header), or null when it isn't configured. */
function baseUrl(): string | null {
  const url = process.env.ATTENDEE_BASE_URL?.trim();
  if (!url) return null;
  if (!/^https:\/\//i.test(url) && process.env.NODE_ENV === "production") return null;
  return url.replace(/\/+$/, "");
}

/** Plain text as Teams chat HTML: escaped, line breaks kept. */
const chatHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

/** A plain error for a refused call: the status and Attendee's short message, never the key or the request. */
async function failure(what: string, res: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { detail?: unknown; error?: unknown; message?: unknown };
    detail = String(body.detail ?? body.error ?? body.message ?? "").replace(/\s+/g, " ").slice(0, 200);
  } catch {
    // not JSON
  }
  return new Error(`Sidekick's meeting bot couldn't ${what} (${res.status}${detail ? `: ${detail}` : ""}).`);
}

/** The self-hosted Attendee provider, or null when it isn't configured. */
export function attendeeProvider(): LiveProvider | null {
  const key = process.env.ATTENDEE_API_KEY?.trim();
  const base = baseUrl();
  if (!key || !base) return null;
  const call = async (path: string, body: unknown, what: string) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw await failure(what, res);
    return res.json().catch(() => ({})) as Promise<Record<string, unknown>>;
  };
  const bot = (id: string) => `/api/v1/bots/${encodeURIComponent(id)}`;
  return {
    id: "attendee",
    can: { raiseHand: process.env.ATTENDEE_RAISE_HAND === "1", speak: true },
    async join({ meetingUrl, botName, webhookUrl, sessionId }) {
      const out = await call("/api/v1/bots", {
        meeting_url: meetingUrl,
        bot_name: botName,
        metadata: { sidekick_session: sessionId },
        // Teams' own captions: Microsoft transcribes inside Teams, nothing goes to another company. Trial: caption
        // latency with several speakers, and the captions language setting.
        transcription_settings: { meeting_closed_captions: { teams_language: "en-us" } },
        // No recording at all: Sidekick only needs the captions.
        recording_settings: { format: "none" },
        webhooks: [{ url: webhookUrl, triggers: ["bot.state_change", "transcript.update", "chat_messages.update", "participant_events.join_leave", "participant_events.speech_start_stop"] }],
      }, "join the meeting");
      const botId = typeof out.id === "string" ? out.id : "";
      if (!botId) throw new Error("Sidekick's meeting bot didn't return a bot id.");
      return { botId };
    },
    async stop(botId) {
      try {
        await call(`${bot(botId)}/leave`, {}, "leave the meeting");
      } catch (e) {
        if (e instanceof Error && /\((400|404|409)\b/.test(e.message)) return;
        throw e;
      }
    },
    async sendChatMessage(botId, text) {
      await call(`${bot(botId)}/send_chat_message`, { to: "everyone", message: chatHtml(text.slice(0, 4000)) }, "post in the meeting chat");
    },
    async raiseHand(botId, up) {
      await call(`${bot(botId)}/raise_hand`, { raised: up }, up ? "raise its hand" : "lower its hand");
    },
    async speak(botId, mp3Base64) {
      await call(`${bot(botId)}/output_audio`, { type: "audio/mp3", data: mp3Base64 }, "speak in the meeting");
    },
    verify(headers, rawBody) {
      return verifyAttendeeWebhook(process.env.ATTENDEE_WEBHOOK_SECRET?.trim(), headers, rawBody);
    },
    parse(body) {
      const list = Array.isArray(body) ? body : [body];
      const out: LiveEvent[] = [];
      for (const item of list.slice(0, 50)) {
        if (!item || typeof item !== "object") continue;
        const { bot_id: botId, trigger, data } = item as { bot_id?: unknown; trigger?: unknown; data?: Record<string, unknown> };
        if (typeof botId !== "string" || !botId || typeof trigger !== "string" || !data) continue;
        const str = (v: unknown, n = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
        if (trigger === "bot.state_change") {
          const status = statusOf(String(data.new_state ?? ""));
          const meta = (data.event_metadata ?? {}) as Record<string, unknown>;
          const remover = str(meta.remover_name);
          if (status) out.push({ kind: "status", botId, status, detail: remover ? `removed by ${remover}` : str(data.event_type) });
        } else if (trigger === "transcript.update") {
          const text = str((data.transcription as { transcript?: unknown } | undefined)?.transcript, 2000);
          if (text) out.push({ kind: "line", botId, speaker: str(data.speaker_name), text: text.replace(/\s+/g, " "), source: "speech" });
        } else if (trigger === "chat_messages.update") {
          const text = str(data.text, 2000);
          if (text) out.push({ kind: "line", botId, speaker: str(data.sender_name), text: text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), source: "chat" });
        } else if (trigger === "participant_events.join_leave" || trigger === "participant_events.speech_start_stop") {
          const type = String(data.event_type ?? "");
          const name = str(data.participant_name);
          // Guests are told apart by the "(Guest)"/"(External)" Teams adds to their shown name (sessions.ts). Trial: whether
          // Attendee's participant ids say more.
          if (type === "join") out.push({ kind: "participant", botId, name, tenantId: null, guest: false });
          else if (type === "speech_start" || type === "speech_stop") out.push({ kind: "speech", botId, name, speaking: type === "speech_start" });
        }
      }
      return out;
    },
  };
}
