/**
 * @file Sidekick's face in Teams meetings: the moving crystal ball its own meeting bot shows as its camera when the
 * organization chose it (lib/live-meetings/camera.ts; docs/LIVE-MEETINGS.md → "Sidekick's camera").
 *
 * Concepts
 * - **The page**: `/live/orb?session=…&sig=…` (app/live/orb) draws the ball full-frame on a dark 16:9 background. The bot's
 *   container loads it in a second, local browser (Attendee's "webpage streamer", `voice_agent_settings.url`) and sends
 *   what it shows through the bot's webcam. The page shows no data at all: only the ball.
 * - **The state**: the page long-polls `GET /api/live/bot/orb` for whether Sidekick is speaking (the ball speeds up,
 *   crackles and sparks) or thinking about a question put to it (the dust swirls). `speaking_from`/`speaking_until` are
 *   set when a spoken answer is queued (from the MP3's length), `thinking_at` while an answer is being written.
 * - **Signed**: `sig` is an HMAC of the session id with the session's own key (`botKey`), so only that session's
 *   container (or Sidekick) can make the address, and it answers nothing but those two flags. Wrong or missing → 401.
 * - **What the bot shows** (`live_sessions.camera`): `orb` (the moving ball) or `logo: <why>` (the still logo,
 *   meetbot/bot-logo.png), reported by the container's shim; with the container's CPU use (`cpu_avg`, `cpu_peak`, %).
 *   The shim falls back to the logo by itself when the ball's browser doesn't start, Attendee refuses it or the
 *   container is too busy (meetbot/shim/core.mjs). Never the old still crystal ball. (`still: <why>` on older sessions.)
 * - **Only when the organization chose it** (Settings → "Sidekick's camera in meetings", lib/live-meetings/camera.ts):
 *   the container has no graphics card, so a second browser draws the ball in software (measured Nov 1,
 *   docs/LIVE-MEETINGS.md → "Sidekick's camera"), which needs a bigger bot: 4 vCPU / 8 GiB instead of 2 / 4
 *   (lib/live-meetings/launcher.ts `botSize`). Otherwise the bot shows the logo and gets no page address.
 *
 * Who may call: lib/live-meetings/launcher.ts (`orbUrl`), lib/live-meetings/sessions.ts (speaking, thinking, camera)
 * and the route app/api/live/bot/orb (`orbState`). Every query names the org.
 */
import "server-only";
import crypto from "node:crypto";
import { asSystem, get, now, run } from "../db";
import { botKey } from "./launcher";
import { sameKey } from "./signature";

/** The page address's signature for a session: an HMAC of "orb" with the session's own key. */
export function orbSig(sessionId: string): string {
  return crypto.createHmac("sha256", botKey(sessionId)).update("orb").digest("base64url");
}

/**
 * The address the bot's container loads as its camera (for a session whose organization chose the moving ball), or
 * null when the base can't serve it: Attendee only loads https pages (its own check), so a plain-http address gets no
 * page in production; outside production (local tests against the fakes) http is let through so the tests see it.
 */
