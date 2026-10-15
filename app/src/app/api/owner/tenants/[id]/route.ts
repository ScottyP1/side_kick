import { handle, readJson } from "@/lib/api";
import { audit, HttpError } from "@/lib/auth";
import { get, run } from "@/lib/db";
import { platformLog, requireOwner } from "@/lib/owner";

type Ctx = { params: Promise<{ id: string }> };

// Pause or resume a client's access. Suspended orgs can't sign in or use any feature.
export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const owner = await requireOwner();
  const org = get<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE id = ?", (await params).id);
  if (!org) throw new HttpError(404, "Organization not found.");
  const { status } = await readJson<{ status?: string }>(req);
  if (status !== "Active" && status !== "Suspended") throw new HttpError(400, "Status must be Active or Suspended.");
  run("UPDATE orgs SET status = ? WHERE id = ?", status, org.id);
  audit({ org_id: org.id, name: "Sidekick team" }, status === "Suspended" ? "Paused Sidekick access for this organization" : "Restored Sidekick access", "Access");
  platformLog(owner.name, `${status === "Suspended" ? "Suspended" : "Reactivated"} ${org.name}`);
  return { ok: true };
});
