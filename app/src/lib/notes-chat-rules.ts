/**
 * @file The plain rules behind "Meeting notes go to" (lib/notes-chats.ts): which chat is the default while nobody chose,
 * the meeting card's "Notes posted to …" footer, and the "@Sidekick post meeting notes here" command words. No database
 * or network here, so tests/db.test.mjs calls them directly.
 */

/** A linked chat as these rules see it. */
export type RuleChat = { id: string; name: string | null; kind: string; guests: number };

/**
 * The chat notes go to when nobody chose (pure, unit-tested): 1:1 chats never; a chat with "notes" in its name first
 * (internal before guest chats), else the first chat without client guests, else the first chat. `chats` oldest first.
 */
export function pickDefaultNotesChat(chats: RuleChat[]): string | null {
  const groupChats = chats.filter((c) => c.kind !== "personal");
  const named = groupChats.filter((c) => /notes/i.test(c.name ?? ""));
  return (named.find((c) => !c.guests) ?? named[0] ?? groupChats.find((c) => !c.guests) ?? groupChats[0])?.id ?? null;
}

/** One chat a meeting's notes were posted to, as remembered in `meetings.notes_posted_to` (JSON array). */
export type PostedChat = { name: string; guests: boolean };

/** Reads `meetings.notes_posted_to` (null or broken = nothing known). */
export function parsePosted(json: string | null | undefined): PostedChat[] {
  try {
    const v = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? v.filter((c) => c && typeof c.name === "string").map((c) => ({ name: c.name as string, guests: Boolean(c.guests) })) : [];
  } catch {
    return [];
  }
}

/**
 * The meeting card's footer line: where these notes were posted (pure, unit-tested). In a chat with client guests only
 * the other guest chats are named, so the client never learns the names of the team's internal chats.
 */
export function postedToLine(posted: PostedChat[], viewerHasGuests: boolean): string | null {
  const names = posted.filter((c) => !viewerHasGuests || c.guests).map((c) => c.name);
  if (!names.length) return null;
  return names.length === 1 ? `Notes posted to ${names[0]} only.` : `Notes posted to: ${names.join(", ")}.`;
}

/**
 * Recognises the notes command in what someone wrote after @mentioning Sidekick: `"here"` for "post meeting notes
 * here" and close variants ("notes here", "send meeting notes here", "put the notes here"), `"stop"` for "stop posting
 * notes here" ("don't post notes here", "no notes here"), else null (an ordinary question). Pure; tested directly.
 */
export function parseNotesCommand(text: string): "here" | "stop" | null {
  const t = text.toLowerCase().replace(/[’']/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(please |hey |ok |okay )+/, "").replace(/( please| thanks| thank you)+$/, "");
  if (/^(post|send|put|share|drop) (the |our |all |any )?(meeting )?notes (in |to )?here$/.test(t) || /^(the |our )?(meeting )?notes (go )?here$/.test(t)) return "here";
  if (/^(stop|quit) (posting|sending|putting|sharing) (the |our )?(meeting )?notes (in |to )?here$/.test(t)
    || /^(dont|do not|no more|never) (post|send|put|share) (the |our |any )?(meeting )?notes (in |to )?here( any more| anymore)?$/.test(t)
    || /^no (more )?(meeting )?notes here$/.test(t)) return "stop";
  return null;
}
