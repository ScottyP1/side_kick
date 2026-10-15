import { handle } from "@/lib/api";
import { requireOwner } from "@/lib/owner";

export const GET = handle(async () => ({ owner: await requireOwner() }));
