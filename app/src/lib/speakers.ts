/**
 * @file Who is speaking in a transcript passage, and which side they are on, for the answer step of Ask.
 *
 * Concepts
 * - **Speakers**: transcript lines read `[00:01:33] Tom Becker: …` (lib/extract.ts `vttToTranscript`), in meetings
 *   and in transcripts uploaded as documents. `speakersIn` lists the names in one passage.
 * - **Sides** (`sideOf`): only what Sidekick knows, never a guess from what people say or how they're named:
 *   - `team`: the name is one of the organization's (the firm's) Sidekick people (`users` of the org);
 *   - `guest`: Teams marked the speaker as a guest or external ("Tom Becker (Guest)");
 *   - `outside`: the source is a meeting marked as having client guests (`meetings.external_guests`) and the speaker
 *     isn't one of the firm's Sidekick people. Said as exactly that (they may still be a colleague without an
 *     account), so Claude can weigh it without being told something that may be wrong.
 *   Anyone else has no known side and is left out, so Claude is told not to assume one.
 * - **Privacy**: only names already in the passage are listed, with a side; never an email, job title or anything
 *   else about a guest. Matching is by the whole display name, case-insensitive.
 *
 * Who calls it: `ask` in lib/sidekick.ts (`speakerNotes`), which adds a `<speakers>` element inside each transcript
 * source of the prompt. Pure helpers are unit-tested in tests/db.test.mjs.
 */
import "server-only";
import { all, get } from "./db";
import { BRAND } from "./brand";

/** Which side a speaker is on, when known (see the file comment). */
export type Side = "team" | "guest" | "outside";

const LINE = /^\[\d{2}:\d{2}:\d{2}\] ([^:\n]{1,80}):/gm;
/** Teams' marks for people from outside the organization: "Name (Guest)", "Name (External)". */
const GUEST_MARK = /\s*\((guest|external)\)\s*$/i;

/** The speaker names in a passage, in order of first appearance, each once (as written, e.g. "Tom Becker (Guest)"). */
export function speakersIn(text: string): string[] {
  return [...new Set([...text.matchAll(LINE)].map((m) => m[1].trim()))];
}

/** A display name without Teams' guest mark, lower case, for matching against the firm's people. */
export const plainName = (name: string) => name.replace(GUEST_MARK, "").trim().toLowerCase();

/**
 * The side of one speaker, or null when it isn't known (see the file comment). `team` holds the firm's people's
 * names (from `plainName`); `guestMeeting` is true only for a meeting marked as having client guests.
 */
export function sideOf(name: string, team: Set<string>, guestMeeting: boolean): Side | null {
  if (GUEST_MARK.test(name)) return "guest";
  if (team.has(plainName(name))) return "team";
  return guestMeeting ? "outside" : null;
}

/**
 * The speaker note for one transcript passage (the body of its `<speakers>` element in the prompt): each speaker
 * with a known side on its own line, e.g.
 * "Priya Raman: Fabrikam Consulting (our team)" / "Tom Becker (Guest): guest from outside Fabrikam Consulting, marked
 * by Teams" / "Tom Becker: not one of Fabrikam Consulting's people in Sidekick; this meeting had client guests".
 * Empty when no side is known.
 */
export function speakerLine(names: string[], team: Set<string>, guestMeeting: boolean, firm: string): string {
  const lines = names.flatMap((n) => {
    const side = sideOf(n, team, guestMeeting);
    if (side === "team") return [`${n}: ${firm} (our team)`];
    if (side === "guest") return [`${n}: guest from outside ${firm}, marked by Teams`];
    if (side === "outside") return [`${n}: not one of ${firm}'s people in ${BRAND.name}; this meeting had client guests`];
    return [];
  });
  return lines.join("\n");
}

/**
 * The speaker notes for an answer's sources, by source tag (S1, S2, …): only transcript passages with at least one
 * speaker of known side get one. Looks up, scoped to the org: which speaker names are the firm's people, which
 * meetings had client guests, and the firm's name. Also returns the group's client, for the prompt.
 */
export async function speakerNotes(
  orgId: string,
  workspaceId: string,
  sources: { id: string; text: string; source_type: string; source_id: string }[],
): Promise<{ notes: Map<string, string>; client: string | null }> {
  const names = new Map(sources.map((s) => [s.id, speakersIn(s.text)]));
  const all_ = [...new Set([...names.values()].flat().map(plainName))].slice(0, 200);
  const notes = new Map<string, string>();
  const ws = await get<{ client: string | null }>("SELECT client FROM workspaces WHERE id = ? AND org_id = ?", workspaceId, orgId);
  if (!all_.length) return { notes, client: ws?.client ?? null };
  const marks = (n: number) => Array(n).fill("?").join(", ");
  const team = new Set((await all<{ n: string }>(`SELECT LOWER(name) AS n FROM users WHERE org_id = ? AND LOWER(name) IN (${marks(all_.length)})`, orgId, ...all_)).map((r) => r.n));
  const meetingIds = [...new Set(sources.filter((s) => s.source_type === "meeting").map((s) => s.source_id))];
  const guestMeetings = new Set(meetingIds.length
    ? (await all<{ id: string }>(`SELECT id FROM meetings WHERE org_id = ? AND external_guests = 1 AND id IN (${marks(meetingIds.length)})`, orgId, ...meetingIds)).map((r) => r.id)
    : []);
  const firm = (await get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", orgId))?.name ?? "the firm";
  for (const s of sources) {
    const line = speakerLine(names.get(s.id) ?? [], team, s.source_type === "meeting" && guestMeetings.has(s.source_id), firm);
    if (line) notes.set(s.id, line);
  }
  return { notes, client: ws?.client ?? null };
}
