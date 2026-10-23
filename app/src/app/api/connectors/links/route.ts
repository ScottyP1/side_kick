/**
 * POST /api/connectors/links { connector, ws, project, audience? ("internal" | "shareable") }: links a project of a
 * connected tool to a group and runs its first sync; returns the link's health (`problem` says if that sync
 * failed). Org Owners/Admins, or the group's Team Lead (`requireManage`). The project must be one the connected
 * account can read. Audited. See lib/connectors.ts (`linkProject`).
 */
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { linkProject } from "@/lib/connectors";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  return { link: await linkProject(user, await readJson(req)) };
});
