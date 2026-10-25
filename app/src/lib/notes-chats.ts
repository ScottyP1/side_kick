/**
 * @file "Meeting notes go to": which of a group's linked Teams chats get its meeting notes.
 *
 * Concepts
 * - A group (workspace) can have several linked Teams chats (Cody's teams use group chats, often one for the core team
 *   and one with the client). The group's **Team Lead** (or an Org Owner/Admin) picks where meeting notes are posted:
 *   one chat, several, or none ("Don't post notes in Teams": notes stay in the portal).
 * - Stored per group: `workspaces.notes_choice` (`'chosen'` | `'none'` | `NULL` = no choice yet), who made it and when,
 *   and the chosen chats in `notes_chats` (workspace, conversation). Replaces the old per-chat "Meeting notes" switch in
 *   teams_chat_settings; lib/db.ts `DATA_MIGRATIONS` (`notesChoice`) carried explicit choices over.
 * - **No choice yet**: notes go to ONE default chat (`pickDefaultNotesChat`): a chat whose name says "notes", else the
 *   first linked chat without client guests, else the first linked chat. With two or more chats the watcher in
 *   lib/watchers.ts (`no_notes_chat`, subject `pick`) asks the Team Lead to pick (`needsChoice`).
 * - **Walls**: notes of an internal-only meeting never go to a chat with client guests, whatever was chosen
 *   (`notesTargetsFor` filters; the picker greys those chats out for internal meetings).
 * - Chosen chats that were since unassigned or removed in Teams simply drop out; if none is left the group is back to
 *   "no choice yet" behaviour (the default chat, and the finding when it has 2+ chats).
 *
 * - **From Teams**: in a linked chat the Team Lead (or an Org Owner/Admin) can say "@Sidekick post meeting notes here"
 *   or "stop posting notes here" (`parseNotesCommand`, `notesHereFromTeams`): the same rules and audit as the picker.
 * - **Telling chats apart**: each chat carries its member count (from the Teams roster, refreshed at most daily by
 *   lib/teams/bot.ts `refreshMemberCount`) and its last activity, which the picker shows once a group has 6+ chats.
 *
 * Who may call: `notesPlan` for anyone who can see the group (the caller checks `requireWorkspace`);
 * `setNotesChats` and `notesHereFromTeams` check `requireManage` themselves.
 */
import "server-only";
import { all, get, now, run, tx } from "./db";
import { audit, HttpError, requireManage, type User } from "./auth";
import { parsePosted, pickDefaultNotesChat, type PostedChat } from "./notes-chat-rules";
import { BRAND } from "./brand";

export { parseNotesCommand, parsePosted, pickDefaultNotesChat, postedToLine, type PostedChat } from "./notes-chat-rules";

/**
 * A linked chat as the picker and the poster see it. `member_count` is the Teams roster size (null until Sidekick
 * checked it); `last_seen_at` is the last time anything happened there that Sidekick saw (its "last activity").
 */
export type NotesChat = {
  id: string; name: string | null; kind: string; guests: number; linked_at: string | null;
  member_count: number | null; last_seen_at: string | null;
};

/** The group's notes choice: `chosen` (chats picked), `none` (no notes in Teams), `unset` (nobody chose yet). */
export type NotesMode = "chosen" | "none" | "unset";

/**
 * Everything the "Meeting notes go to" picker and the poster need about one group.
 * - `chats`: its linked chats (not removed in Teams), oldest first;
 * - `targets`: ids of the chats that get notes now (for a meeting with client guests; internal meetings also skip
 *   `guests` chats);
 * - `defaultId`: the chat notes go to while nobody has chosen;
 * - `needsChoice`: true when nobody chose (or every chosen chat is gone) and the group has 2+ chats;
 * - `last`: the meeting whose notes were posted most recently, and to which chats (names, as posted).
 */
export type NotesPlan = {
  mode: NotesMode;
  chosenBy: string | null;
  chosenAt: string | null;
  chats: NotesChat[];
  targets: string[];
  defaultId: string | null;
  needsChoice: boolean;
  last: { title: string; held_at: string; chats: string[] } | null;
};

/** The group's linked chats (not removed in Teams, Sidekick not leaving), oldest link first. */
async function linkedChats(orgId: string, workspaceId: string): Promise<NotesChat[]> {
  return all<NotesChat>(
    `SELECT id, name, kind, guests, linked_at, member_count, last_seen_at FROM teams_conversations
      WHERE org_id = ? AND workspace_id = ? AND removed_at IS NULL AND leaving IS NULL ORDER BY linked_at, id`,
    orgId, workspaceId,
  );
}

/**
 * Works out where a group's meeting notes go (see `NotesPlan`). Read-only; the caller has checked the person may
 * see the group (`requireWorkspace`), or it's Sidekick itself posting notes / running watchers.
 */
