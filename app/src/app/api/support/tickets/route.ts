/**
 * Support tickets in the portal (Help → Contact support, My tickets). Who: anyone signed in.
 *
 * GET → { tickets } the tickets this person may see: Org Owners and Org Admins all of their organization's,
 *   everyone else their own (lib/support.ts `listTicketsFor`), plus the form's choices.
 * POST multipart form { subject, category, priority, description, phone?, page?, file? } → { ticket } opens a
 *   ticket with the person's name and email from their account (one attachment, type and size checked).
 * POST JSON { conversation, description?, page?, priority? } → { ticket } turns their Help assistant
 *   conversation into a ticket, with a summary of what the assistant checked.
 * Audited; open even when the plan is read-only.
 */
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { ATTACHMENT_TYPES, CATEGORIES, CATEGORY_LABELS, checkAttachment, createPortalTicket, createTicketFromConversation, listTicketsFor, MAX_ATTACHMENT_BYTES, PRIORITIES } from "@/lib/support";
import { findConversation } from "@/lib/conversations";

export const GET = handle(async () => {
  const user = await requireUser();
  return {
    tickets: await listTicketsFor(user),
    choices: { categories: CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABELS[c] })), priorities: PRIORITIES, attachmentTypes: ATTACHMENT_TYPES, maxAttachmentMb: MAX_ATTACHMENT_BYTES / 1024 / 1024 },
  };
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = await readJson<Record<string, unknown>>(req);
    const conv = await findConversation("support", { orgId: user.org_id, userId: user.id }, body.conversation);
    if (!conv) throw new HttpError(404, "That conversation has ended (they're kept 24 hours). Use Contact support instead.");
    return { ticket: await createTicketFromConversation(user, conv, body) };
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "Send the ticket as a form.");
  }
  const body = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
  const ticket = await createPortalTicket(user, body, await checkAttachment(form.get("file")));
  return { ticket: { id: ticket.id, ref: ticket.ref } };
});
