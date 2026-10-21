/**
 * GET /api/support/attachments/:id: downloads a file attached to a support ticket. Who: the Sidekick team
 * (Owner Console session), or a portal user who may see the ticket (its requester, or an Org Owner/Admin of
 * its organization). Always sent as a download with its checked type, never shown inline, and with a
 * sandboxing content policy, so a file can't run anything in the browser.
 */
import { handle } from "@/lib/api";
import { currentUser } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { requireOwner } from "@/lib/owner";
import { attachmentFile } from "@/lib/support";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const { id } = await params;
  const owner = await requireOwner().catch(() => null);
  let who: Parameters<typeof attachmentFile>[0];
  if (owner) who = { owner: true };
  else {
    const user = await currentUser();
    if (!user) throw new HttpError(401, "Sign in to continue.");
    who = { user };
  }
  const file = await attachmentFile(who, id);
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `attachment; filename="${file.name.replace(/"/g, "")}"`,
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});
