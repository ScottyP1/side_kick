/**
 * GET /api/health: is the app up and can it reach its database? Used by Azure (container health probe)
 * and by the Owner Console. Public, so it reveals only yes/no facts: no data, names, keys or versions.
 * Returns 200 when the database answers, 503 (with the same shape) when it doesn't. The first check by each
 * copy of the app also records the release it runs (lib/ops.ts), for the Owner Console's list of deploys.
 */
import { connection } from "next/server";
import { healthFacts, noteRelease } from "@/lib/ops";

export async function GET() {
  await connection(); // always check live, never a result computed at build time
  const body = await healthFacts();
  if (body.ok) await noteRelease();
  return Response.json(body, { status: body.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
