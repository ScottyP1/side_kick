/**
 * GET/POST /api/auth/setup: first-run setup of a new install.
 * GET tells the UI whether setup is still needed (and whether Microsoft sign-in is available); POST creates the organization and its Org Owner.
 * Who: POST only from the machine running Sidekick (localhost), or in production with the one-time setup
 * code from the `SIDEKICK_SETUP_CODE` secret (see `setupRefusal` in lib/owner.ts), and only while nobody has an account, so a
 * stranger can never create an organization on a server that happens to be empty. Every later
 * organization is created by the Sidekick team in the Owner Console.
 */
import { handle, readJson, requireText } from "@/lib/api";
import { audit, createUser, HttpError, startSession } from "@/lib/auth";
import { get, newId, now, run, tx } from "@/lib/db";
import { entraConfigured } from "@/lib/entra";
import { assertSetupAllowed, setupNeedsCode } from "@/lib/owner";
import { assertGoodPassword } from "@/lib/passwords";
import { BRAND } from "@/lib/brand";

// First-run setup: creates the organization and its Org Owner. Only works while no users exist.
// `microsoft` tells the sign-in page whether to show "Sign in with Microsoft"; `needsCode` whether the setup
// page must ask for the setup code.
export const GET = handle(async () => ({ needsSetup: !await get("SELECT id FROM users LIMIT 1"), microsoft: entraConfigured(), needsCode: setupNeedsCode() }));

export const POST = handle(async (req: Request) => {
  const body = await readJson<{ org?: string; name?: string; email?: string; password?: string; setupCode?: string }>(req);
  await assertSetupAllowed(body.setupCode, `First-run setup only works on the machine running ${BRAND.name} (localhost). New organizations are added by the ${BRAND.name} team in the Owner Console.`);
  if (await get("SELECT id FROM users LIMIT 1")) throw new HttpError(409, "Setup is already done. Sign in instead.");
  const org = requireText(body.org, "Organization name", 120);
  const name = requireText(body.name, "Your name", 120);
  const email = requireText(body.email, "Email", 200);
  const password = requireText(body.password, "Password", 200);
  await assertGoodPassword(password, { email });
  const orgId = newId();
  const userId = await tx(async () => {
    await run("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)", orgId, org, now());
    return await createUser(orgId, name, email, "Org Owner", password, false);
  });
  await startSession(userId);
  await audit({ org_id: orgId, name }, `Created organization “${org}”`, "Access");
  return { ok: true };
});
