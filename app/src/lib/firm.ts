/**
 * @file The firm library: org-wide knowledge (policies, standards, templates, methods, rate-card rules) that every
 * group's answers can use, managed by Org Owners and Org Admins on the Firm library page.
 *
 * Concepts
 * - **One copy per organization**: a firm document is stored once (`firm_docs`) and its passages are indexed once,
 *   under the workspace id `FIRM_SCOPE` (lib/search.ts), not copied into each group. Every group's Ask and Teams
 *   answers search that group **plus** its own org's firm library, never another group or org.
 * - **Audience**: Internal (team only) or Shareable. In a chat or meeting with client guests only Shareable firm
 *   documents are used, exactly like a group's own documents.
 * - **Title, effective date, superseded by**: the title is what citations show ("Firm policy · Expense policy v3");
 *   the effective date is the day it applies from; "superseded by" points to the firm document that replaces it.
 *   A superseded document stays searchable but is down-ranked and flagged in answers (lib/rank.ts), so history
 *   questions still work and current ones get the current policy.
 * - **Duplicates**: a file whose text is already in the firm library is refused (same SHA-256 of its text).
 * - **Plan limit**: firm documents count toward the plan's document limit together with groups' documents
 *   (lib/limits.ts).
 * - **Applies to**: every group (`applies_to = 'all'`, the default) or only chosen groups (`'some'` + the
 *   `firm_doc_groups` rows). Search (lib/search.ts) only uses a limited document in its chosen groups' answers; the
 *   Firm library page and citations say which groups. The guests rule (Shareable only) is the same either way.
 * - **Upload guard** (lib/upload-guard.ts): firm documents reach every group, so an upload that mentions any of the
 *   org's clients (client name, group name or engagement code; chosen groups excepted) is saved **Held** (not
 *   indexed) until an admin keeps it, limits it to that group, or moves it into the group.
 * - **Deleting the organization** (lib/rolloff.ts) removes `firm_docs` and the firm passages, local and Azure.
 *
 * Who calls it: /api/firm (list, upload) and /api/firm/[id] (edit, delete). Reading is open to everyone in the
 * org; changes need Org Owner or Org Admin (the routes check) and are audited.
 */
import "server-only";
import { all, get, newId, now, run } from "./db";
import { audit, HttpError, type User } from "./auth";
import { assertCanAdd } from "./limits";
import { assertEnabled } from "./owner";
import { fileToText, MAX_DOCUMENT_CHARS, MAX_FILES_PER_UPLOAD, uploadProblem } from "./extract";
import { FIRM_SCOPE, indexText, removeIndexed, setAudience } from "./search";
import { contentHash } from "./rank";
import { span, spanAttrs } from "./trace";
import { checkWrongClient, heldQuestion, keepHeld, parseMatch, resolveGuardFinding, type GuardMatch } from "./upload-guard";

/** Longest firm document title, in characters. */
export const MAX_TITLE = 160;

/** A firm document as the Firm library page lists it. */
export type FirmDoc = {
  id: string;
  title: string;
  name: string;
  size: number;
  audience: "internal" | "shareable";
  status: string;
  error: string | null;
  chunk_count: number;
  effective_on: string | null;
  superseded_by: string | null;
  superseded_title: string | null;
  uploaded_by: string | null;
  created_at: string;
  /** "all" groups, or "some": only `groups` use it in their answers. */
  applies_to: "all" | "some";
  groups: { id: string; name: string }[];
  /** Flagged by the upload guard ("held" waiting for a decision, or "kept"): what matched, and the question to ask. */
  match: GuardMatch | null;
  question: string | null;
  guard_status: string | null;
};

/** The organization's firm documents, newest first, with who uploaded them and what supersedes them. */
export async function listFirmDocs(orgId: string): Promise<FirmDoc[]> {
  const rows = await all<Omit<FirmDoc, "groups" | "match" | "question"> & { guard_json: string | null }>(
    `SELECT f.id, f.title, f.name, f.size, f.audience, f.status, f.error, f.chunk_count, f.effective_on, f.superseded_by,
            n.title AS superseded_title, u.name AS uploaded_by, f.created_at, f.applies_to, f.guard_status, f.guard_json
       FROM firm_docs f
       LEFT JOIN firm_docs n ON n.id = f.superseded_by AND n.org_id = f.org_id
       LEFT JOIN users u ON u.id = f.uploaded_by
      WHERE f.org_id = ? ORDER BY f.created_at DESC`,
    orgId,
  );
  const groups = await firmDocGroups(orgId);
  return rows.map(({ guard_json, ...f }) => {
    const match = f.status === "Held" || f.guard_status === "kept" ? parseMatch(guard_json) : null;
    return { ...f, groups: groups.get(f.id) ?? [], match, question: match && f.status === "Held" ? heldQuestion(match, true) : null };
  });
}

