/**
 * One support ticket in the Owner Console. Operators only.
 * GET → { ticket, messages (internal notes included), context (client, plan, recent errors by reference code) }.
 * POST multipart form or JSON { action: reply | note | assign | priority | resolve | reopen, message?, to?,
 *   priority?, file? } → the updated ticket. Each action goes to the operator log, and to the client's audit
 *   log for tickets with an organization (lib/support.ts `ownerAct`).
 */
import { handle, readJson } from "@/lib/api";
import { requireOwner } from "@/lib/owner";
import { checkAttachment, ownerAct, ownerTicket } from "@/lib/support";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  await requireOwner();
  return ownerTicket((await params).id);
});

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const owner = await requireOwner();
  const { id } = await params;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) return ownerAct(owner, id, await readJson<Record<string, unknown>>(req), null);
  const form = await req.formData();
  const body = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
  return ownerAct(owner, id, body, await checkAttachment(form.get("file")));
});
