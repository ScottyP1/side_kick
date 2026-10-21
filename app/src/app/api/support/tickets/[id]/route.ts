/**
 * One support ticket in the portal. Who: its requester, or an Org Owner/Admin of the same organization
 * (anyone else gets 404). Internal notes from the Sidekick team are never included.
 *
 * GET → { ticket, messages } (opening it clears the requester's "new reply" dot).
 * POST multipart form { message?, file?, action?: "resolve" } → the updated ticket: a reply (reopens a waiting
 *   or resolved ticket) or marking it resolved. Audited.
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { checkAttachment, customerAct, ticketFor } from "@/lib/support";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  return ticketFor(user, (await params).id);
});

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "Send the reply as a form.");
  }
  const body = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
  return customerAct(user, (await params).id, body, await checkAttachment(form.get("file")));
});
