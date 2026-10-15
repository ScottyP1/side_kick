import { handle } from "@/lib/api";
import { endOwnerSession } from "@/lib/owner";

export const POST = handle(async () => {
  await endOwnerSession();
  return { ok: true };
});
