/**
 * GET/PUT /api/live/camera: what Sidekick's meeting bot shows as its camera in Teams meetings, the organization's
 * choice (lib/live-meetings/camera.ts).
 * - GET: anyone signed in. The choice (`logo` or `orb`), the choices with their plain notes, whether the Sidekick team
 *   allows the moving ball right now (`orbAllowed`), and `canManage`.
 * - PUT `{ camera: "logo" | "orb" }`: Org Owner/Admin (403 otherwise); 400 for anything else. Audited. The moving
 *   crystal ball uses a bigger meeting bot and costs more per meeting hour (never shown to firms in dollars).
 */
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { cameraStatus, setOrgCamera } from "@/lib/live-meetings/camera";

export const GET = handle(async () => cameraStatus(await requireUser()));

export const PUT = handle(async (req: Request) => {
  const user = await requireUser();
  return setOrgCamera(user, await readJson<{ camera?: unknown } | null>(req));
});
