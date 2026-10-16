/**
 * GET/PATCH/DELETE /api/auth/microsoft: this organization's Microsoft sign-in settings (Settings page).
 * - GET (anyone signed in): whether Microsoft sign-in is set up, connected and required, and whether
 *   the caller's own account is linked to Microsoft.
 * - PATCH { required: boolean } (Org Owner): turn passwords off (or back on) for everyone in the org.
 *   Turning them off needs a connected tenant and the owner's own Microsoft-linked account (so they
 *   can't lock themselves out), and signs everyone else out so they come back through Microsoft.
 * - DELETE (Org Owner): disconnect the tenant (passwords work again). Audited.
 * Connecting is done by signing in with Microsoft: GET /api/auth/microsoft/start?mode=link.
 */
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { handle, readJson } from "@/lib/api";
import { audit, HttpError, requireUser, SESSION_COOKIE } from "@/lib/auth";
import { get, run } from "@/lib/db";
import { entraConfigured } from "@/lib/entra";

const orgRow = (orgId: string) => get<{ entra_tenant_id: string | null; sso_required: number }>("SELECT entra_tenant_id, sso_required FROM orgs WHERE id = ?", orgId);

export const GET = handle(async () => {
  const user = await requireUser();
  const org = await orgRow(user.org_id);
  const me = await get<{ entra_oid: string | null }>("SELECT entra_oid FROM users WHERE id = ?", user.id);
  return {
    configured: entraConfigured(),
    connected: Boolean(org?.entra_tenant_id),
    tenantId: user.role === "Org Owner" || user.role === "Org Admin" ? org?.entra_tenant_id ?? null : null,
    required: org?.sso_required === 1,
    linked: Boolean(me?.entra_oid),
    canManage: user.role === "Org Owner",
  };
});

export const PATCH = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner"]);
  const { required } = await readJson<{ required?: boolean }>(req);
  const org = await orgRow(user.org_id);
  if (required) {
    if (!org?.entra_tenant_id) throw new HttpError(400, "Connect Microsoft sign-in first.");
    const me = await get<{ entra_oid: string | null }>("SELECT entra_oid FROM users WHERE id = ?", user.id);
    if (!me?.entra_oid) throw new HttpError(400, "Sign in with Microsoft yourself first, so you can't get locked out.");
  }
  await run("UPDATE orgs SET sso_required = ? WHERE id = ?", required ? 1 : 0, user.org_id);
  if (required) {
    // End everyone else's sessions (they may have signed in with a password); the owner stays signed in.
    const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
    const mine = crypto.createHash("sha256").update(token).digest("hex");
    await run("DELETE FROM sessions WHERE token_hash <> ? AND user_id IN (SELECT id FROM users WHERE org_id = ?)", mine, user.org_id);
  }
  await audit(user, required ? "Required Microsoft sign-in (passwords turned off)" : "Allowed password sign-in again", "Policy change");
  return { ok: true };
});

export const DELETE = handle(async () => {
  const user = await requireUser(["Org Owner"]);
  await run("UPDATE orgs SET entra_tenant_id = NULL, sso_required = 0 WHERE id = ?", user.org_id);
  await audit(user, "Disconnected Microsoft sign-in", "Policy change");
  return { ok: true };
});