export async function notesPlan(orgId: string, workspaceId: string): Promise<NotesPlan> {
  const ws = await get<{ notes_choice: string | null; notes_choice_by: string | null; notes_choice_at: string | null }>(
    "SELECT notes_choice, notes_choice_by, notes_choice_at FROM workspaces WHERE id = ? AND org_id = ?", workspaceId, orgId,
  );
  const chats = await linkedChats(orgId, workspaceId);
  const chosen = new Set((await all<{ conversation_id: string }>(
    "SELECT conversation_id FROM notes_chats WHERE workspace_id = ? AND org_id = ?", workspaceId, orgId,
  )).map((r) => r.conversation_id));
  const defaultId = pickDefaultNotesChat(chats);
  let mode: NotesMode = ws?.notes_choice === "none" ? "none" : ws?.notes_choice === "chosen" ? "chosen" : "unset";
  let targets = mode === "none" ? [] : chats.filter((c) => chosen.has(c.id)).map((c) => c.id);
  // Every chosen chat was unassigned or removed since: behave as if nobody chose.
  if (mode === "chosen" && !targets.length) mode = "unset";
  if (mode === "unset") targets = defaultId ? [defaultId] : [];
  const lastRow = await get<{ title: string; held_at: string; notes_posted_to: string }>(
    "SELECT title, held_at, notes_posted_to FROM meetings WHERE org_id = ? AND workspace_id = ? AND notes_sent_at IS NOT NULL ORDER BY notes_sent_at DESC, id DESC LIMIT 1",
    orgId, workspaceId,
  );
  const last: NotesPlan["last"] = lastRow ? { title: lastRow.title, held_at: lastRow.held_at, chats: parsePosted(lastRow.notes_posted_to).map((c) => c.name) } : null;
  return {
    mode, chosenBy: mode === "unset" ? null : ws?.notes_choice_by ?? null, chosenAt: mode === "unset" ? null : ws?.notes_choice_at ?? null,
    chats, targets, defaultId, needsChoice: mode === "unset" && chats.length >= 2, last,
  };
}

/**
 * The chats that get this meeting's notes: the group's targets, minus chats with client guests when the meeting was
 * internal-only (`external` false). Used by lib/teams/bot.ts `postMeetingNotes`.
 */
export async function notesTargetsFor(orgId: string, workspaceId: string, external: boolean): Promise<NotesChat[]> {
  const plan = await notesPlan(orgId, workspaceId);
  return plan.chats.filter((c) => plan.targets.includes(c.id) && (external || !c.guests));
}

/**
 * Remembers which chats a meeting's notes were posted to (`notes_posted_to`) and when (`notes_sent_at`, so "the latest"
 * is the latest post, not the latest meeting date), shown on the group's Teams chats tab and the card footer.
 */
export async function recordNotesPosted(orgId: string, meetingId: string, chats: PostedChat[]): Promise<void> {
  await run("UPDATE meetings SET notes_posted_to = ?, notes_sent_at = ? WHERE id = ? AND org_id = ?", JSON.stringify(chats), now(), meetingId, orgId);
}

/**
 * Saves the group's "Meeting notes go to" choice: `{ none: true }` (no notes in Teams) or `{ chatIds }` (one or more
 * of its linked chats). Only the group's Team Lead or an Org Owner/Admin (`requireManage`: 403 for other roles, 404 for
 * a group they can't see). Every id must be a chat linked to this group (400 otherwise). Audited ("Policy change").
 * Returns the new plan.
 */
export async function setNotesChats(user: User, workspaceId: string, body: unknown): Promise<NotesPlan> {
  const ws = await requireManage(user, workspaceId);
  const b = (body ?? {}) as { none?: unknown; chatIds?: unknown };
  const none = b.none === true;
  const ids = Array.isArray(b.chatIds) ? [...new Set(b.chatIds)] : null;
  if (!none && (!ids || !ids.length)) throw new HttpError(400, "Pick at least one chat for meeting notes, or choose “Don't post notes in Teams”.");
  if (ids && !ids.every((x): x is string => typeof x === "string" && x.length > 0 && x.length < 300)) throw new HttpError(400, "Pick chats from this group's list.");
  const chats = await linkedChats(user.org_id, ws);
  const picked = none ? [] : chats.filter((c) => (ids as string[]).includes(c.id));
  if (!none && picked.length !== (ids as string[]).length) throw new HttpError(400, "One of those chats isn't assigned to this group any more. Reload the page and pick again.");
  await saveChoice(user, ws, picked, "");
  return notesPlan(user.org_id, ws);
}

/**
 * Writes a checked choice (no chats = "Don't post notes in Teams") and audits it; `via` is appended to the audit line
 * (" from Teams"). Callers have done `requireManage` and made sure every chat is linked to this group.
 */
