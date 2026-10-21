/**
 * The public help bot's review in the Owner Console. Operators only.
 * GET → outcome counts (30 days), today's spend vs budget, limits, whether it's on, unanswered questions.
 * POST { id, action: "done" | "delete" } → { ok } marks an unanswered question handled or removes it (logged).
 */
import { handle, readJson } from "@/lib/api";
import { platformLog, requireOwner } from "@/lib/owner";
import { helpbotReview, updateUnanswered } from "@/lib/helpbot";

export const GET = handle(async () => {
  await requireOwner();
  return helpbotReview();
});

export const POST = handle(async (req: Request) => {
  const owner = await requireOwner();
  const body = await readJson<{ id?: unknown; action?: unknown }>(req);
  await updateUnanswered(body.id, body.action);
  await platformLog(owner.name, `${body.action === "done" ? "Marked done" : "Deleted"} an unanswered help bot question`);
  return { ok: true };
});
