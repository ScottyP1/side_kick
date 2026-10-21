/**
 * GET /api/rolloffs/:id/certificate?format=pdf|txt: download a deletion certificate (kinds and counts of
 * what was deleted, when, by whom, backups; no content). Default text.
 * Who: Org Owners and Org Admins, for their own organization's roll-offs only (others get 404).
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { certificateFor, certificateResponse } from "@/lib/rolloff";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const cert = await certificateFor((await params).id, user.org_id);
  return certificateResponse(cert, new URL(req.url).searchParams.get("format"));
});
