/**
 * GET/POST /api/firm: the organization's firm library (policies, standards, templates every group's answers can use).
 * GET → { docs, counts: { documents, passages }, canManage }: anyone signed in to the org (read-only list).
 * GET also returns `groups` (every group of the org, for "Applies to" and the move picker; admins only, else []).
 *   For other roles each document's "Applies to" lists only their own groups by name (`hiddenGroups` counts the rest).
 * POST (multipart: files[], title?, audience internal|shareable, effective_on? YYYY-MM-DD, replaces? firm doc id,
 *   applies_to? "all" or group ids, repeated or comma-separated)
 *   → { results: [{ name, ok, error?, id?, held?, question?, match? }] }: Org Owner / Org Admin only. Files are
 *   checked, counted toward the plan's document limit, refused if the same text is already there, checked for
 *   client names (a match is saved **Held**, not indexed: lib/upload-guard.ts), then indexed once for the whole org
 *   (lib/firm.ts). Audited.
 */
import { handle } from "@/lib/api";
import { isAdmin, requireUser, workspaceIdsFor } from "@/lib/auth";
import { firmCounts, listFirmDocs, parseAppliesTo, parseDay, uploadFirmDocs } from "@/lib/firm";
import { moveTargets } from "@/lib/upload-guard";

export const GET = handle(async () => {
  const user = await requireUser();
  const admin = isAdmin(user);
  let docs = await listFirmDocs(user.org_id);
  if (!admin) {
    // Others see the names of their own groups only ("Applies to: Contoso + 1 other group"), and no held text or
    // guard details: held documents aren't used anywhere yet, and which client they mention is for admins.
    const mine = new Set(await workspaceIdsFor(user));
    docs = docs.map((d) => ({ ...d, groups: d.groups.filter((g) => mine.has(g.id)), hiddenGroups: d.groups.filter((g) => !mine.has(g.id)).length, match: null, question: null }));
  }
  return { docs, counts: await firmCounts(user.org_id), canManage: admin, groups: admin ? await moveTargets(user) : [] };
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  const results = await uploadFirmDocs(user, files, {
    title: typeof form.get("title") === "string" ? String(form.get("title")) : null,
    audience: form.get("audience") === "shareable" ? "shareable" : "internal",
    effectiveOn: parseDay(form.get("effective_on")),
    replaces: typeof form.get("replaces") === "string" && form.get("replaces") ? String(form.get("replaces")) : null,
    appliesTo: await parseAppliesTo(user.org_id, form.getAll("applies_to").map(String).join(",")),
  });
  return { results };
});