/** The chosen groups of every limited firm document of an org (firm document id → groups, by name). */
export async function firmDocGroups(orgId: string, ids?: string[]): Promise<Map<string, { id: string; name: string }[]>> {
  if (ids && !ids.length) return new Map();
  const rows = await all<{ firm_doc_id: string; id: string; name: string }>(
    `SELECT g.firm_doc_id, w.id, w.name FROM firm_doc_groups g JOIN workspaces w ON w.id = g.workspace_id AND w.org_id = g.org_id
      WHERE g.org_id = ? ${ids ? `AND g.firm_doc_id IN (${ids.map(() => "?").join(", ")})` : ""} ORDER BY w.name`,
    orgId, ...(ids ?? []),
  );
  const out = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) out.set(r.firm_doc_id, [...(out.get(r.firm_doc_id) ?? []), { id: r.id, name: r.name }]);
  return out;
}

/**
 * Reads an "Applies to" value: "all" (or nothing) = every group → null; otherwise a list of group ids (or a
 * comma-separated string), each checked to be a group of this org (400 otherwise; at least one).
 */
export async function parseAppliesTo(orgId: string, value: unknown): Promise<string[] | null> {
  if (value === undefined || value === null || value === "" || value === "all") return null;
  const ids = [...new Set((Array.isArray(value) ? value : String(value).split(",")).map((x) => String(x).trim()).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, "Choose at least one group, or All groups.");
  const found = await all<{ id: string }>(`SELECT id FROM workspaces WHERE org_id = ? AND id IN (${ids.map(() => "?").join(", ")})`, orgId, ...ids);
  if (found.length !== ids.length) throw new HttpError(400, "One of those groups doesn't exist.");
  return ids;
}

/** Sets which groups a firm document applies to (null = all groups). */
async function setAppliesTo(orgId: string, id: string, groups: string[] | null) {
  await run("DELETE FROM firm_doc_groups WHERE firm_doc_id = ? AND org_id = ?", id, orgId);
  await run("UPDATE firm_docs SET applies_to = ? WHERE id = ? AND org_id = ?", groups ? "some" : "all", id, orgId);
  for (const g of groups ?? []) await run("INSERT INTO firm_doc_groups (firm_doc_id, org_id, workspace_id) VALUES (?, ?, ?)", id, orgId, g);
}

/** A YYYY-MM-DD calendar day, or null for empty; anything else is refused with 400. */
export function parseDay(value: unknown, label = "Effective date"): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, `${label} must be a date like 2026-10-01.`);
  }
  return v;
}

/** The firm document `id` of this org, or 404. */
async function loadFirmDoc(orgId: string, id: string) {
  const doc = await get<{ id: string; title: string; audience: string }>("SELECT id, title, audience FROM firm_docs WHERE id = ? AND org_id = ?", id, orgId);
  if (!doc) throw new HttpError(404, "Firm document not found.");
  return doc;
}

/**
 * Uploads files to the firm library: checks each file (type, size), the plan's document limit and the uploads
 * switch, extracts the text, refuses text that's already in the library, and indexes it once for the whole org.
 * With one file, `title` names it (otherwise the file name without its extension). `replaces` (a firm document
 * id) marks that older document as superseded by the new one. Returns one result per file, like group uploads.
 */
