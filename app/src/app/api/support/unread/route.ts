/**
 * GET /api/support/unread → { unread }: how many of this person's own tickets have a reply from the Sidekick
 * team they haven't opened. Drives the dot on the bottom-left assistant button. Who: anyone signed in.
 */
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { unreadCount } from "@/lib/support";

export const GET = handle(async () => ({ unread: await unreadCount(await requireUser()) }));
