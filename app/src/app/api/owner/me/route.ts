/**
 * GET /api/owner/me: the signed-in platform operator.
 */
import { handle } from "@/lib/api";
import { requireOwner } from "@/lib/owner";

export const GET = handle(async () => ({ owner: await requireOwner() }));