async function saveChoice(user: User, ws: string, picked: NotesChat[], via: string): Promise<void> {
  const none = !picked.length;
  await tx(async () => {
    await run("DELETE FROM notes_chats WHERE workspace_id = ? AND org_id = ?", ws, user.org_id);
    for (const c of picked) await run("INSERT INTO notes_chats (workspace_id, conversation_id, org_id) VALUES (?, ?, ?)", ws, c.id, user.org_id);
    await run("UPDATE workspaces SET notes_choice = ?, notes_choice_by = ?, notes_choice_at = ? WHERE id = ? AND org_id = ?", none ? "none" : "chosen", user.name, now(), ws, user.org_id);
  });
  const where = none ? "not posted in Teams (portal only)" : picked.map((c) => `“${c.name ?? "Teams chat"}”`).join(", ");
  await audit(user, `Meeting notes now go to: ${where}${via}`, "Policy change", ws);
}

/** A linked chat of this group by id (not removed, Sidekick not leaving), or a 404 for anything else. */
export async function linkedChat(orgId: string, workspaceId: string, chatId: unknown): Promise<NotesChat> {
  const c = typeof chatId === "string" ? (await linkedChats(orgId, workspaceId)).find((x) => x.id === chatId) : undefined;
  if (!c) throw new HttpError(404, "That chat isn't assigned to this group any more. Reload the page.");
  return c;
}

/* ------------------------------------------------------------------ */
/* "@Sidekick post meeting notes here" in a linked Teams chat          */
/* ------------------------------------------------------------------ */

/**
 * Runs "post meeting notes here" (`here`) or "stop posting notes here" (`stop`) for the Teams chat `chatId`, linked to
 * group `workspaceId`, as `actor` (lib/teams/bot.ts `teamsActor`: a recognised Sidekick person, or a `teams:` guest who
 * acts as a Member). Same rule as the portal: only the group's Team Lead or an Org Owner/Admin (`requireManage`).
 * - `here` adds this chat to the chats that get notes (others chosen before keep them; "no choice yet" or "Don't post
 *   notes in Teams" becomes just this chat). A chat with client guests is accepted, but the reply says internal-only
 *   meetings' notes never come here (the wall in `notesTargetsFor`).
 * - `stop` takes this chat off; if no chat is left, notes stay in the portal ("Don't post notes in Teams").
 * Audited like the picker, with "from Teams". Returns the fixed reply text for the chat (no Claude involved).
 */
export async function notesHereFromTeams(actor: User, workspaceId: string, groupName: string, chatId: string, action: "here" | "stop"): Promise<string> {
  const noRight = "Only the Team Lead or an admin can change where notes go.";
  if (actor.id.startsWith("teams:")) return `${noRight} If that's you, sign in to the ${BRAND.name} portal with Microsoft once so I recognise you here.`;
  try {
    await requireManage(actor, workspaceId);
  } catch (e) {
    if (e instanceof HttpError && (e.status === 403 || e.status === 404)) return noRight;
    throw e;
  }
  const plan = await notesPlan(actor.org_id, workspaceId);
  const chat = plan.chats.find((c) => c.id === chatId);
  if (!chat) return `This chat isn't assigned to ${groupName} any more, so I can't send its notes here.`;
  const chosen = plan.mode === "chosen" ? plan.chats.filter((c) => plan.targets.includes(c.id)) : [];
  const guestNote = chat.guests ? " Client guests are in this chat, so only notes of meetings the client attended come here: internal meetings' notes never do." : "";
  const others = (list: NotesChat[]) => list.filter((c) => c.id !== chatId).map((c) => `“${c.name ?? "Teams chat"}”`).join(", ");
  if (action === "here") {
    if (plan.mode === "chosen" && plan.targets.includes(chatId)) return `Meeting notes for ${groupName} already go here.${guestNote}`;
    const picked = [...chosen, chat];
    await saveChoice(actor, workspaceId, picked, " (from Teams)");
    const also = others(picked);
    return `Done ✓ Meeting notes for ${groupName} will be posted here.${also ? ` They also still go to ${also}.` : ""}${guestNote}`;
  }
  if (!plan.targets.includes(chatId)) return `Meeting notes for ${groupName} don't come here, so there's nothing to stop.`;
  const left = chosen.filter((c) => c.id !== chatId);
  await saveChoice(actor, workspaceId, left, " (from Teams)");
  return left.length
    ? `Done ✓ Meeting notes for ${groupName} won't be posted here any more. They still go to ${others(left)}.`
    : `Done ✓ Meeting notes for ${groupName} won't be posted here any more. No other chat gets them now, so they stay in the ${BRAND.name} portal. Mention me with “post meeting notes here” in another chat, or pick one on the group's Teams chats tab.`;
}
