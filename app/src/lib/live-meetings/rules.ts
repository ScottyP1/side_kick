/**
 * @file The pure rules of "Sidekick live in Teams meetings" (docs/LIVE-MEETINGS.md): what counts as talking to
 * Sidekick in a meeting, Teams meeting links, guests by their shown name, live minutes, and the fixed messages Sidekick
 * posts in the meeting chat. No I/O and no server imports, so pages can show the same wording and the unit tests
 * (tests/db.test.mjs) can check every rule. Who may call: lib/live-meetings/sessions.ts, lib/teams/bot.ts, pages.
 */
import { BRAND } from "../brand";

/** The name Sidekick's meeting bot shows in the participant list. */
export const BOT_NAME = `${BRAND.name} (notes)`;

/** A group's switch: off (default), join when someone asks (`@Sidekick join`), or join every group meeting. */
export const LIVE_MODES = ["off", "ask", "auto"] as const;
export type LiveMode = (typeof LIVE_MODES)[number];
/** How each mode is shown on the group page. */
export const LIVE_MODE_LABEL: Record<LiveMode, string> = { off: "Off", ask: "When someone asks", auto: "Every group meeting" };

/** Longest a session may run before Sidekick leaves by itself. */
export const MAX_SESSION_MS = 4 * 3600_000;
/** How long Sidekick waits in the lobby before giving up. */
export const LOBBY_TIMEOUT_MS = 15 * 60_000;
/** Most answers Sidekick gives in one meeting (a runaway loop can't spend the AI credit). */
export const MAX_ANSWERS = 60;

/**
 * What a line of the meeting asks of Sidekick: a question addressed to it, leave, recap, quiet mode on or off, being
 * called on ("go ahead, Sidekick"), or only its name (the question may come in the next line).
 */
export type Trigger =
  | { kind: "question"; question: string }
  | { kind: "leave" }
  | { kind: "recap" }
  | { kind: "quiet" }
  | { kind: "unquiet" }
  | { kind: "called" }
  | { kind: "name" };

const NAME = String.raw`side\s?-?kick`;
// "Sidekick, …" at the start of what someone said or typed, or after a sentence ends ("Okay. Sidekick, …"), with an
// optional "hey"/"ok" first. Speech-to-text writes the name with or without a comma.
const CALL = new RegExp(String.raw`(?:^|[.!?]\s+)(?:(?:hey|hi|ok|okay|so|and|um|uh)[\s,]+)?@?${NAME}\b[\s,:;.!?-]*(.*)$`, "i");
// "…, Sidekick?" at the end: the question comes first ("What do you think, Sidekick?").
const TRAILING = new RegExp(String.raw`^(.{3,}?)[\s,;:-]+@?${NAME}\s*[?.!]*$`, "i");
// Being called on while its hand is up: "go ahead Sidekick", "Sidekick, go ahead", "yes, Sidekick", "Sidekick?".
const CALLED = new RegExp(String.raw`^(?:(?:ok(?:ay)?|yes|yeah|sure|right|so)[\s,]+)?(?:(?:go ahead|go on|yes|yeah|please|over to you|your turn|you had (?:your|a) hand up)[\s,]+${NAME}|${NAME}[\s,]+(?:go ahead|go on|please|yes|over to you|your turn|you had (?:your|a) hand up))\b[\s.!?]*$`, "i");
const LEAVE = /^(?:please\s+)?(?:leave|stop|stop listening|go away|leave (?:the|this) (?:meeting|call)|you can (?:leave|go)|bye)\b[\s.!]*$/i;
const RECAP = /^(?:(?:give (?:us|me) )?(?:a |the )?recap|summari[sz]e|(?:what|which) (?:have|did) we (?:decide|decided|agree|agreed)(?: so far)?|(?:what are )?(?:the )?(?:decisions|action items)(?: so far)?)\b[\s?.!]*$/i;
const QUIET = /^(?:please\s+)?(?:be quiet|quiet(?: mode)?|mute|go quiet|hush|stay quiet|(?:only|just) (?:answer|speak) when (?:asked|i ask))\b[\s.!]*$/i;
const UNQUIET = /^(?:you can (?:speak up|talk|chime in|join in)(?: again)?|speak up|unmute|feel free to (?:chime|jump) in)\b[\s.!]*$/i;

