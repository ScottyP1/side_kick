/**
 * GET/POST /api/auth/setup: first-run setup of a new install.
 * GET tells the UI whether setup is still needed; POST creates the organization and its Org Owner.
 */
import { handle, readJson, requireText } from "@/lib/api";
import { audit, createUser, HttpError, startSession } from "@/lib/auth";
import { get, newId, now, run, tx } from "@/lib/db";

// First-run setup: creates the organization and its Org Owner. Only works while no users exist.
export const GET = handle(async () => ({ needsSetup: !await get("SELECT id FROM users LIMIT 1") }));

export const POST = handle(async (req: Request) => {
  if (await get("SELECT id FROM users LIMIT 1")) throw new HttpError(409, "Setup is already done. Sign in instead.");
  const body = await readJson<{ org?: string; name?: string; email?: string; password?: string }>(req);
  const org = requireText(body.org, "Organization name", 120);
  const name = requireText(body.name, "Your name", 120);
  const email = requireText(body.email, "Email", 200);
  const password = requireText(body.password, "Password", 200);
  if (password.length < 10) throw new HttpError(400, "Use a password with at least 10 characters.");
  const orgId = newId();
  const userId = await tx(async () => {
    await run("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)", orgId, org, now());
    return await createUser(orgId, name, email, "Org Owner", password, false);
  });
  await startSession(userId);
  await audit({ org_id: orgId, name }, `Created organization “${org}”`, "Access");
  return { ok: true };
});
