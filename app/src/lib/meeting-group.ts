/**
 * @file Which client group a Teams meeting belongs to. One rule, shared by automatic notes after a meeting
 * (lib/meetings-graph.ts) and automatic recording before one (lib/auto-record.ts), so both always agree.
 *
 * Concepts
 * - **Never guess wrong**: a meeting goes to a group only when that is clear. Anything unclear waits for a person
 *   (an Org Owner/Admin, or a Team Lead of one of its groups) to pick; it never lands in a client's group by default.
 * - **Who was in the meeting** (`knownPeople`): the organizer and invitees are Microsoft account ids. Each is matched
 *   to a Sidekick person of the organization by `users.entra_oid`. People added by email who never signed in with
 *   Microsoft have no account id yet, so an id with no match is looked up in the organization's own tenant
 *   (`/users/{id}`) and its sign-in name or mail matched to a Sidekick person (lib/directory.ts `linkByDirectory`:
 *   same organization, same tenant, never a guest). A match saves the account id on them, audited once. Lookups
 *   are cached for one run (`DirectoryCache`) and capped per meeting. Invitees from another tenant, guests and phone
 *   callers are never matched. A caller that already recognised people another way passes their Sidekick user ids
 *   (`knownUserIds`): lib/auto-record.ts does, for calendar invitees matched by email, because a meeting made in
 *   Outlook may list no attendees and people who never signed in with Microsoft have no account id to look up.
 * - **The rule** (`matchGroup`), in order:
 *   1. the group whose linked Teams chat is the meeting's own chat;
 *   2. the group with the most of its people in the meeting, at least two (the organizer breaks a tie);
 *   3. a **tie**, or nobody's count reaching two: the **title hint**. When exactly one of the possible groups (the
 *      tied ones; otherwise the groups with at least one person in the meeting) is named in the meeting title by
 *      its client name, group name or engagement code (lib/upload-guard.ts `groupsNamedIn`: whole words, any case,
 *      common-word names ignored, the organization's own name never counts), that group, with a note saying so;
 *   4. otherwise it **waits**: `tie` (several groups equally) or `unclear` (fewer than two of one group's people
 *      recognised, e.g. someone new to the group), for a person to pick;
 *   5. `none`: nobody from any group was there, or the person was alone. Nothing about it is kept but its ids.
 *   Groups that are ending (lib/rolloff.ts) are never picked or offered.
 * - **Walls**: everything is per organization: people, groups and chats of `orgId` only, and directory lookups only
 *   in the tenant the organization is connected to.
 */
import "server-only";
import { all, get, run } from "./db";
import { ConsentNeededError, linkByDirectory } from "./directory";
import { entraConfigured } from "./entra";
import { tenantOfOrg } from "./tenants";
import { NOT_ENDING } from "./billing";
import { groupsNamedIn } from "./upload-guard";
import { span, spanAttrs } from "./trace";
import { BRAND } from "./brand";

/** One person in a meeting as Graph lists them: their Microsoft account id, their tenant if known, and whether a guest. */
export type Participant = { oid: string; tenantId?: string | null; guest?: boolean };

/** Directory lookups already made in this run: Microsoft account id → the Sidekick person it matched, or null. */
export type DirectoryCache = Map<string, string | null>;

/** Where a meeting goes, and why (see the file comment for the rule). */
export type GroupMatch =
  | { kind: "group"; workspaceId: string; by: "chat" | "people" | "title"; note: string | null }
  | { kind: "tie"; candidates: string[] }
  | { kind: "unclear"; candidates: string[] }
  | { kind: "none" };

/** Microsoft account ids are GUIDs. */
export const isOid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** At most this many unknown accounts of one meeting are looked up in the directory. */
const MAX_LOOKUPS = 25;

/**
 * True for a participant who belongs to the organization's own tenant as far as Graph says: not a guest, and no
 * other tenant named. (An id from another tenant isn't in this tenant's directory either, so a lookup finds nothing.)
 */
export const sameTenant = (p: Participant, tenant: string | null) => isOid(p.oid) && !p.guest && (!p.tenantId || !tenant || p.tenantId.toLowerCase() === tenant.toLowerCase());

/**
 * The Sidekick people of `orgId` among a meeting's participants: Microsoft account id (lower case) → Sidekick user
 * id. Matched by saved account id, else by email through the organization's own directory (see the file comment),
 * which also saves the account id for next time. A directory that can't be read yet (no admin approval) just means
 * fewer matches; throttling and outages are thrown (the job retries).
 */
