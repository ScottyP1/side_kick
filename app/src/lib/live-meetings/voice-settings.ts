/**
 * @file Choosing Sidekick's speaking voice for live meetings (the list: lib/live-meetings/voices.ts): the organization's
 * default (Settings, Org Owner/Admin, `orgs.live_voice`), a group's override (its live-meeting settings,
 * lib/live-meetings/sessions.ts `setLiveMode`), the voice the bot actually uses (`voiceFor`), and "Play sample".
 *
 * Concepts
 * - **Only ids are stored**, validated against the allowed list; speed 0.9×–1.2×.
 * - **Samples cost nothing after the first**: each voice-and-speed sample is made once with Azure AI Speech and kept
 *   (`live_voice_samples`, platform-wide: the sample text is the same fixed, made-up sentence for everyone). When speech
 *   isn't set up (no Azure AI Speech key, e.g. local or tests without the fake), "Play sample" says so plainly (503).
 * - **Audited**: changing the organization's voice is a "Policy change" in the audit log (the group's is audited with
 *   its other live-meeting settings).
 *
 * Who may call: the routes /api/live/voice and /api/live/voice/sample, and sessions.ts (`voiceFor` before speaking).
 */
import "server-only";
import { asSystem, get, now, run } from "../db";
import { audit, HttpError, isAdmin, type User } from "../auth";
import { speechConfigured, synthesize } from "./speech";
import { effectiveVoice, isSpeed, isVoice, parseVoice, SAMPLE_TEXT, SPEEDS, voiceLabel, VOICES } from "./voices";
import { groupSettings } from "./sessions";
import { BRAND } from "../brand";

/** The organization's default voice and speed (nulls = Sidekick's default). */
export async function orgVoice(orgId: string) {
  return parseVoice((await get<{ live_voice: string | null }>("SELECT live_voice FROM orgs WHERE id = ?", orgId))?.live_voice);
}

/** The voice and speed Sidekick speaks with in a group's meetings: the group's, else the organization's, else the default. */
export async function voiceFor(orgId: string, workspaceId: string) {
  const [group, org] = await Promise.all([groupSettings(orgId, workspaceId), orgVoice(orgId)]);
  return effectiveVoice({ voiceId: group.voiceId, speed: group.speed }, org);
}

/** The Settings panel: the organization's voice and speed, the choices, whether samples can be played, who may change it. */
export async function voiceStatus(user: User) {
  const v = await orgVoice(user.org_id);
  return { ...effectiveVoice({ voiceId: null, speed: null }, v), voices: VOICES, speeds: SPEEDS, speechReady: speechConfigured(), canManage: isAdmin(user) };
}

/**
 * Sets the organization's default voice and/or speed (Org Owner/Admin: 403 otherwise; 400 for a voice or speed not
 * on the list). Audited. Returns the new status.
 */
export async function setOrgVoice(user: User, body: { voiceId?: unknown; speed?: unknown } | null) {
  if (!isAdmin(user)) throw new HttpError(403, "Only an Org Owner or Org Admin chooses the organization's voice.");
  if (body?.voiceId === undefined && body?.speed === undefined) throw new HttpError(400, "Pick a voice or a speed.");
  const cur = await orgVoice(user.org_id);
  const next = { ...cur };
  if (body?.voiceId !== undefined) {
    if (!isVoice(body.voiceId)) throw new HttpError(400, "Pick one of the listed voices.");
    next.voiceId = body.voiceId;
  }
  if (body?.speed !== undefined) {
    if (!isSpeed(body.speed)) throw new HttpError(400, "Pick a speed from 0.9× to 1.2×.");
    next.speed = body.speed;
  }
  if (JSON.stringify(next) !== JSON.stringify(cur)) {
    await run("UPDATE orgs SET live_voice = ? WHERE id = ?", JSON.stringify(next), user.org_id);
    const eff = effectiveVoice({ voiceId: null, speed: null }, next);
    await audit(user, `Set ${BRAND.name}'s voice in meetings to ${voiceLabel(eff.voiceId)} at ${eff.speed}×`, "Policy change");
  }
  return voiceStatus(user);
}

/**
 * "Play sample": a short fixed sentence in a voice at a speed, as MP3 (base64). Org Owners/Admins and Team Leads (who
 * choose voices). Made once per voice and speed with Azure AI Speech, then served from `live_voice_samples`. 503 with
 * a plain message when speech isn't set up.
 */
export async function voiceSample(user: User, voiceId: unknown, speed: unknown): Promise<{ mp3: string; cached: boolean }> {
  if (!isAdmin(user) && user.role !== "Team Lead") throw new HttpError(403, "Only admins and Team Leads choose voices.");
  if (!isVoice(voiceId)) throw new HttpError(400, "Pick one of the listed voices.");
  const s = speed === undefined || speed === null ? 1 : speed;
  if (!isSpeed(s)) throw new HttpError(400, "Pick a speed from 0.9× to 1.2×.");
  const key = s.toFixed(2);
  const cached = await asSystem("live meetings: voice samples (the same for everyone)", () =>
    get<{ mp3: string }>("SELECT mp3 FROM live_voice_samples WHERE voice_id = ? AND speed = ?", voiceId, key));
  if (cached) return { mp3: cached.mp3, cached: true };
  if (!speechConfigured()) throw new HttpError(503, `Voice samples need Azure AI Speech, which isn't set up on this ${BRAND.name} yet. You can still choose a voice.`);
  const mp3 = await synthesize(SAMPLE_TEXT, { voiceId, speed: s });
  await asSystem("live meetings: keep the voice sample", () => run(
    "INSERT INTO live_voice_samples (voice_id, speed, mp3, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (voice_id, speed) DO NOTHING", voiceId, key, mp3, now(),
  ));
  return { mp3, cached: false };
}