export async function uploadFirmDocs(
  user: User,
  files: File[],
  opts: { title?: string | null; audience: "internal" | "shareable"; effectiveOn: string | null; replaces?: string | null; appliesTo?: string[] | null },
): Promise<{ name: string; ok: boolean; error?: string; id?: string; held?: boolean; question?: string; match?: GuardMatch }[]> {
  await assertEnabled("uploads", user.org_id);
  if (!files.length) throw new HttpError(400, "Choose at least one file to upload.");
  if (files.length > MAX_FILES_PER_UPLOAD) throw new HttpError(413, `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.`);
  const replaced = opts.replaces ? await loadFirmDoc(user.org_id, opts.replaces) : null;
  const results: { name: string; ok: boolean; error?: string; id?: string; held?: boolean; question?: string; match?: GuardMatch }[] = [];
  const readable: File[] = [];
  for (const file of files) {
    const problem = uploadProblem(file.name, file.size);
    if (problem) results.push({ name: file.name, ok: false, error: problem });
    else readable.push(file);
  }
  if (!readable.length) throw new HttpError(415, results.length === 1 ? results[0].error! : `None of these files can be uploaded: ${results[0].error}`);
  await assertCanAdd(user.org_id, "documents", readable.length);
  return span("firm", "Add to the firm library", async () => {
    for (const file of readable) {
      const id = newId();
      const title = ((readable.length === 1 && opts.title?.trim()) || file.name.replace(/\.[a-z0-9]{1,5}$/i, "")).slice(0, MAX_TITLE);
      await run(
        "INSERT INTO firm_docs (id, org_id, title, name, mime, size, audience, status, effective_on, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Indexing', ?, ?, ?)",
        id, user.org_id, title, file.name, file.type, file.size, opts.audience, opts.effectiveOn, user.id, now(),
      );
      if (opts.appliesTo) await setAppliesTo(user.org_id, id, opts.appliesTo);
      try {
        const text = await fileToText(file.name, Buffer.from(await file.arrayBuffer()));
        if (!text.trim()) throw new HttpError(422, "No readable text found. If it's a scan, export it with text (OCR) first.");
        if (text.length > MAX_DOCUMENT_CHARS) throw new HttpError(413, `This file holds ${text.length.toLocaleString("en-US")} characters of text; the limit is ${MAX_DOCUMENT_CHARS.toLocaleString("en-US")} per document. Split it into smaller files.`);
        const hash = contentHash(text);
        const same = await get<{ title: string }>("SELECT title FROM firm_docs WHERE org_id = ? AND content_hash = ? AND id != ?", user.org_id, hash, id);
        if (same) {
          await run("DELETE FROM firm_docs WHERE id = ? AND org_id = ?", id, user.org_id);
          results.push({ name: file.name, ok: false, error: `The same text is already in the firm library as “${same.title}”.` });
          continue;
        }
        // Mentions one of the org's clients? Hold it (not indexed) until an admin keeps, limits or moves it.
        const match = await checkWrongClient(user.org_id, text, { firm: true, groups: opts.appliesTo ?? [] });
        if (match) {
          await run("UPDATE firm_docs SET status = 'Held', content_hash = ?, held_text = ?, guard_json = ? WHERE id = ?", hash, text, JSON.stringify(match), id);
          if (replaced) await run("UPDATE firm_docs SET superseded_by = ? WHERE id = ? AND org_id = ?", id, replaced.id, user.org_id);
          results.push({ name: file.name, ok: true, id, held: true, question: heldQuestion(match, true), match });
          continue;
        }
        const n = await indexText({ orgId: user.org_id, workspaceId: FIRM_SCOPE, sourceType: "firm", sourceId: id, title, audience: opts.audience, text });
        await run("UPDATE firm_docs SET status = 'Ready', chunk_count = ?, content_hash = ? WHERE id = ?", n, hash, id);
        if (replaced) await run("UPDATE firm_docs SET superseded_by = ? WHERE id = ? AND org_id = ?", id, replaced.id, user.org_id);
        results.push({ name: file.name, ok: true, id });
      } catch (e) {
        if (!(e instanceof HttpError)) console.error(`Couldn't read firm library file "${file.name}"`, e);
        const message = e instanceof HttpError ? e.message : "Couldn't read this file. It may be damaged or password-protected; open it, save it again and re-upload.";
        await run("UPDATE firm_docs SET status = 'Failed', error = ? WHERE id = ?", message, id);
        results.push({ name: file.name, ok: false, error: message });
      }
    }
    const added = results.filter((r) => r.ok).length;
    const held = results.filter((r) => r.held).length;
    spanAttrs({ files: readable.length, added, held, limited: Boolean(opts.appliesTo) });
    if (added) {
      await audit(user, `Added ${added} document${added > 1 ? "s" : ""} to the firm library${opts.appliesTo ? ` for ${opts.appliesTo.length} group${opts.appliesTo.length > 1 ? "s" : ""}` : ""}${replaced ? `, replacing “${replaced.title}”` : ""}${held ? ` (${held} held: may be about one client)` : ""}`, "Data", null);
    }
    return results;
  });
}

/**
 * Changes a firm document's title, audience (re-tags its passages too), effective date, "superseded by" (another
 * firm document of the same org, not itself; null clears it) or "Applies to" (`applies_to`: "all" or a list of the
 * org's group ids; search picks it up straight away). Only the fields given change. Audited.
 */
