import { handle, readJson } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { checkOwnerPassword, platformLog, startOwnerSession } from "@/lib/owner";

export const POST = handle(async (req: Request) => {
  const { email, password } = await readJson<{ email?: string; password?: string }>(req);
  const owner = checkOwnerPassword(String(email ?? ""), String(password ?? ""));
  if (!owner) throw new HttpError(401, "That email and password don't match an owner account.");
  await startOwnerSession(owner.id);
  platformLog(owner.name, "Signed in to the Owner Console");
  return { ok: true };
});
