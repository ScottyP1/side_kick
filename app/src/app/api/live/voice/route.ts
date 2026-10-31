/**
 * GET/PUT /api/live/voice: Sidekick's speaking voice in live meetings, the organization's default
 * (lib/live-meetings/voice-settings.ts; the list: lib/live-meetings/voices.ts).
 * - GET: anyone signed in. The voice and speed in use by default, the allowed voices and speeds, whether samples can be
 *   played (Azure AI Speech set up), and `canManage`.
 * - PUT `{ voiceId?, speed? }`: Org Owner/Admin (403 otherwise); 400 for a voice or speed not on the list. Audited.
 * A group can choose its own voice in its live-meeting settings (PUT /api/workspaces/:id/live).
 */
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { setOrgVoice, voiceStatus } from "@/lib/live-meetings/voice-settings";

export const GET = handle(async () => voiceStatus(await requireUser()));

export const PUT = handle(async (req: Request) => {
  const user = await requireUser();
  return setOrgVoice(user, await readJson<{ voiceId?: unknown; speed?: unknown } | null>(req));
});
