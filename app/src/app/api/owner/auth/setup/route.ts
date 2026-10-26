/**
 * GET/POST /api/owner/auth/setup: create the first Owner Console account (once).
 * Who: on a laptop, only requests made to localhost; in production only with the one-time setup code from
 * the `SIDEKICK_SETUP_CODE` secret (see `setupRefusal` in lib/owner.ts). GET also says whether a code is needed
 * and whether "Sign in with Microsoft" is on (`microsoft`); when it is, the sign-in page doesn't send people to
 * this setup, because the first Microsoft sign-in of an allowed account creates the owner account itself.
 */
import { handle, readJson, requireText } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { assertSetupAllowed, createOwner, ownerExists, ownerMicrosoftEnabled, platformLog, setupNeedsCode, startOwnerSession } from "@/lib/owner";
import { assertGoodPassword } from "@/lib/passwords";

export const GET = handle(async () => ({ needsSetup: !await ownerExists(), needsCode: setupNeedsCode(), microsoft: ownerMicrosoftEnabled() }));

// Creates the first Owner Console account. Only works once, and only from localhost or with the setup code.
export const POST = handle(async (req: Request) => {
  const body = await readJson<{ name?: string; email?: string; password?: string; setupCode?: string }>(req);
  await assertSetupAllowed(body.setupCode);
  if (await ownerExists()) throw new HttpError(409, "The owner account already exists. Sign in instead.");
  const name = requireText(body.name, "Your name", 120);
  const email = requireText(body.email, "Email", 200);
  const password = requireText(body.password, "Password", 200);
  await assertGoodPassword(password, { email });
  const id = await createOwner(name, email, password);
  await startOwnerSession(id);
  await platformLog(name, "Created the owner account");
  return { ok: true };
});
