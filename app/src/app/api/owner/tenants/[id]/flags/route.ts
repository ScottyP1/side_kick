/**
 * POST /api/owner/tenants/:id/flags: turn one feature on or off for one client organization (a
 * restriction), e.g. switch off the in-app assistant or document uploads for that client only.
 * Who: platform operators only. Logged in the operator log and in the client's own audit log.
 *
 * Body: { key: one of the switch keys in lib/owner.ts FLAGS, enabled: boolean }
 * The platform-wide switch on Releases & switches still wins: a feature paused there is off for everyone.
 */
import { handle, readJson } from "@/lib/api";
import { audit, HttpError } from "@/lib/auth";
import { get, now, run } from "@/lib/db";
import { FLAGS, isPlatformOnly, platformLog, requireOwner, type FlagKey } from "@/lib/owner";
import { BRAND } from "@/lib/brand";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const owner = await requireOwner();
  const org = await get<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE id = ?", (await params).id);
  if (!org) throw new HttpError(404, "Organization not found.");
  const { key, enabled } = await readJson<{ key?: string; enabled?: unknown }>(req);
  if (!key || !(key in FLAGS) || isPlatformOnly(key as FlagKey)) throw new HttpError(400, "Unknown switch.");
  if (typeof enabled !== "boolean") throw new HttpError(400, "Say whether the switch is on (true) or off (false).");
  const label = FLAGS[key as FlagKey].label;
  await run(
    `INSERT INTO org_flags (org_id, flag_key, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (org_id, flag_key) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    org.id, key, enabled ? 1 : 0, owner.name, now(),
  );
  await audit({ org_id: org.id, name: `${BRAND.name} team` }, `${enabled ? "Turned on" : "Turned off"} ${label} for this organization`, "Policy change");
  await platformLog(owner.name, `${enabled ? "Turned on" : "Turned off"} ${label} for ${org.name}`);
  return { ok: true };
});
