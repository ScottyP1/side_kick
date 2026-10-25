/**
 * @file The upload guard: keeps documents from landing where the wrong people can use them.
 *
 * Concepts
 * - **Wrong-client check** (`checkWrongClient`, no AI): after a file's text is read, it is matched against the
 *   organization's **other** groups: their client names, group names (and the part before the dash, e.g.
 *   "Litware" in "Litware – Data Platform") and engagement codes ("LIT-DATA-26"). Whole words, any case. The
 *   target group's own names and names made only of common words ("Data Platform") are ignored. A group upload is
 *   flagged when another group's names appear at least `MIN_MENTIONS` times (and more often than the target's own),
 *   or its engagement code appears once. A **firm library** upload is flagged on any one mention, because firm
 *   documents reach every group.
 * - **Held**: a flagged upload is saved with status `Held`: its text is kept (`held_text`) but **not indexed**, so
 *   no search, answer or Teams reply can use it until the uploader decides:
 *   - **Keep** (`keepHeld`): indexed where it was uploaded; `guard_status = 'kept'` raises a "Needs attention"
 *     finding (lib/watchers.ts, kind `misfiled_doc`) for the group's Team Lead and the org's admins (firm library:
 *     Org Owners/Admins) until one of them confirms it (`reviewHeld`) or moves it.
 *   - **Move** (`moveDoc`): to another group (only groups the person belongs to; admins: any group), or from the
 *     firm library into a group. Its passages leave the old scope completely (lib/search.ts `moveIndexed`) and are
 *     indexed in the new one. Audited in both places.
 *   - **Limit** (firm library only, `limitFirmDoc` via lib/firm.ts): keep it in the firm library for chosen groups only.
 * - **Walls**: every function takes the signed-in person and checks their org, role and groups itself
 *   (`requireWorkspace`, `canEdit`, `isAdmin`), so the routes stay thin. Text never goes into traces or findings,
 *   only names and counts.
 *
 * Who calls it: /api/docs (upload), /api/docs/[id] (keep / move / review), /api/firm and /api/firm/[id] (firm
 * library), /api/meetings ("Add a past or outside meeting": checked before anything is saved), lib/watchers.ts.
 */
import "server-only";
import { all, get, now, run } from "./db";
import { audit, canEdit, HttpError, isAdmin, isLead, requireWorkspace, workspaceIdsFor, type User } from "./auth";
import { FIRM_SCOPE, indexText, moveIndexed } from "./search";
import { span, spanAttrs } from "./trace";

/** Mentions of another group's client or group name before a group upload is held. */
export const MIN_MENTIONS = 2;

/** What the check found: the other group the text seems to be about, and what matched (names, never the text). */
export type GuardMatch = {
  workspaceId: string;
  group: string;
  client: string | null;
  /** How many times that group's names and code appear. */
  mentions: number;
  /** The names or codes that matched, as written in the group's settings. */
  terms: string[];
};

/**
 * Where an upload is going: one group, or the firm library (with `groups` when it's limited to chosen groups: those
 * groups' names are expected in it, so they don't count).
 */
export type GuardTarget = { workspaceId: string } | { firm: true; groups?: string[] };

