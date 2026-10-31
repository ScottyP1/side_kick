/**
 * POST /api/live/voice/sample `{ voiceId, speed? }`: "Play sample" for a meeting voice: a short fixed, made-up sentence
 * as MP3 (`{ mp3: <base64>, cached }`), made once per voice and speed with Azure AI Speech and then served from the
 * cache (lib/live-meetings/voice-settings.ts `voiceSample`). Org Owners/Admins and Team Leads (403 otherwise); 400 for
 * a voice or speed not on the list; 503 with a plain message when Azure AI Speech isn't set up.
 */
import { handle, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { voiceSample } from "@/lib/live-meetings/voice-settings";

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson<{ voiceId?: unknown; speed?: unknown } | null>(req);
  return voiceSample(user, body?.voiceId, body?.speed);
});
