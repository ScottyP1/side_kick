/**
 * POST /api/gaps: assign or resolve a knowledge gap in a workspace.
 * Who: anyone who can edit content in the workspace.
 */
import { handle, readJson, requireText } from "@/lib/api";
import { audit, canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { run } from "@/lib/db";

// Assign or resolve a knowledge gap. Gaps are keyed by their text within a workspace.
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  if (!canEdit(user)) throw new HttpError(403, "Your role can't change gaps.");
  const body = await readJson<{ ws?: string; gap?: string; status?: string; assignee?: string }>(req);
  const ws = await requireWorkspace(user, body.ws);
  const gap = requireText(body.gap, "Gap", 2000);
  const status = body.status === "Resolved" ? "Resolved" : "Open";
  await run(
    `INSERT INTO gap_status (workspace_id, gap_key, status, assignee) VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, gap_key) DO UPDATE SET status = excluded.status, assignee = COALESCE(excluded.assignee, gap_status.assignee)`,
    ws, gap, status, body.assignee?.trim() || null,
  );
  await audit(user, status === "Resolved" ? `Resolved gap “${gap.slice(0, 60)}”` : `Assigned gap to ${body.assignee}`, "Data", ws);
  return { ok: true };
});