// Words that say nothing about which client a text is about. A group name made only of these ("Data Platform",
// "Mobile App") is never matched on its own.
const COMMON = new Set(
  ("a an and the of for to in on at by with from new old our your their project projects program programme team teams group groups client clients " +
    "data platform cloud migration mobile app apps web portal system systems service services review security analytics " +
    "workspace upgrade rollout modernization modernisation replatform ecommerce booking content hub supply chain payments payment " +
    "crm erp patient health bank retail travel wave phase engagement internal general admin office it tech digital").split(" "),
);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How many times `term` appears in `text` as whole words, any case (letters/digits on either side don't count). */
export function countMentions(text: string, term: string): number {
  const t = term.trim();
  if (t.length < 3) return 0;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
  return (text.match(re) ?? []).length;
}

/** True when a name is made only of common words (or is too short to mean anything). */
const isCommon = (name: string) => {
  const words = name.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  return !words.length || words.every((w) => COMMON.has(w) || w.length < 3);
};

/** A group's distinctive names: client, group name, and the part of the group name before " – " (no common words). */
export function groupTerms(g: { name: string; client: string | null }): string[] {
  const head = g.name.split(/\s+[–—-]\s+/)[0];
  const names = [g.client, g.name, head].map((x) => x?.trim() ?? "").filter((x) => x && !isCommon(x));
  return [...new Set(names.map((x) => x.toLowerCase()))].map((l) => names.find((x) => x.toLowerCase() === l)!);
}

/**
 * The wrong-client check (see the file comment): which other group of the organization this text seems to be
 * about, or null. Pure matching, no AI. For a group target the target's own names are ignored (and the text must
 * mention the other group more than its own); for the firm library any mention of a group counts. The org's own
 * name is never treated as a client.
 */
export async function checkWrongClient(orgId: string, text: string, target: GuardTarget): Promise<GuardMatch | null> {
  return span("guard", "Check the upload's client", async () => {
    const groups = await all<{ id: string; name: string; client: string | null; code: string | null }>(
      "SELECT id, name, client, code FROM workspaces WHERE org_id = ? ORDER BY name", orgId,
    );
    const org = (await get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", orgId))?.name.toLowerCase() ?? "";
    const firm = "firm" in target;
    const own = firm ? null : groups.find((g) => g.id === target.workspaceId) ?? null;
    const ownTerms = new Set(own ? [...groupTerms(own), own.code ?? ""].map((x) => x.toLowerCase()).filter(Boolean) : []);
    const ownMentions = own ? [...ownTerms].reduce((n, t) => n + countMentions(text, t), 0) : 0;
    let best: GuardMatch | null = null;
    const chosen = new Set("firm" in target ? target.groups ?? [] : []);
    for (const g of groups) {
      if ((own && g.id === own.id) || chosen.has(g.id)) continue;
      const names = groupTerms(g).filter((t) => !ownTerms.has(t.toLowerCase()) && t.toLowerCase() !== org);
      const code = g.code && g.code.trim().length >= 3 && !ownTerms.has(g.code.toLowerCase()) ? g.code.trim() : null;
      // A longer name contains its head ("Litware – Data Platform" holds "Litware"): count the most-mentioned name
      // rather than adding them up, so one mention isn't counted twice.
      const nameHits = names.map((t) => [t, countMentions(text, t)] as const).filter(([, n]) => n > 0);
      const nameCount = nameHits.reduce((m, [, n]) => Math.max(m, n), 0);
      const codeCount = code ? countMentions(text, code) : 0;
      const flagged = firm
        ? nameCount + codeCount > 0
        : codeCount > 0 || (nameCount >= MIN_MENTIONS && nameCount > ownMentions);
      if (!flagged) continue;
      const mentions = nameCount + codeCount;
      if (!best || mentions > best.mentions) {
        best = { workspaceId: g.id, group: g.name, client: g.client, mentions, terms: [...nameHits.map(([t]) => t), ...(codeCount ? [code!] : [])] };
      }
    }
    spanAttrs({ groups: groups.length, flagged: Boolean(best), firm });
    return best;
  });
}

/** The question shown with a held upload ("This looks like it's about Litware – Data Platform…"). */
export function heldQuestion(match: GuardMatch, firm: boolean): string {
  return firm
    ? `This looks like it's about ${match.group}. Firm library documents reach every group. Put it in the ${match.group} group instead?`
    : `This looks like it's about ${match.group}. Keep it here, or move it?`;
}

/** A document or firm document as the guard sees it. */
type GuardDoc = {
  id: string; org_id: string; workspace_id: string | null; name: string; title: string; mime: string | null; size: number;
  audience: "internal" | "shareable"; status: string; chunk_count: number; content_hash: string | null; uploaded_by: string | null;
  created_at: string; guard_status: string | null; guard_json: string | null; held_text: string | null;
};

/** Which store a document lives in: a group's documents, or the firm library. */
export type DocScope = "document" | "firm";

/** Loads a document of this org, or 404. */
async function loadDoc(user: User, scope: DocScope, id: string): Promise<GuardDoc> {
  const doc = scope === "firm"
    ? await get<GuardDoc>("SELECT id, org_id, NULL AS workspace_id, name, title, mime, size, audience, status, chunk_count, content_hash, uploaded_by, created_at, guard_status, guard_json, held_text FROM firm_docs WHERE id = ? AND org_id = ?", id, user.org_id)
    : await get<GuardDoc>("SELECT id, org_id, workspace_id, name, name AS title, mime, size, audience, status, chunk_count, content_hash, uploaded_by, created_at, guard_status, guard_json, held_text FROM documents WHERE id = ? AND org_id = ?", id, user.org_id);
  if (!doc) throw new HttpError(404, scope === "firm" ? "Firm document not found." : "Document not found.");
  return doc;
}

/**
 * The role check, before anything is looked up (so other roles always get 403): a group document needs edit
 * rights; a firm document needs Org Owner/Admin.
 */
function assertRole(user: User, scope: DocScope) {
  if (scope === "firm" && !isAdmin(user)) throw new HttpError(403, "Only Org Owners and Org Admins can change the firm library.");
  if (scope === "document" && !canEdit(user)) throw new HttpError(403, "Your role can't change documents.");
}

/**
 * Checks this person may change the document where it is now: the role (`assertRole`), and for a group document
 * access to its group (404 otherwise, so other groups' documents stay invisible).
 */
async function assertMayChange(user: User, scope: DocScope, doc: GuardDoc) {
  assertRole(user, scope);
  if (scope === "document") await requireWorkspace(user, doc.workspace_id);
}

/** A group's display name ("Litware – Data Platform"), for audit lines. */
const groupName = async (orgId: string, id: string) => (await get<{ name: string }>("SELECT name FROM workspaces WHERE id = ? AND org_id = ?", id, orgId))?.name ?? "another group";

/**
 * Keeps a held document where it was uploaded: indexes its text there (group, or the firm library for every group
 * or its chosen groups), marks it Ready and `kept`, so the "Needs attention" finding appears for the managers.
 * Who: anyone who may change it (`assertMayChange`). Audited. A document that isn't held is refused (409).
 */
export async function keepHeld(user: User, scope: DocScope, id: string): Promise<void> {
  assertRole(user, scope);
  const doc = await loadDoc(user, scope, id);
  await assertMayChange(user, scope, doc);
  if (doc.status !== "Held" || doc.held_text == null) throw new HttpError(409, "This document isn't waiting for a decision.");
  await span("guard", "Keep a held upload", async () => {
    const n = await indexText({
      orgId: user.org_id, workspaceId: scope === "firm" ? FIRM_SCOPE : doc.workspace_id!, sourceType: scope === "firm" ? "firm" : "document",
      sourceId: doc.id, title: doc.title, audience: doc.audience, text: doc.held_text!,
    });
    const table = scope === "firm" ? "firm_docs" : "documents";
    await run(`UPDATE ${table} SET status = 'Ready', chunk_count = ?, held_text = NULL, guard_status = 'kept' WHERE id = ? AND org_id = ?`, n, doc.id, user.org_id);
    spanAttrs({ passages: n, firm: scope === "firm" });
  });
  const match = parseMatch(doc.guard_json);
  await audit(user, `Kept “${doc.title}” in ${scope === "firm" ? "the firm library" : "this group"} although it looks like it's about ${match?.group ?? "another client"}`, "Data", doc.workspace_id);
}

/**
 * Confirms a flagged-and-kept document belongs where it is (the finding's **Keep** button): clears the flag, so the
 * "Needs attention" finding resolves. Who: Org Owners/Admins, or a Team Lead of the document's group (firm library:
 * Org Owners/Admins only). Audited.
 */
export async function reviewHeld(user: User, scope: DocScope, id: string): Promise<void> {
  if (scope === "firm" ? !isAdmin(user) : !isAdmin(user) && !isLead(user)) {
    throw new HttpError(403, scope === "firm" ? "Only Org Owners and Org Admins can confirm firm library documents." : "Only the group's Team Lead or an Org Owner/Admin can confirm this.");
  }
  const doc = await loadDoc(user, scope, id);
  if (scope === "document") await requireWorkspace(user, doc.workspace_id);
  if (doc.guard_status !== "kept") throw new HttpError(409, "This document isn't flagged.");
  await run(`UPDATE ${scope === "firm" ? "firm_docs" : "documents"} SET guard_status = 'reviewed' WHERE id = ? AND org_id = ?`, doc.id, user.org_id);
  await resolveGuardFinding(user.org_id, doc.id);
  await audit(user, `Confirmed “${doc.title}” belongs in ${scope === "firm" ? "the firm library" : "this group"}`, "Data", doc.workspace_id);
}

/**
 * Moves a document to another group: between groups, or out of the firm library into a group (a held one too).
 * The person must be able to change it where it is and open the target group (`requireWorkspace`: members of it;
 * admins any group). Refused when the same text is already in the target group. Its passages leave the old scope
 * completely (local and Azure) and are indexed in the new group; a held document's text is indexed there for the
 * first time. The guard flag is cleared and both groups' audit logs say what happened.
 */
export async function moveDoc(user: User, scope: DocScope, id: string, to: unknown): Promise<{ workspaceId: string; group: string }> {
  assertRole(user, scope);
  const doc = await loadDoc(user, scope, id);
  await assertMayChange(user, scope, doc);
  if (typeof to !== "string" || !to) throw new HttpError(400, "Choose the group to move it to.");
  if (scope === "document" && to === doc.workspace_id) throw new HttpError(400, "It's already in that group.");
  const target = await requireWorkspace(user, to);
  if (doc.content_hash) {
    const same = await get<{ name: string }>("SELECT name FROM documents WHERE org_id = ? AND workspace_id = ? AND content_hash = ? AND id != ?", user.org_id, target, doc.content_hash, doc.id);
    if (same) throw new HttpError(409, `The same text is already in that group as “${same.name}”.`);
  }
  const targetName = await groupName(user.org_id, target);
  await span("guard", "Move a document", async () => {
    const held = doc.status === "Held" && doc.held_text != null;
    if (scope === "firm") {
      // Out of the firm library: becomes an ordinary document of the group (same id, so its passages follow).
      await run(
        "INSERT INTO documents (id, org_id, workspace_id, name, mime, size, audience, status, chunk_count, content_hash, uploaded_by, created_at, held_text, guard_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        doc.id, user.org_id, target, doc.name, doc.mime, doc.size, doc.audience, held ? "Held" : doc.status, doc.chunk_count, doc.content_hash, doc.uploaded_by, doc.created_at, doc.held_text, doc.guard_json,
      );
      await run("DELETE FROM firm_doc_groups WHERE firm_doc_id = ? AND org_id = ?", doc.id, user.org_id);
      await run("UPDATE firm_docs SET superseded_by = NULL WHERE superseded_by = ? AND org_id = ?", doc.id, user.org_id);
      await run("DELETE FROM firm_docs WHERE id = ? AND org_id = ?", doc.id, user.org_id);
    } else {
      await run("UPDATE documents SET workspace_id = ? WHERE id = ? AND org_id = ?", target, doc.id, user.org_id);
    }
    let passages: number;
    if (held) {
      passages = await indexText({ orgId: user.org_id, workspaceId: target, sourceType: "document", sourceId: doc.id, title: doc.name, audience: doc.audience, text: doc.held_text! });
      await run("UPDATE documents SET status = 'Ready', chunk_count = ? WHERE id = ? AND org_id = ?", passages, doc.id, user.org_id);
    } else {
      passages = await moveIndexed(user.org_id, doc.id, { workspaceId: target, sourceType: "document", title: doc.name });
    }
    await run("UPDATE documents SET held_text = NULL, guard_status = NULL, guard_json = NULL WHERE id = ? AND org_id = ?", doc.id, user.org_id);
    // Watch results about it in the old group (stale-document checks) no longer apply.
    await run("DELETE FROM watch_checks WHERE org_id = ? AND pair_key LIKE ?", user.org_id, `%${doc.id}%`);
    spanAttrs({ passages, held, firm: scope === "firm" });
  });
  await resolveGuardFinding(user.org_id, doc.id);
  const from = scope === "firm" ? "the firm library" : await groupName(user.org_id, doc.workspace_id!);
  await audit(user, `Moved “${doc.title}” from ${from} to ${targetName}`, "Data", doc.workspace_id);
  await audit(user, `Moved “${doc.title}” here from ${from}`, "Data", target);
  return { workspaceId: target, group: targetName };
}

/** Resolves the "Needs attention" finding about one document straight away (the watchers would on their next run). */
export async function resolveGuardFinding(orgId: string, docId: string) {
  const t = now();
  await run("UPDATE findings SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE org_id = ? AND kind = 'misfiled_doc' AND dedupe_key LIKE ? AND status <> 'resolved'", t, t, orgId, `%:${docId}`);
}

/** The stored match of a held or flagged document (null when none or unreadable). */
export function parseMatch(json: string | null): GuardMatch | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as GuardMatch;
  } catch {
    return null;
  }
}

/** The groups this person may move a document to (their groups; admins: every group), with names, for the picker. */
export async function moveTargets(user: User): Promise<{ id: string; name: string; client: string | null }[]> {
  const ids = await workspaceIdsFor(user);
  if (!ids.length) return [];
  return all<{ id: string; name: string; client: string | null }>(
    `SELECT id, name, client FROM workspaces WHERE org_id = ? AND id IN (${ids.map(() => "?").join(", ")}) ORDER BY name`, user.org_id, ...ids,
  );
}