export async function knownPeople(orgId: string, participants: Participant[], cache: DirectoryCache = new Map()): Promise<Map<string, string>> {
  const tenant = await tenantOfOrg(orgId);
  const oids = [...new Set(participants.filter((p) => sameTenant(p, tenant)).map((p) => p.oid.toLowerCase()))].slice(0, 300);
  const out = new Map<string, string>();
  if (!oids.length) return out;
  const rows = await all<{ id: string; oid: string }>(
    `SELECT id, LOWER(entra_oid) AS oid FROM users WHERE org_id = ? AND LOWER(entra_oid) IN (${oids.map(() => "?").join(", ")})`,
    orgId, ...oids,
  );
  for (const r of rows) out.set(r.oid, r.id);
  const unknown = oids.filter((o) => !out.has(o));
  if (!unknown.length || !tenant || !entraConfigured()) return out;
  await span("microsoft", "Recognise meeting people added by email", async () => {
    let looked = 0;
    let linked = 0;
    for (const oid of unknown) {
      if (cache.has(oid)) {
        const id = cache.get(oid);
        if (id) out.set(oid, id);
        continue;
      }
      if (looked >= MAX_LOOKUPS) break;
      looked++;
      let found: { id: string } | null;
      try {
        found = await linkByDirectory(orgId, tenant, oid, `Microsoft account linked when ${BRAND.name} recognised them in a Teams meeting by their email`);
      } catch (e) {
        // The directory permission isn't approved yet: stop looking, match by saved account ids only, and say so.
        if (e instanceof ConsentNeededError) {
          await noteDirectory(orgId, false);
          break;
        }
        throw e;
      }
      if (looked === 1) await noteDirectory(orgId, true);
      cache.set(oid, found?.id ?? null);
      if (found) {
        out.set(oid, found.id);
        linked++;
      }
    }
    spanAttrs({ looked, linked });
  });
  return out;
}

/** What the Meetings panel says while the directory permission is missing (see `noteDirectory`). */
export const DIRECTORY_NEEDED = `${BRAND.name} can't recognise people who were added by email and haven't signed in with Microsoft yet, so meetings with them may wait under Pick a group. A Microsoft admin needs to approve reading your directory: Settings → Microsoft permissions → Approve ${BRAND.name} for your organization.`;

/**
 * Records whether the organization's directory could be read for meeting matching (`auto_meetings.directory_error`):
 * `false` when Microsoft refused (the "Read all users' full profiles" permission isn't approved), `true` after a
 * lookup went through, which clears it. Shown to Org Owners/Admins and Team Leads on the Meetings panel, so missing
 * email matching never fails silently. Writes only when the state changes. Never throws.
 */
export async function noteDirectory(orgId: string, ok: boolean): Promise<void> {
  await run(
    ok
      ? "UPDATE auto_meetings SET directory_error = NULL, directory_error_at = NULL WHERE org_id = ? AND directory_error IS NOT NULL"
      : "UPDATE auto_meetings SET directory_error = ?, directory_error_at = ? WHERE org_id = ? AND directory_error IS NULL",
    ...(ok ? [orgId] : [DIRECTORY_NEEDED, new Date().toISOString(), orgId]),
  ).catch((e) => console.error("Couldn't record the directory check", e));
}

/** The group whose linked Teams chat is `chatId` (and isn't ending), if any. */
async function groupOfChat(orgId: string, chatId: string): Promise<string | null> {
  const chat = await get<{ workspace_id: string }>(
    `SELECT c.workspace_id FROM teams_conversations c JOIN workspaces w ON w.id = c.workspace_id AND w.org_id = c.org_id
      WHERE c.id = ? AND c.org_id = ? AND ${NOT_ENDING}`,
    chatId, orgId,
  );
  return chat?.workspace_id ?? null;
}

/**
 * Exactly one of `among` named in the meeting title → that group and the note for the notes ("Picked Litware from
 * the meeting title."); several or none → null.
 */
async function titleHint(orgId: string, title: string | null | undefined, among: string[]): Promise<{ workspaceId: string; note: string } | null> {
  if (!title || !among.length) return null;
  const named = await groupsNamedIn(orgId, title, among);
  if (named.length !== 1) return null;
  return { workspaceId: named[0].id, note: `Picked ${named[0].client || named[0].name} from the meeting title.` };
}