/**
 * What a line said or typed in the meeting asks of Sidekick, or null when it isn't addressed to Sidekick (see
 * `Trigger`). A question is at most 1,000 characters; too short to be one → null (or `name` when only the name was said).
 */
export function parseTrigger(text: string): Trigger | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (CALLED.test(t)) return { kind: "called" };
  const m = CALL.exec(t);
  if (m) {
    const rest = m[1].trim();
    if (LEAVE.test(rest)) return { kind: "leave" };
    if (RECAP.test(rest)) return { kind: "recap" };
    if (QUIET.test(rest)) return { kind: "quiet" };
    if (UNQUIET.test(rest)) return { kind: "unquiet" };
    const question = rest.slice(0, 1000).trim();
    if (question.replace(/[^\p{L}\p{N}]/gu, "").length >= 3) return { kind: "question", question };
    return /^[\s,.!?]*$/.test(rest) && m.index === 0 ? { kind: "name" } : null;
  }
  const tail = TRAILING.exec(t);
  if (tail && tail[1].replace(/[^\p{L}\p{N}]/gu, "").length >= 6) return { kind: "question", question: `${tail[1].trim().replace(/[,;:-]+$/, "")}?`.replace(/\?\?$/, "?") };
  return null;
}

const ASKING = /^(?:who|what|when|where|which|why|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|any(?:one|body))\b/i;
const NOT_A_QUESTION = /^(?:how are you|how's it going|can you hear me|can everyone (?:see|hear)|is (?:everyone|everybody) here|are we recording|do you see my screen|can you see my screen|what's up|shall we start)\b/i;

/**
 * Whether a line is a question put to the room (not to Sidekick, not to someone by name): it ends with "?" or starts
 * like a question, has at least 4 words, isn't small talk or meeting housekeeping ("can you hear me?"), and doesn't
 * start or end with the name of someone in the meeting ("Lou, when is…"). Questions to Sidekick are `parseTrigger`'s.
 */
export function isRoomQuestion(text: string, people: string[] = []): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.split(" ").length < 4 || NOT_A_QUESTION.test(t)) return false;
  if (!/\?\s*$/.test(t) && !ASKING.test(t)) return false;
  const lower = t.toLowerCase();
  for (const p of people) {
    const first = p.toLowerCase().replace(/\(.*\)/, "").trim().split(" ")[0];
    if (first.length >= 2 && (lower.startsWith(`${first},`) || lower.startsWith(`${first} `) || new RegExp(`[,\\s]${first}\\s*\\?\\s*$`).test(lower))) return false;
  }
  return true;
}

/** Whether a reply to a room question means nobody knows ("not sure", "no idea", "good question", "does anyone know?"). */
export const isNonAnswer = (text: string) =>
  /^(?:(?:um+|uh+|hmm+|er+|well)[\s,.]*)*(?:i'?m not sure|not sure|no idea|i don'?t know|don'?t know|dunno|good question|i(?: have| do)?n'?t (?:got|have) (?:that|it)|i can'?t remember|does anyone know|anyone\??|no clue|i forget|(?:let me|i'?ll) (?:check|find out))\b/i.test(text.replace(/\s+/g, " ").trim());

/** The group's live-meeting settings (lib/live-meetings/sessions.ts `groupSettings`). */
export type LiveSettings = {
  /** `addressed`: only questions to Sidekick; `room`: also questions to the room that nobody answers. */
  answer: "addressed" | "room";
  /** `off`: chat only; `called`: speaks when asked or called on; `auto`: also after a pause when its hand is up. */
  voice: "off" | "called" | "auto";
  /** Seconds of silence before speaking by itself (`voice: auto`). */
  pauseS: number;
  /** Whether Sidekick asks its own questions (an action item with no owner or date). */
  ask: boolean;
};
/** Defaults (Cody, Oct 29): room questions on, hand up, speaks only when asked or called on, asks its own questions. */
export const DEFAULT_SETTINGS: LiveSettings = { answer: "room", voice: "called", pauseS: 6, ask: true };
/** How each setting is shown on the group page. */
export const ANSWER_LABEL: Record<LiveSettings["answer"], string> = { addressed: "Only questions to Sidekick", room: "Also questions nobody answers" };
export const VOICE_LABEL: Record<LiveSettings["voice"], string> = { off: "Chat only", called: "Speak when asked or called on", auto: "Also speak after a pause" };

