/**
 * POST /api/reminders: for one linked Teams chat, `{ id, action: "preview" }` returns what the next
 * reminder would say (nothing is posted or saved), and `{ id, action: "send" }` posts a reminder there now.
 * Who: Org Owners and Org Admins who can see the chat's workspace. Paused with the owner's "Reminders in
 * Teams" switch. How reminders are built: lib/reminders.ts.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { newId } from "@/lib/db";
import { adminLinkedChat, previewReminder, sendReminder } from "@/lib/reminders";
import { assertEnabled } from "@/lib/owner";
import { traceScope } from "@/lib/trace";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ id?: string; action?: string }>(req);
  const conv = await adminLinkedChat(user, body.id);
  traceScope({ workspaceId: conv.workspace_id });
  await assertEnabled("remind");
  if (body.action === "preview") return { preview: await previewReminder(conv) };
  if (body.action === "send") return await sendReminder(conv, "manual", `manual:${newId()}`);
  throw new HttpError(400, "Choose preview or send.");
});
