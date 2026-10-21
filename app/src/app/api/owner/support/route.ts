/**
 * GET /api/owner/support: the Owner Console's Support inbox. Query: status, priority, category, client (org id
 * or "none" for website tickets), q (subject, reference, name or email). Returns { tickets, counts, unread,
 * clients }. Operators only.
 */
import { handle } from "@/lib/api";
import { requireOwner } from "@/lib/owner";
import { inbox } from "@/lib/support";

export const GET = handle(async (req: Request) => {
  await requireOwner();
  const p = new URL(req.url).searchParams;
  return inbox({ status: p.get("status") ?? undefined, priority: p.get("priority") ?? undefined, category: p.get("category") ?? undefined, client: p.get("client") ?? undefined, q: p.get("q") ?? undefined });
});