/** Reads stored settings (JSON) over the defaults; anything unknown or out of range is the default. */
export function parseSettings(json: string | null | undefined): LiveSettings {
  let v: Record<string, unknown> = {};
  try {
    v = JSON.parse(json ?? "{}") ?? {};
  } catch {
    v = {};
  }
  const pause = Number(v.pauseS);
  return {
    answer: v.answer === "addressed" || v.answer === "room" ? v.answer : DEFAULT_SETTINGS.answer,
    voice: v.voice === "off" || v.voice === "called" || v.voice === "auto" ? v.voice : DEFAULT_SETTINGS.voice,
    pauseS: Number.isInteger(pause) && pause >= 2 && pause <= 30 ? pause : DEFAULT_SETTINGS.pauseS,
    ask: typeof v.ask === "boolean" ? v.ask : DEFAULT_SETTINGS.ask,
  };
}

/** Whether an answer is good enough to volunteer to the room unasked: found, cited, no conflict, not refused. */
export const confident = (r: { found: boolean; sources: unknown[]; conflict: boolean; blocked?: string | null }) => r.found && r.sources.length > 0 && !r.conflict && !r.blocked;

/**
 * The short spoken version of an answer: citation tags and formatting removed, the first sentence or two, at most about
 * 45 words (the full answer with sources goes to the chat).
 */
export function spokenText(answer: string): string {
  const plain = answer.replace(/\[S\d+\]/g, "").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  const sentences = plain.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [plain];
  let out = "";
  for (const [i, s] of sentences.entries()) {
    const next = `${out} ${s.trim()}`.trim();
    if (out && next.split(" ").length > 45) break;
    out = next;
    if (i >= 1 || out.split(" ").length >= 25) break;
  }
  const words = out.split(" ");
  return words.length > 45 ? `${words.slice(0, 45).join(" ")}…` : out;
}

/** In the chat when the bot can't raise its hand in Teams (Recall.ai, or our bot without the patch). */
export const HAND_NOTE = `✋ I can help with that. Say “go ahead, ${BRAND.name}” and I'll answer.`;

/** Sidekick's own question about an action item that has no owner or no date (asked once per item). */
export function ownQuestion(item: { text: string; who: string | null; due?: string | null }): string | null {
  if (!item.who && !item.due) return `Quick check: who's taking “${item.text}”, and by when?`;
  if (!item.who) return `Quick check: who's taking “${item.text}”?`;
  if (!item.due) return `Quick check: by when should ${item.who} do “${item.text}”?`;
  return null;
}

/** A Teams chat command for live meetings (`@Sidekick join [link]`, `@Sidekick leave`), or null. */
export function parseLiveCommand(text: string): { kind: "join"; url: string | null } | { kind: "leave" } | null {
  const t = text.replace(/\s+/g, " ").trim();
  const join = /^(?:please\s+)?join(?:\s+(?:this|the)\s+(?:meeting|call))?(?:\s+(\S+))?\s*[.!]?$/i.exec(t);
  if (join) return { kind: "join", url: join[1] ? join[1].replace(/^<|>$/g, "") : null };
  if (/^(?:please\s+)?(?:leave|stop listening)(?:\s+(?:this|the)\s+(?:meeting|call))?\s*[.!]?$/i.test(t)) return { kind: "leave" };
  return null;
}

