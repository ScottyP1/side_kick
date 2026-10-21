/**
 * GET/POST /api/owner/releases: the running version, models in use, kill switches and the operator log; POST flips a kill switch.
 * Who: platform operators only.
 */
import { handle, readJson } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { MODELS } from "@/lib/claude";
import { all, now, run } from "@/lib/db";
import { buildInfo } from "@/lib/ops";
import { FLAGS, flagEnabled, platformLog, requireOwner, type FlagKey } from "@/lib/owner";

export const GET = handle(async () => {
  await requireOwner();
  return {
    build: buildInfo(),
    models: MODELS,
    flags: await Promise.all((Object.keys(FLAGS) as FlagKey[]).map(async (k) => ({ key: k, ...FLAGS[k], enabled: await flagEnabled(k) }))),
    log: await all("SELECT id, actor, action, created_at FROM platform_log ORDER BY id DESC LIMIT 50"),
  };
});

// Flip a kill switch for every client at once.
export const POST = handle(async (req: Request) => {
  const owner = await requireOwner();
  const { key, enabled } = await readJson<{ key?: string; enabled?: boolean }>(req);
  if (!key || !(key in FLAGS)) throw new HttpError(400, "Unknown switch.");
  await run(
    "INSERT INTO platform_flags (key, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    key, enabled ? 1 : 0, owner.name, now(),
  );
  await platformLog(owner.name, `${enabled ? "Turned on" : "Paused"} ${FLAGS[key as FlagKey].label} for all clients`);
  return { ok: true };
});
