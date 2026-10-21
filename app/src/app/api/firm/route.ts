/**
 * GET/POST /api/firm: the organization's firm library (policies, standards, templates every group's answers can use).
 * GET → { docs, counts: { documents, passages }, canManage }: anyone signed in to the org (read-only list).
 * POST (multipart: files[], title?, audience internal|shareable, effective_on? YYYY-MM-DD, replaces? firm doc id)
 *   → { results: [{ name, ok, error?, id? }] }: Org Owner / Org Admin only. Files are checked, counted toward the
 *   plan's document limit, refused if the same text is already there, then indexed once for the whole org
 *   (lib/firm.ts). Audited.
 */
import { handle } from "@/lib/api";
import { isAdmin, requireUser } from "@/lib/auth";
import { firmCounts, listFirmDocs, parseDay, uploadFirmDocs } from "@/lib/firm";

export const GET = handle(async () => {
  const user = await requireUser();
  return { docs: await listFirmDocs(user.org_id), counts: await firmCounts(user.org_id), canManage: isAdmin(user) };
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
  });
  return { results };
});