/** Whether `url` is a Microsoft Teams meeting link Sidekick may send its bot to (https, a Teams host, at most 2,000 characters). */
export function isTeamsMeetingUrl(url: string): boolean {
  if (url.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (!["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft", "gov.teams.microsoft.us"].includes(host)) return false;
  return /^\/(?:l\/meetup-join\/|meet\/|v2\/)/i.test(u.pathname);
}

/**
 * The meeting chat's thread id carried by a classic Teams join link ("/l/meetup-join/19%3ameeting_…%40thread.v2/0"),
 * or null (short "/meet/<id>" links don't carry it).
 */
export function meetingThreadFromUrl(url: string): string | null {
  const m = /\/l\/meetup-join\/([^/?#]+)/i.exec(url);
  if (!m) return null;
  try {
    const thread = decodeURIComponent(m[1]);
    return /^19:[\w.-]+@thread\.(?:v2|skype|tacv2)$/i.test(thread) ? thread : null;
  } catch {
    return null;
  }
}

/** Whether a participant's shown name marks them as from outside the organization ("Pat (Guest)", "Ana (External)"). */
export const looksExternal = (name: string | null | undefined) => /\((?:guest|external|unverified)\)\s*$/i.test(name ?? "");

/** Minutes a session has been (or was) in the meeting: joined → ended, or → `at` while it's still live; 0 if never joined. */
export function liveMinutes(joinedAt: string | null, endedAt: string | null, at = Date.now()): number {
  if (!joinedAt) return 0;
  const end = endedAt ? Date.parse(endedAt) : at;
  const ms = end - Date.parse(joinedAt);
  return Number.isFinite(ms) && ms > 0 ? ms / 60_000 : 0;
}

/** Sidekick's first message in the meeting chat: who it is, how to ask, how to remove it, and the guest rule. */
export function introText(group: string, guests: boolean): string {
  return [
    `Hi, I'm ${BOT_NAME}, listening for ${group}. Ask me by saying or typing “${BRAND.name}, …”. I keep a list of decisions and action items, and the notes go to the group's chat afterwards.`,
    guests ? "Client guests are here, so I only use sources marked Shareable." : null,
    `To remove me, say “${BRAND.name}, leave”, type @${BRAND.name} leave, or remove ${BOT_NAME} from the participants.`,
  ].filter(Boolean).join(" ");
}

/** The note Sidekick posts when it first notices a guest: from now on, Shareable sources only. */
export const GUEST_NOTICE = "Someone from outside your organization joined, so from now on I only use sources marked Shareable.";

/** A decision or action item on the running list. */
export type ListItem = { text: string; who: string | null; due?: string | null };

/** "Sidekick, recap": the running list read back in plain text (or that there's nothing yet). */
export function recapText(decisions: ListItem[], actions: ListItem[]): string {
  if (!decisions.length && !actions.length) return "Nothing decided or assigned yet that I've noted. I update the list every few minutes.";
  const lines: string[] = [];
  if (decisions.length) lines.push("Decisions so far:", ...decisions.map((d, i) => `${i + 1}. ${d.text}${d.who ? ` (${d.who})` : ""}`));
  if (actions.length) lines.push("Action items so far:", ...actions.map((a, i) => `${i + 1}. ${a.text}${a.who ? `: ${a.who}` : ""}${a.due ? `, by ${a.due}` : ""}`));
  return lines.join("\n");
}

/** A cited source as the meeting chat shows it. */
export type ChatSource = { id: string; title: string; loc?: string | null };

/**
 * An answer as plain text for the meeting chat (the provider's chat message has no cards): the question, the answer
 * and its numbered sources, at most 4,000 characters.
 */
export function answerText(question: string, answer: string, sources: ChatSource[]): string {
  const head = `${BRAND.name} · “${question.length > 140 ? `${question.slice(0, 137)}…` : question}”`;
  const src = sources.length ? `\nSources: ${sources.map((s) => `[${s.id}] ${s.title}${s.loc ? ` (${s.loc})` : ""}`).join("; ")}` : "";
  const text = `${head}\n${answer}${src}`;
  return text.length > 4000 ? `${text.slice(0, 3999)}…` : text;
}
