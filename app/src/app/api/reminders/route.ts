/**
 * POST /api/reminders: for one linked Teams chat, `{ id, action: "preview" }` returns what the next
 * reminder would say (nothing is posted or saved), and `{ id, action: "send" }` posts a reminder there now.
 * Who: Org Owners and Org Admins, or a Team Lead of the chat's workspace. Paused with the owner's "Reminders in
 * Teams" switch. Reminders are a plan feature (Team and up): a chat without reminders switched on needs a plan
 * that includes them (402 `kind: "limit"`); chats that already have them keep working. How reminders are
 * built: lib/reminders.ts.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError, requireUser } from "@/lib/auth";
import { newId } from "@/lib/db";
import { getChatSettings, managedLinkedChat, previewReminder, sendReminder } from "@/lib/reminders";
import { assertFeature } from "@/lib/limits";
import { assertEnabled } from "@/lib/owner";
import { traceScope } from "@/lib/trace";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ id?: string; action?: string }>(req);
  const conv = await managedLinkedChat(user, body.id);
  traceScope({ workspaceId: conv.workspace_id });
  // Both the platform-wide switch and this organization's own switch (Owner Console restriction).
  await assertEnabled("remind", user.org_id, user.role);
  if (!(await getChatSettings(conv)).reminders) await assertFeature(user.org_id, "reminders");
  if (body.action === "preview") return { preview: await previewReminder(conv) };
  if (body.action === "send") return await sendReminder(conv, "manual", `manual:${newId()}`);
  throw new HttpError(400, "Choose preview or send.");
});
