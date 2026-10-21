/**
 * PATCH /api/owner/tenants/:id/terms: the Sidekick team sets a client's plan terms (lib/limits.ts
 * `saveTerms`): custom limits (Enterprise or managed clients), the monthly AI credit override, the contract
 * price per month (for MRR and margin), the partner or referrer, and the questions per person per hour.
 * Who: platform operators only. Recorded in the operator log and the client's audit log.
 *
 * Body (any of): { limits?: { seats?, workspaces?, chats?, meetingHours?, documents?, connectors?, aiCreditUsd? } | null,
 *   aiCreditUsd?: number | null, monthlyPriceUsd?: number | null, partner?: string | null, askPerHour?: number | null }
 * A null value clears that field (back to the plan's own number).
 */
import { handle, readJson } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { get } from "@/lib/db";
import { forgetCredit } from "@/lib/credit";
import { saveTerms } from "@/lib/limits";
import { platformLog, requireOwner } from "@/lib/owner";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const owner = await requireOwner();
  const org = await get<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE id = ?", (await params).id);
  if (!org) throw new HttpError(404, "Organization not found.");
  const summary = await saveTerms(org.id, await readJson<Record<string, unknown>>(req), owner.name);
  forgetCredit(org.id);
  await platformLog(owner.name, `Set plan terms for ${org.name}: ${summary}`);
  return { ok: true };
});
