/**
 * @file Which Microsoft 365 organizations (tenants) Sidekick works for, and how each is tied to a Sidekick org.
 *
 * Concepts
 * - **Tenant**: a company's Microsoft 365 directory, identified by a tenant id (a GUID). Teams activities carry
 *   it (`conversation.tenantId`), Microsoft ID tokens carry it (`tid`).
 * - **Tenant ↔ org**: a Sidekick organization is tied to at most one tenant (`orgs.entra_tenant_id`, unique), and
 *   a tenant to at most one org. The tie is made from a verified Microsoft sign-in by the Org Owner (Settings →
 *   Connect Microsoft sign-in, or straight after sign-up with `tieOrgToTenant`). Everything Sidekick does for a
 *   tenant (answering in Teams, listing waiting chats, importing people) goes to that one org.
 * - **Home tenant** (`TENANT_ID`): the tenant Sidekick's own Azure Bot and Entra app live in (Sidekick Labs).
 *   Since July 31, 2025 Microsoft only creates *single-tenant* Azure Bots; such a bot still serves other
 *   companies once the Teams app is published to the Teams Store, and gets its tokens from its home tenant.
 * - **Single-tenant vs multi-tenant mode** (`tenantMode`):
 *   - `TENANT_ID` = a tenant id (and no `SIDEKICK_MULTI_TENANT`) → **single-tenant**: Sidekick only serves its
 *     home tenant. Teams behaves exactly as before: any chat Sidekick is added to gets a link code. The live
 *     site runs like this until Cody switches.
 *   - `SIDEKICK_MULTI_TENANT=1` (recommended: keeps `TENANT_ID` as the bot's home tenant), or `TENANT_ID` unset /
 *     `common` / `organizations` (an older multi-tenant bot) → **multi-tenant**: Teams activities and sign-ins may
 *     come from any company. Sidekick only acts for tenants tied to a Sidekick org; an unknown tenant gets a
 *     friendly "sign up first" card and nothing about it is stored (see lib/teams/bot.ts). Microsoft sign-in
 *     and the directory then use a multi-tenant Entra app (`ENTRA_CLIENT_ID`/`ENTRA_CLIENT_SECRET`, lib/entra.ts).
 * - **Waiting to be assigned**: a chat or channel in a tied tenant that isn't linked to a workspace yet. It
 *   shows on the Workspaces page for Org Admins and Team Leads to assign (no code needed).
 *
 * The switches Cody makes in Azure/Entra/Teams to go multi-tenant are in docs/TEAMS-MULTITENANT.md.
 */
import "server-only";
import { audit, HttpError, type User } from "./auth";
import { asSystem, get, run } from "./db";
import { BRAND } from "./brand";

/** Values of TENANT_ID that mean "any organization" rather than one tenant. */
const ANY_TENANT = new Set(["", "common", "organizations", "botframework.com"]);

/**
 * The tenant Sidekick's own Azure Bot lives in (`TENANT_ID`), or null when it's unset or "any tenant".
 * The Teams SDK gets the bot's tokens there. Read on every call so config changes need no code changes.
 */
export function homeTenantId(): string | null {
  const t = (process.env.TENANT_ID ?? "").trim();
  return ANY_TENANT.has(t.toLowerCase()) ? null : t;
}

/** "multi" when SIDEKICK_MULTI_TENANT is on or TENANT_ID doesn't name one tenant; otherwise "single". */
export const tenantMode = (): "single" | "multi" =>
  ["1", "true", "on"].includes((process.env.SIDEKICK_MULTI_TENANT ?? "").trim().toLowerCase()) || !homeTenantId() ? "multi" : "single";

/** The one tenant this Sidekick serves in single-tenant mode, or null in multi-tenant mode. */
export const singleTenantId = (): string | null => (tenantMode() === "single" ? homeTenantId() : null);

/** A Sidekick organization as seen from its Microsoft tenant. */
export type TenantOrg = { id: string; name: string; status: string };

/** The Sidekick organization tied to this Microsoft tenant, or undefined if none is. */
export async function orgForTenant(tenantId: string | null | undefined): Promise<TenantOrg | undefined> {
  if (!tenantId) return undefined;
  return get<TenantOrg>("SELECT id, name, status FROM orgs WHERE entra_tenant_id = ?", tenantId);
}

/** The tenant tied to this organization, or null. */
export async function tenantOfOrg(orgId: string): Promise<string | null> {
  return (await get<{ entra_tenant_id: string | null }>("SELECT entra_tenant_id FROM orgs WHERE id = ?", orgId))?.entra_tenant_id ?? null;
}

/** Microsoft tenant ids are GUIDs; anything else is refused before it reaches the database. */
export const isTenantId = (t: unknown): t is string => typeof t === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);

/**
 * Ties a Sidekick organization to a Microsoft tenant. **Only call it with a tenant id that came from a verified
 * Microsoft sign-in** (`finishMicrosoftSignIn` in lib/entra.ts) by someone allowed to do this for the org (its
 * Org Owner): the tenant id decides whose Teams chats and directory the org gets.
 *
 * Used by Settings → Connect Microsoft sign-in (the sign-in callback) and meant for the self-service sign-up
 * flow, right after the new Org Owner signs in with Microsoft. Idempotent for the same pair. Audited.
 *
 * @param by      who did it, for the audit log (the Org Owner)
 * @param ownerOid the Org Owner's Microsoft account id, saved on their user row so they're recognised in Teams
 * @throws HttpError 400 for a malformed tenant id, 409 if the tenant belongs to another org or the org to another tenant
 */
export async function tieOrgToTenant(orgId: string, tenantId: string, by: Pick<User, "id" | "org_id" | "name">, ownerOid?: string): Promise<void> {
  if (!isTenantId(tenantId)) throw new HttpError(400, "That isn't a Microsoft organization id.");
  if (by.org_id !== orgId) throw new HttpError(403, "Only the organization's own Org Owner can connect it to Microsoft.");
  // A tenant belongs to one org at most, so this check looks at every org (system work, lib/db.ts asSystem).
  const taken = await asSystem("a tenant belongs to one org", () => get<{ id: string }>("SELECT id FROM orgs WHERE entra_tenant_id = ? AND id <> ?", tenantId, orgId));
  if (taken) throw new HttpError(409, `That Microsoft organization is already connected to another ${BRAND.name} organization. Contact the ${BRAND.name} team.`);
  const current = await tenantOfOrg(orgId);
  if (current && current !== tenantId) throw new HttpError(409, "This organization is already connected to a different Microsoft organization. Disconnect it first.");
  if (ownerOid) {
    await run("UPDATE users SET entra_oid = NULL WHERE org_id = ? AND entra_oid = ? AND id <> ?", orgId, ownerOid, by.id);
    await run("UPDATE users SET entra_oid = ? WHERE id = ?", ownerOid, by.id);
  }
  if (current === tenantId) return;
  await run("UPDATE orgs SET entra_tenant_id = ? WHERE id = ?", tenantId, orgId);
  await audit(by, `Connected Microsoft sign-in (tenant ${tenantId})`, "Policy change");
}

/** The portal's public address (links in Teams cards), without a trailing slash. */
export const portalUrl = (path = "") => `${(process.env.SIDEKICK_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "")}${path}`;