/**
 * Works out which group a meeting belongs to (the rule in the file comment). `organizer` and `attendees` are the
 * meeting's people as Graph lists them; `title` is the meeting subject for the title hint (leave it out to skip the
 * hint). `cache` keeps directory lookups for one run. `knownUserIds` adds Sidekick people of `orgId` the caller already
 * recognised (each counts once, also toward the headcount; ids of other organizations match no group). Called by
 * lib/meetings-graph.ts (`fetchTranscript`) and, through `pickGroup`, by lib/auto-record.ts.
 */
export async function matchGroup(
  orgId: string,
  m: { chatId: string | null; organizer: Participant; attendees: Participant[]; title?: string | null; cache?: DirectoryCache; knownUserIds?: string[] },
): Promise<GroupMatch> {
  if (m.chatId) {
    const ws = await groupOfChat(orgId, m.chatId);
    if (ws) return { kind: "group", workspaceId: ws, by: "chat", note: null };
  }
  const everyone = [m.organizer, ...m.attendees];
  // Everyone in the meeting, from any tenant (phone callers and guests without an id count once each).
  const people = await knownPeople(orgId, everyone, m.cache);
  const extra = (m.knownUserIds ?? []).filter((id) => ![...people.values()].includes(id));
  const headcount = new Set([...everyone.map((p, i) => (isOid(p.oid) ? p.oid.toLowerCase() : `#${i}`)), ...extra.map((id) => `u:${id}`)]).size;
  const userIds = [...new Set([...people.values(), ...extra])].slice(0, 300);
  if (!userIds.length) return { kind: "none" };
  const rows = await all<{ workspace_id: string; user_id: string }>(
    `SELECT wm.workspace_id, wm.user_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE w.org_id = ? AND wm.user_id IN (${userIds.map(() => "?").join(", ")}) AND ${NOT_ENDING}`,
    orgId, ...userIds,
  );
  const organizer = isOid(m.organizer.oid) ? people.get(m.organizer.oid.toLowerCase()) : undefined;
  const byGroup = new Map<string, Set<string>>();
  for (const r of rows) byGroup.set(r.workspace_id, (byGroup.get(r.workspace_id) ?? new Set()).add(r.user_id));
  const score = (ws: string) => byGroup.get(ws)!.size * 2 + (organizer && byGroup.get(ws)!.has(organizer) ? 1 : 0);
  const strong = [...byGroup.keys()].filter((ws) => byGroup.get(ws)!.size >= 2);
  if (strong.length) {
    const best = Math.max(...strong.map(score));
    const top = strong.filter((ws) => score(ws) === best).sort();
    if (top.length === 1) return { kind: "group", workspaceId: top[0], by: "people", note: null };
    const hint = await titleHint(orgId, m.title, top);
    return hint ? { kind: "group", workspaceId: hint.workspaceId, by: "title", note: hint.note } : { kind: "tie", candidates: top };
  }
  // Nobody's count reaches two. Alone, or no group's people at all: not a group meeting.
  const some = [...byGroup.keys()].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  if (!some.length || headcount < 2) return { kind: "none" };
  const hint = await titleHint(orgId, m.title, some);
  return hint ? { kind: "group", workspaceId: hint.workspaceId, by: "title", note: hint.note } : { kind: "unclear", candidates: some };
}

/**
 * The short form of `matchGroup` for callers that only act on a clear answer: `{ workspaceId }` for a group,
 * `{ candidates }` for a tie, null for anything else (unclear or nobody's meeting). Matching by email and the title
 * hint (when `title` is given) apply as in `matchGroup`. Used by lib/auto-record.ts, which only turns on recording
 * for clearly one group's meetings.
 */
export async function pickGroup(
  orgId: string,
  m: { chatId: string | null; organizerOid: string; attendeeOids: string[]; title?: string | null; knownUserIds?: string[] },
): Promise<{ workspaceId: string } | { candidates: string[] } | null> {
  const r = await matchGroup(orgId, { chatId: m.chatId, organizer: { oid: m.organizerOid }, attendees: m.attendeeOids.map((oid) => ({ oid })), title: m.title, knownUserIds: m.knownUserIds });
  return r.kind === "group" ? { workspaceId: r.workspaceId } : r.kind === "tie" ? { candidates: r.candidates } : null;
}
