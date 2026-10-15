/**
 * GET/POST /api/owner/auth/setup: create the first Owner Console account (once, from localhost only).
 */
import { handle, readJson, requireText } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { assertLocalRequest, createOwner, ownerExists, platformLog, startOwnerSession } from "@/lib/owner";

export const GET = handle(async () => ({ needsSetup: !ownerExists() }));

// Creates the first Owner Console account. Only works once, and only from localhost.
export const POST = handle(async (req: Request) => {
  await assertLocalRequest();
  if (ownerExists()) throw new HttpError(409, "The owner account already exists. Sign in instead.");
  const body = await readJson<{ name?: string; email?: string; password?: string }>(req);
  const name = requireText(body.name, "Your name", 120);
  const email = requireText(body.email, "Email", 200);
  const password = requireText(body.password, "Password", 200);
  if (password.length < 12) throw new HttpError(400, "Use a password with at least 12 characters for the owner account.");
  const id = createOwner(name, email, password);
  await startOwnerSession(id);
  platformLog(name, "Created the owner account");
  return { ok: true };
});