export async function updateFirmDoc(user: User, id: string, body: { title?: unknown; audience?: unknown; effective_on?: unknown; superseded_by?: unknown; applies_to?: unknown }) {
  const doc = await loadFirmDoc(user.org_id, id);
  const changes: string[] = [];
  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE) : "";
    if (!title) throw new HttpError(400, "Give the document a title.");
    await run("UPDATE firm_docs SET title = ? WHERE id = ? AND org_id = ?", title, id, user.org_id);
    // Citations show the title stored with the passages, so re-label them.
    await run("UPDATE passages SET title = ? WHERE source_id = ? AND org_id = ?", title, id, user.org_id);
    changes.push(`renamed to “${title}”`);
  }
  if (body.audience !== undefined) {
    if (body.audience !== "internal" && body.audience !== "shareable") throw new HttpError(400, "Audience must be internal or shareable.");
    await run("UPDATE firm_docs SET audience = ? WHERE id = ? AND org_id = ?", body.audience, id, user.org_id);
    await setAudience(id, body.audience);
    changes.push(`marked ${body.audience}`);
  }
  if (body.effective_on !== undefined) {
    const day = parseDay(body.effective_on);
    await run("UPDATE firm_docs SET effective_on = ? WHERE id = ? AND org_id = ?", day, id, user.org_id);
    changes.push(day ? `effective from ${day}` : "effective date cleared");
  }
  if (body.superseded_by !== undefined) {
    const by = typeof body.superseded_by === "string" && body.superseded_by ? body.superseded_by : null;
    if (by === id) throw new HttpError(400, "A document can't supersede itself.");
    const newer = by ? await loadFirmDoc(user.org_id, by) : null;
    await run("UPDATE firm_docs SET superseded_by = ? WHERE id = ? AND org_id = ?", newer?.id ?? null, id, user.org_id);
    changes.push(newer ? `superseded by “${newer.title}”` : "no longer superseded");
  }
  if (body.applies_to !== undefined) {
    const groups = await parseAppliesTo(user.org_id, body.applies_to);
    await setAppliesTo(user.org_id, id, groups);
    changes.push(groups ? `now applies to ${groups.length} group${groups.length > 1 ? "s" : ""} only` : "now applies to all groups");
  }
  if (!changes.length) throw new HttpError(400, "Nothing to change.");
  await audit(user, `Firm library: “${doc.title}” ${changes.join(", ")}`, "Data", null);
}

/**
 * Deletes a firm document and its passages (local and Azure). Documents it superseded are no longer marked
 * superseded. Audited.
 */
export async function deleteFirmDoc(user: User, id: string) {
  const doc = await loadFirmDoc(user.org_id, id);
  await removeIndexed(doc.id);
  await run("UPDATE firm_docs SET superseded_by = NULL WHERE superseded_by = ? AND org_id = ?", doc.id, user.org_id);
  await run("DELETE FROM firm_doc_groups WHERE firm_doc_id = ? AND org_id = ?", doc.id, user.org_id);
  await run("DELETE FROM firm_docs WHERE id = ? AND org_id = ?", doc.id, user.org_id);
  await audit(user, `Deleted “${doc.title}” from the firm library and removed it from search`, "Data", null);
}

/** How many firm documents and passages an org has (Firm library page and deletion certificates). */
export async function firmCounts(orgId: string) {
  const n = async (sql: string) => Number((await get<{ n: number }>(sql, orgId, FIRM_SCOPE))?.n ?? 0);
  return {
    documents: Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM firm_docs WHERE org_id = ?", orgId))?.n ?? 0),
    passages: await n("SELECT COUNT(*) AS n FROM passages WHERE org_id = ? AND workspace_id = ?"),
  };
}

/**
 * Keeps a held firm document in the firm library but **only for the group it seems to be about** (or `groups`):
 * sets "Applies to" to those groups and then keeps it (lib/upload-guard.ts `keepHeld`), so it's indexed and only
 * those groups' answers use it. A limited document isn't flagged as kept: it no longer reaches the wrong groups.
 * Org Owners/Admins only. Audited.
 */
export async function limitHeldFirmDoc(user: User, id: string, groups: unknown) {
  if (!["Org Owner", "Org Admin"].includes(user.role)) throw new HttpError(403, "Only Org Owners and Org Admins can change the firm library.");
  const doc = await get<{ id: string; title: string; status: string; guard_json: string | null }>("SELECT id, title, status, guard_json FROM firm_docs WHERE id = ? AND org_id = ?", id, user.org_id);
  if (!doc) throw new HttpError(404, "Firm document not found.");
  const match = parseMatch(doc.guard_json);
  const chosen = (await parseAppliesTo(user.org_id, groups ?? match?.workspaceId)) ?? (match ? [match.workspaceId] : null);
  if (!chosen) throw new HttpError(400, "Choose the groups it applies to.");
  await setAppliesTo(user.org_id, id, chosen);
  if (doc.status === "Held") await keepHeld(user, "firm", id);
  await run("UPDATE firm_docs SET guard_status = NULL WHERE id = ? AND org_id = ?", id, user.org_id);
  await resolveGuardFinding(user.org_id, id);
  await audit(user, `Firm library: “${doc.title}” limited to ${chosen.length} group${chosen.length > 1 ? "s" : ""}`, "Data", null);
}