export function orbUrl(base: string, sessionId: string): string | null {
  const root = base.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(root) && (process.env.NODE_ENV === "production" || !/^http:\/\//i.test(root))) return null;
  return `${root}/live/orb?session=${encodeURIComponent(sessionId)}&sig=${orbSig(sessionId)}`;
}

/** The lag between queueing a spoken answer and the meeting hearing it (fetched by the shim, decoded by Attendee). */
const SPEAK_LAG_MS = 900;
/** How long "thinking" lasts at most if an answer never finishes (a crash): the ball calms down by itself. */
const THINKING_MS = 90_000;

/**
 * Seconds of audio in a spoken answer: Azure AI Speech's `audio-24khz-48kbitrate-mono-mp3` is a constant 48 kbit/s
 * (lib/live-meetings/speech.ts), so the length follows from the size. Pure; exported for the tests.
 */
export function mp3Seconds(mp3Base64: string): number {
  const bytes = Math.floor((mp3Base64.replace(/=+$/, "").length * 3) / 4);
  return (bytes * 8) / 48_000;
}

/** Notes that a spoken answer was just queued: the ball shows "speaking" for as long as the meeting hears it. */
export async function noteSpeaking(orgId: string, sessionId: string, mp3Base64: string, at = Date.now()): Promise<void> {
  const from = at + SPEAK_LAG_MS;
  const until = from + Math.ceil(mp3Seconds(mp3Base64) * 1000) + 300;
  await run("UPDATE live_sessions SET speaking_from = ?, speaking_until = ? WHERE id = ? AND org_id = ?", new Date(from).toISOString(), new Date(until).toISOString(), sessionId, orgId);
}

/** Notes that Sidekick started (true) or finished (false) working out an answer to a question put to it. */
export async function noteThinking(orgId: string, sessionId: string, on: boolean): Promise<void> {
  await run("UPDATE live_sessions SET thinking_at = ? WHERE id = ? AND org_id = ?", on ? now() : null, sessionId, orgId);
}

/** Saves what the bot shows (`orb` or `logo: <why>`) and, when reported, the container's CPU use in percent. */
export async function noteCamera(orgId: string, sessionId: string, camera: string | null, cpu: { avg?: number | null; peak?: number | null }): Promise<void> {
  const pct = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
  const avg = pct(cpu.avg);
  const peak = pct(cpu.peak);
  if (camera) await run("UPDATE live_sessions SET camera = ? WHERE id = ? AND org_id = ?", camera.slice(0, 160), sessionId, orgId);
  if (avg !== null) await run("UPDATE live_sessions SET cpu_avg = ? WHERE id = ? AND org_id = ?", avg, sessionId, orgId);
  if (peak !== null) await run("UPDATE live_sessions SET cpu_peak = ? WHERE id = ? AND org_id = ? AND (cpu_peak IS NULL OR cpu_peak < ?)", peak, sessionId, orgId, peak);
}

/** What the page shows: `speaking`, `thinking`, and `over` once the session ended (the page then holds still). */
export type OrbState = { speaking: boolean; thinking: boolean; over: boolean };

/** The state as one word, what the page sends back as `known`: "speaking", "thinking", "over" or "idle". */
export const orbWord = (s: OrbState) => (s.over ? "over" : s.speaking ? "speaking" : s.thinking ? "thinking" : "idle");

/**
 * The ball's state for the page (GET /api/live/bot/orb), or null when the session or signature is wrong (the route
 * answers 401 without saying which). Only these three flags; nothing about the meeting. A long poll: while the state
 * is still `known` (the page's last answer) it waits up to `waitMs`, checking a few times a second, so a quiet meeting
 * costs a request every 20 seconds and a change still shows within half a second.
 */
export async function orbState(sessionId: string, sig: string, opts: { waitMs?: number; known?: string | null } = {}): Promise<OrbState | null> {
  if (!/^[\w-]{1,80}$/.test(sessionId) || !process.env.SIDEKICK_MEETBOT_SECRET || !sameKey(sig, orbSig(sessionId))) return null;
  const start = Date.now();
  for (;;) {
    const s = await asSystem("live meeting camera: the ball's state", () =>
      get<{ status: string; speaking_from: string | null; speaking_until: string | null; thinking_at: string | null }>(
        "SELECT status, speaking_from, speaking_until, thinking_at FROM live_sessions WHERE id = ? AND provider = 'attendee'", sessionId,
      ));
    if (!s) return null;
    const at = Date.now();
    const over = s.status === "ended" || s.status === "failed";
    const from = s.speaking_from ? Date.parse(s.speaking_from) : 0;
    const until = s.speaking_until ? Date.parse(s.speaking_until) : 0;
    const speaking = !over && at >= from && at < until;
    const thinking = !over && !speaking && Boolean(s.thinking_at && at - Date.parse(s.thinking_at) < THINKING_MS);
    const state = { speaking, thinking, over };
    if (orbWord(state) !== opts.known || at - start >= (opts.waitMs ?? 0)) return state;
    await new Promise((r) => setTimeout(r, 400));
  }
}
