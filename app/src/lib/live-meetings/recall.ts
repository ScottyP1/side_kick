/**
 * @file Recall.ai as a **hosted** live-meeting provider, used only for organizations whose Org Owner opted in
 * (lib/live-meetings/provider.ts; the self-hosted bot is the default; comparison: docs/LIVE-MEETINGS.md).
 * Written from Recall's public API docs (read Oct 29, 2026) and exercised against the tests' fake Recall server; **not
 * yet tried against the real service** (nothing is signed up). Things to confirm on the first real trial are marked
 * "Trial:" below.
 *
 * Concepts
 * - **Where**: `RECALL_BASE_URL` (tests and local fakes; plain http only outside production), else
 *   `https://<RECALL_REGION>.recall.ai` (`us-east-1` by default; `eu-central-1` for EU data residency). Each region is
 *   its own Recall account with its own key.
 * - **Auth**: `Authorization: Token <RECALL_API_KEY>`. Webhooks: `SIDEKICK_LIVE_WEBHOOK_SECRET` = Recall's workspace
 *   verification secret (`whsec_…`), checked with the Standard Webhooks scheme on every request.
 * - **Join** (`POST /api/v1/bot/`): the meeting link, the bot's name, Recall's own low-latency streaming transcription
 *   (English, 1–3 s), and a real-time webhook endpoint for transcript lines, chat messages and participants. Status
 *   changes (`bot.in_call_recording`, `bot.call_ended`, `bot.fatal`, …) come from the webhook set up once in Recall's
 *   dashboard, pointed at the same address. Sidekick asks for no video and the shortest retention it can (Trial:
 *   check the `retention` field's exact shape and that no video is stored).
 * - **Chat** (`POST /api/v1/bot/:id/send_chat_message/`): to everyone, at most 4,096 characters. Teams channel meetings
 *   can't receive bot chat messages (Recall's limitation), so Sidekick prefers its own Teams bot when it's in the chat.
 * - **Stop** (`POST /api/v1/bot/:id/leave_call/`).
 * - **Speaking** (`POST /api/v1/bot/:id/output_audio/`, MP3 from Azure AI Speech, lib/live-meetings/speech.ts). Trial:
 *   Recall says the bot must be created with `automatic_audio_output` for this endpoint to work.
 * - **Raising its hand**: Recall has no API for it (checked Oct 29, 2026), so Sidekick puts "✋" in the chat instead.
 *
 * Who may call: lib/live-meetings/provider.ts `providerById("recall")` only.
 */
import "server-only";
import type { LiveEvent, LiveProvider, LiveStatus } from "./provider";
import { verifyStandardWebhook } from "./signature";

/** Recall's status codes (`bot.<code>` events) in Sidekick's words. Unknown codes are ignored. */
const STATUS: Record<string, LiveStatus> = {
  joining_call: "joining",
  in_waiting_room: "waiting",
  in_call_not_recording: "in_call",
  in_call_recording: "in_call",
  recording_permission_allowed: "in_call",
  call_ended: "ended",
  done: "ended",
  fatal: "failed",
  recording_permission_denied: "failed",
};

/** Recall's API address for this copy (see the file header), or null when it isn't configured. */
function baseUrl(): string | null {
  const explicit = process.env.RECALL_BASE_URL?.trim();
  if (explicit) {
    if (!/^https:\/\//i.test(explicit) && process.env.NODE_ENV === "production") return null;
    return explicit.replace(/\/+$/, "");
  }
  const region = (process.env.RECALL_REGION || "us-east-1").trim();
  return /^[a-z]{2}-[a-z]+-\d$/.test(region) ? `https://${region}.recall.ai` : null;
}

/** A plain error for a refused call: Recall's status and its short `detail`, never the key or the request. */
async function failure(what: string, res: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { detail?: unknown; message?: unknown };
    detail = String(body.detail ?? body.message ?? "").replace(/\s+/g, " ").slice(0, 200);
  } catch {
    // not JSON: the status says enough
  }
  return new Error(`The meeting-bot service couldn't ${what} (${res.status}${detail ? `: ${detail}` : ""}).`);
}

/** The text of a Recall transcript event: its words joined with spaces. */
const wordsText = (words: unknown) => (Array.isArray(words) ? words.map((w) => (w && typeof w === "object" ? String((w as { text?: unknown }).text ?? "") : "")).join(" ") : "").replace(/\s+/g, " ").trim();

/**
 * The Recall.ai provider, or null when `RECALL_API_KEY` or the address is missing. A new object each call (cheap),
 * so a changed environment takes effect without a restart in development.
 */
