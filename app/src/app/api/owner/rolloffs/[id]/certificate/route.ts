/**
 * GET /api/owner/rolloffs/:id/certificate?format=pdf|txt: download any deletion certificate, including an
 * organization's after it was deleted (its people can't sign in any more, so the Sidekick team sends it).
 * Who: platform operators only.
 */
import { handle } from "@/lib/api";
import { requireOwner } from "@/lib/owner";
import { certificateFor, certificateResponse } from "@/lib/rolloff";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (req: Request, { params }: Ctx) => {
  await requireOwner();
  return certificateResponse(await certificateFor((await params).id), new URL(req.url).searchParams.get("format"));
});
