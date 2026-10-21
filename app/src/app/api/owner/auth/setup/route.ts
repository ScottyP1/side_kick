/**
 * GET/POST /api/owner/auth/setup: create the first Owner Console account (once, from localhost only).
 */
import { handle, readJson, requireText } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { assertLocalRequest, createOwner, ownerExists, platformLog, startOwnerSession } from "@/lib/owner";
import { assertGoodPassword } from "@/lib/passwords";

export const GET = handle(async () => ({ needsSetup: !await ownerExists() }));

// Creates the first Owner Console account. Only works once, and only from localhost.
export const POST = handle(async (req: Request) => {
  await assertLocalRequest();
  if (await ownerExists()) throw new HttpError(409, "The owner account already exists. Sign in instead.");
  const body = await readJson<{ name?: string; email?: string; password?: string }>(req);
  const name = requireText(body.name, "Your name", 120);
  const email = requireText(body.email, "Email", 200);
  const password = requireText(body.password, "Password", 200);
  await assertGoodPassword(password, { email });
  const id = await createOwner(name, email, password);
  await startOwnerSession(id);
  await platformLog(name, "Created the owner account");
  return { ok: true };
});