export function recallProvider(): LiveProvider | null {
  const key = process.env.RECALL_API_KEY?.trim();
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
  return {
    id: "recall",
    can: { raiseHand: false, speak: true },
    async join({ meetingUrl, botName, webhookUrl, sessionId }) {
      const out = await call("/api/v1/bot/", {
        meeting_url: meetingUrl,
        bot_name: botName,
        metadata: { sidekick_session: sessionId },
        recording_config: {
          transcript: { provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } }, diarization: { use_separate_streams_when_available: true } },
          realtime_endpoints: [{ type: "webhook", url: webhookUrl, events: ["transcript.data", "participant_events.chat_message", "participant_events.join", "participant_events.speech_on", "participant_events.speech_off"] }],
          // Trial: the shortest retention Recall accepts; Sidekick never downloads media.
          retention: { type: "timed", hours: 24 },
        },
      }, "send the bot to the meeting");
      const botId = typeof out.id === "string" ? out.id : "";
      if (!botId) throw new Error("The meeting-bot service didn't return a bot id.");
      return { botId };
    },
    async stop(botId) {
      try {
        await call(`/api/v1/bot/${encodeURIComponent(botId)}/leave_call/`, {}, "make the bot leave");
      } catch (e) {
        // Already gone (the meeting ended first): nothing to stop.
        if (e instanceof Error && /\((400|404|409)\b/.test(e.message)) return;
        throw e;
      }
    },
    async sendChatMessage(botId, text) {
      await call(`/api/v1/bot/${encodeURIComponent(botId)}/send_chat_message/`, { to: "everyone", message: text.slice(0, 4000) }, "post in the meeting chat");
    },
    async raiseHand() {
      throw new Error("Recall.ai can't raise a hand.");
    },
    async speak(botId, mp3Base64) {
      await call(`/api/v1/bot/${encodeURIComponent(botId)}/output_audio/`, { kind: "mp3", b64_data: mp3Base64 }, "speak in the meeting");
    },
    verify(headers, rawBody) {
      return verifyStandardWebhook(process.env.SIDEKICK_LIVE_WEBHOOK_SECRET?.trim(), headers, rawBody);
    },
    parse(body) {
      const list = Array.isArray(body) ? body : [body];
      const out: LiveEvent[] = [];
      for (const item of list.slice(0, 50)) {
        if (!item || typeof item !== "object") continue;
        const { event, data } = item as { event?: unknown; data?: { data?: Record<string, unknown>; bot?: { id?: unknown } } };
        if (typeof event !== "string" || !data) continue;
        const botId = typeof data.bot?.id === "string" ? data.bot.id : "";
        if (!botId) continue;
        const inner = data.data ?? {};
        const participant = (inner.participant ?? {}) as { name?: unknown; extra_data?: Record<string, unknown> | null };
        const name = typeof participant.name === "string" && participant.name.trim() ? participant.name.trim().slice(0, 120) : null;
        if (event === "transcript.data") {
          const text = wordsText(inner.words);
          if (text) out.push({ kind: "line", botId, speaker: name, text: text.slice(0, 2000), source: "speech" });
        } else if (event === "participant_events.chat_message") {
          const text = String((inner.data as { text?: unknown } | undefined)?.text ?? "").replace(/\s+/g, " ").trim();
          if (text) out.push({ kind: "line", botId, speaker: name, text: text.slice(0, 2000), source: "chat" });
        } else if (event === "participant_events.join") {
          // Trial: which `extra_data` fields Teams fills in (tenant, guest). Teams also marks guests in the shown name.
          const extra = participant.extra_data ?? {};
          const teams = (extra.microsoft_teams ?? extra) as Record<string, unknown>;
          const tenantId = typeof teams.tenant_id === "string" ? teams.tenant_id : typeof teams.tenantId === "string" ? teams.tenantId : null;
          const guest = teams.is_guest === true || teams.anonymous === true || teams.is_anonymous === true;
          out.push({ kind: "participant", botId, name, tenantId, guest });
        } else if (event === "participant_events.speech_on" || event === "participant_events.speech_off") {
          out.push({ kind: "speech", botId, name, speaking: event === "participant_events.speech_on" });
        } else if (event.startsWith("bot.")) {
          const code = typeof inner.code === "string" ? inner.code : event.slice(4);
          const status = STATUS[code];
          if (status) out.push({ kind: "status", botId, status, detail: typeof inner.sub_code === "string" ? inner.sub_code.slice(0, 120) : null });
        }
      }
      return out;
    },
  };
}
