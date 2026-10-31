/**
 * @file The voices Sidekick may speak with in live meetings: a short curated list of Azure AI Speech neural voices
 * (male, female and neutral, several English accents; names checked on Microsoft Learn's voice list, Oct 31, 2026) and
 * the speaking speed. Pure data and checks, no imports, so the portal's pickers and the server share one list.
 *
 * Concepts
 * - **Where it's chosen**: an organization default (Settings, Org Owner/Admin: `orgs.live_voice`) and a per-group
 *   override in the group's live-meeting settings (`LiveSettings.voiceId` / `speed`, Team Lead or admin). The group's
 *   choice wins, then the organization's, then `DEFAULT_VOICE` at normal speed (lib/live-meetings/speech-settings.ts).
 * - **Only ids are stored**, and only ids from `VOICES` are accepted.
 * - **Speed** 0.9× to 1.2× in steps of 0.05 (SSML prosody rate).
 */

/** One voice: its Azure id, the name people see, and how it sounds. */
export type Voice = { id: string; label: string; gender: "female" | "male" | "neutral"; accent: string };

/** The voices people can pick, in the order the picker shows them. */
export const VOICES: readonly Voice[] = [
  { id: "en-US-AndrewMultilingualNeural", label: "Andrew", gender: "male", accent: "American" },
  { id: "en-US-AvaMultilingualNeural", label: "Ava", gender: "female", accent: "American" },
  { id: "en-US-BlueNeural", label: "Blue", gender: "neutral", accent: "American" },
  { id: "en-GB-RyanNeural", label: "Ryan", gender: "male", accent: "British" },
  { id: "en-GB-SoniaNeural", label: "Sonia", gender: "female", accent: "British" },
  { id: "en-AU-WilliamNeural", label: "William", gender: "male", accent: "Australian" },
  { id: "en-AU-NatashaNeural", label: "Natasha", gender: "female", accent: "Australian" },
  { id: "en-IN-PrabhatNeural", label: "Prabhat", gender: "male", accent: "Indian" },
  { id: "en-IN-NeerjaNeural", label: "Neerja", gender: "female", accent: "Indian" },
  { id: "en-IE-ConnorNeural", label: "Connor", gender: "male", accent: "Irish" },
  { id: "en-IE-EmilyNeural", label: "Emily", gender: "female", accent: "Irish" },
];

/** The voice when nobody chose one. */
export const DEFAULT_VOICE = "en-US-AndrewMultilingualNeural";
/** The speeds people can pick (1 = normal). */
export const SPEEDS: readonly number[] = [0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2];

/** Whether `id` is one of the allowed voices. */
export const isVoice = (id: unknown): id is string => typeof id === "string" && VOICES.some((v) => v.id === id);
/** Whether `n` is one of the allowed speeds. */
export const isSpeed = (n: unknown): n is number => typeof n === "number" && SPEEDS.some((s) => Math.abs(s - n) < 1e-9);
/** How a voice is shown: "Ava · female, American". */
export const voiceLabel = (id: string) => {
  const v = VOICES.find((x) => x.id === id);
  return v ? `${v.label} · ${v.gender}, ${v.accent}` : id;
};

/** A voice and speed as stored (JSON) or chosen; anything not allowed becomes null (fall back to the next level). */
export function parseVoice(json: string | null | undefined): { voiceId: string | null; speed: number | null } {
  let v: Record<string, unknown> = {};
  try {
    v = JSON.parse(json ?? "{}") ?? {};
  } catch {
    v = {};
  }
  return { voiceId: isVoice(v.voiceId) ? v.voiceId : null, speed: isSpeed(v.speed) ? v.speed : null };
}

/** The voice and speed Sidekick uses: the group's, else the organization's, else the default at normal speed. */
export function effectiveVoice(group: { voiceId: string | null; speed: number | null }, org: { voiceId: string | null; speed: number | null }) {
  return { voiceId: group.voiceId ?? org.voiceId ?? DEFAULT_VOICE, speed: group.speed ?? org.speed ?? 1 };
}

/** The SSML prosody rate for a speed: "+10%", "-5%", "+0%". */
export const rateOf = (speed: number) => `${speed >= 1 ? "+" : "-"}${Math.round(Math.abs(speed - 1) * 100)}%`;

/** What the "Play sample" button says (made-up content). */
export const SAMPLE_TEXT = "Hi, I'm Sidekick. The cutover moved to Saturday, and Ana owns the test report.";
