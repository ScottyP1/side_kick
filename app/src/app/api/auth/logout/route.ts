import { handle } from "@/lib/api";
import { endSession } from "@/lib/auth";

export const POST = handle(async () => {
  await endSession();
  return { ok: true };
});
