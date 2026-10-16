/**
 * GET /api/health: is the app up and can it reach its database? Used by Azure (container health probe)
 * and by the Owner Console. Public, so it reveals only yes/no facts: no data, names, keys or versions.
 * Returns 200 when the database answers, 503 (with the same shape) when it doesn't.
 */
import { connection } from "next/server";
import { DIALECT, get } from "@/lib/db";
import { claudeConfigured } from "@/lib/claude";
import { azureSearchConfigured, embeddingsConfigured } from "@/lib/azure-search";

export async function GET() {
  await connection(); // always check live, never a result computed at build time
  let database = false;
  try {
    database = Boolean(await get("SELECT 1 AS ok"));
  } catch (e) {
    console.error("Health check: database unreachable", e);
  }
  const body = {
    ok: database,
    database: { engine: DIALECT, reachable: database },
    claude: claudeConfigured(),
    search: azureSearchConfigured() ? (embeddingsConfigured() ? "azure-hybrid" : "azure-keyword") : "local-keyword",
    teams: Boolean(process.env.CLIENT_ID && process.env.CLIENT_SECRET),
  };
  return Response.json(body, { status: database ? 200 : 503, headers: { "cache-control": "no-store" } });
}
