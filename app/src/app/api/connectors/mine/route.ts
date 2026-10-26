/**
 * GET /api/connectors/mine[?ws=<group>]: the person's own sign-ins to tools ("each person signs in"): every connection
 * in personal mode of the groups they can see (or just `ws`, checked with `requireWorkspace`), with their status
 * (none / connected / expired), the account name they connected with and, when expired, why. Anyone signed in, for
 * themselves only; never tokens. See lib/connector-access.ts (`mySignIns`).
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { mySignIns } from "@/lib/connector-access";

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  return { signIns: await mySignIns(user, new URL(req.url).searchParams.get("ws")) };
});
