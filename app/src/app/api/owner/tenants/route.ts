/**
 * GET/POST /api/owner/tenants: every client organization with its usage, or onboard a new one.
 * Who: platform operators only.
 */
import crypto from "node:crypto";
import { handle, readJson, requireText } from "@/lib/api";
import { audit, createUser, HttpError } from "@/lib/auth";
import { all, get, newId, now, run, tx } from "@/lib/db";
import { platformLog, requireOwner } from "@/lib/owner";

export const GET = handle(async () => {
  await requireOwner();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();
  const tenants = all(
    `SELECT o.id, o.name, o.status, o.created_at,
       (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id) AS users,
       (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id AND u.last_active >= ?) AS active_users,
       (SELECT COUNT(*) FROM workspaces w WHERE w.org_id = o.id) AS workspaces,
       (SELECT COUNT(*) FROM documents d WHERE d.org_id = o.id) AS documents,
       (SELECT COUNT(*) FROM meetings m WHERE m.org_id = o.id) AS meetings,
       (SELECT COALESCE(SUM(cost_usd),0) FROM usage_events e WHERE e.org_id = o.id AND e.created_at >= ?) AS month_cost,
       (SELECT COUNT(*) FROM usage_events e WHERE e.org_id = o.id AND e.created_at >= ?) AS month_calls,
       (SELECT COALESCE(SUM(1-ok),0) FROM usage_events e WHERE e.org_id = o.id AND e.created_at >= ?) AS month_errors,
       (SELECT MAX(created_at) FROM usage_events e WHERE e.org_id = o.id) AS last_activity,
       (SELECT email FROM users u WHERE u.org_id = o.id AND u.role = 'Org Owner' LIMIT 1) AS owner_email
     FROM orgs o ORDER BY o.created_at`,
    since7, monthStart, monthStart, monthStart,
  );
  return { tenants };
});

// Onboard a new client organization with its first Org Owner (temporary password shown once).
export const POST = handle(async (req: Request) => {
  const owner = await requireOwner();
  const body = await readJson<{ org?: string; name?: string; email?: string }>(req);
  const org = requireText(body.org, "Organization name", 120);
  const name = requireText(body.name, "Admin name", 120);
  const email = requireText(body.email, "Admin email", 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  if (get("SELECT id FROM users WHERE email = ?", email)) throw new HttpError(409, "Someone with that email already has an account.");
  const temp = crypto.randomBytes(9).toString("base64url");
  const orgId = newId();
  tx(() => {
    run("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)", orgId, org, now());
    createUser(orgId, name, email, "Org Owner", temp, true);
  });
  audit({ org_id: orgId, name: "Sidekick team" }, `Created organization “${org}” with ${name} as Org Owner`, "Access");
  platformLog(owner.name, `Onboarded ${org} (${email})`);
  return { id: orgId, tempPassword: temp };
});
