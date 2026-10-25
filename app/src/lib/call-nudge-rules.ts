/**
 * @file The plain rules behind the "turn on transcription" nudge (lib/call-nudge.ts): reading call events out of a
 * Teams chat's recent messages, deciding when a call needs a nudge, and recognising the Teams commands that switch
 * the nudge off and on. No database or network here, so tests/db.test.mjs calls these directly.
 *
 * Concepts
 * - **Call events**: when someone starts a call in a group chat (Meet now, or the call button), Teams posts a system
 *   message in that chat (`messageType` "systemEventMessage", or "unknownFutureValue" without the Prefer header) whose
 *   `eventDetail` says what happened, with the call's id: `callStartedEventMessageDetail`, `callEndedEventMessageDetail`,
 *   `callTranscriptEventMessageDetail` (a transcript of that call exists) and `callRecordingEventMessageDetail`.
 *   Documented in Microsoft Graph "Get system messages" (https://learn.microsoft.com/graph/system-messages).
 * - **Transcribing**: a transcript or recording event for the call counts as "someone turned it on". Microsoft doesn't
 *   document whether the transcript event appears when transcription starts or only once the transcript is ready, so
 *   the card itself says "if someone already started it, ignore this".
 * - **Due**: a call that started at least `NUDGE_AFTER_MS` ago, hasn't ended, shows no transcript/recording event and
 *   started within `LOOKBACK_MS` (older calls are left alone: e.g. right after Sidekick starts watching a chat).
 */

/** How long after a call starts Sidekick waits for transcription before nudging. */
export const NUDGE_AFTER_MS = 2 * 60_000;
/** Calls that started longer ago than this are never nudged (nor remembered). */
export const LOOKBACK_MS = 30 * 60_000;

/** One call seen in a chat's recent messages. */
export type SeenCall = {
  /** Teams' call id (the same in every event of that call). */
  callId: string;
  /** When the "call started" event was posted (ISO), or null when only later events were seen. */
  startedAt: string | null;
  /** A "call ended" event was seen. */
  ended: boolean;
  /** A transcript or recording event was seen (someone turned transcription or recording on). */
  transcribing: boolean;
};

/** The parts of a Graph chatMessage these rules read. */
export type GraphChatMessage = {
  createdDateTime?: unknown;
  eventDetail?: { "@odata.type"?: unknown; callId?: unknown } | null;
};

/** The event kind of a chat message ("callStarted", "callEnded", …), from `eventDetail["@odata.type"]`, or null. */
function eventKind(m: GraphChatMessage): string | null {
  const t = m.eventDetail?.["@odata.type"];
  if (typeof t !== "string") return null;
  const k = /^#?microsoft\.graph\.(\w+)EventMessageDetail$/i.exec(t);
  return k ? k[1] : null;
}

/**
 * Groups a chat's recent messages (any order, Graph's `GET /chats/{id}/messages`) into the calls they mention, keyed
 * by call id. Messages that aren't call events, or have no call id, are ignored. When a call was started twice (a
 * rare repeat event), the earliest start counts.
 */
export function callsFromMessages(messages: GraphChatMessage[]): SeenCall[] {
  const calls = new Map<string, SeenCall>();
  for (const m of messages) {
    const kind = eventKind(m)?.toLowerCase();
    const id = m.eventDetail?.callId;
    if (!kind || typeof id !== "string" || !id || id.length > 200) continue;
    const c = calls.get(id) ?? { callId: id, startedAt: null, ended: false, transcribing: false };
    if (kind === "callstarted" && typeof m.createdDateTime === "string" && !Number.isNaN(Date.parse(m.createdDateTime))) {
      const at = new Date(m.createdDateTime).toISOString();
      if (!c.startedAt || at < c.startedAt) c.startedAt = at;
    } else if (kind === "callended") c.ended = true;
    else if (kind === "calltranscript" || kind === "callrecording") c.transcribing = true;
    else continue;
    calls.set(id, c);
  }
  return [...calls.values()];
}

/** Whether a call is recent enough to keep track of (it started within `LOOKBACK_MS` of `at`). */
export function recentCall(c: Pick<SeenCall, "startedAt">, at: Date): boolean {
  return !!c.startedAt && at.getTime() - Date.parse(c.startedAt) <= LOOKBACK_MS;
}

/**
 * Whether this call should get the nudge now: recent (`recentCall`), started at least `NUDGE_AFTER_MS` before `at`,
 * not ended and nobody turned transcription or recording on.
 */
export function nudgeDue(c: SeenCall, at: Date): boolean {
  if (!c.startedAt || c.ended || c.transcribing || !recentCall(c, at)) return false;
  return at.getTime() - Date.parse(c.startedAt) >= NUDGE_AFTER_MS;
}

/**
 * Recognises "@Sidekick stop transcription reminders" (→ "off") and "@Sidekick start transcription reminders"
 * (→ "on") in a few natural wordings ("turn off/on", "no more", "mute", "nudges"/"reminders"/"reminder"), any case,
 * with or without trailing punctuation. Anything else → null (an ordinary question).
 */
export function parseNudgeCommand(text: string): "off" | "on" | null {
  const t = text.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  const what = "(?:the )?(?:transcription|transcript|transcribe) (?:reminders?|nudges?)";
  if (new RegExp(`^(?:stop|turn off|switch off|disable|mute|no more) ${what}(?: here| please| in this chat)*$`).test(t)) return "off";
  if (new RegExp(`^(?:start|turn on|switch on|enable|resume) ${what}(?: here| please| in this chat| again)*$`).test(t)) return "on";
  return null;
}
