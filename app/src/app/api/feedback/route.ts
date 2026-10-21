/**
 * /api/feedback: 👍/👎 on answers (lib/feedback.ts).
 * POST { questionId, ws, vote: "up" | "down" } → { ok }: anyone in the group the answer was given in (one vote per
 *   person per answer; voting again changes it). An answer from another group or org is 404.
 * GET ?days=30 → the organization's counts per group and per week (no text): Org Owner / Org Admin only.
 */
import { handle, readJson, requireText } from "@/lib/api";
import { requireUser, requireWorkspace } from "@/lib/auth";
import { feedbackSummary, parseVote, recordFeedback } from "@/lib/feedback";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ questionId?: string; ws?: string; vote?: unknown }>(req);
  const ws = await requireWorkspace(user, body.ws);
  await recordFeedback(user.org_id, ws, requireText(body.questionId, "Answer id", 64), user.id, parseVote(body.vote), "portal");
  return { ok: true };
});

export const GET = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const days = Math.min(365, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 30));
  return feedbackSummary(user.org_id, new Date(Date.now() - days * 86400_000).toISOString());
});
