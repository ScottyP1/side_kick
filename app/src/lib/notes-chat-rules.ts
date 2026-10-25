/**
 * @file The plain rules behind "Meeting notes go to" (lib/notes-chats.ts): which chat is the default while nobody chose,
 * and the meeting card's "Notes posted to …" footer. No database or network here, so tests/db.test.mjs calls them directly.
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

