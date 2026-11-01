/**
 * @file What Sidekick's own meeting bot shows as its camera in Teams meetings, the organization's choice (Settings,
 * Org Owner/Admin, `orgs.live_camera`; docs/LIVE-MEETINGS.md → "Sidekick's camera").
 *
 * Concepts
 * - **Two choices, never the old still crystal ball** (Cody, Nov 1: "it looks bad"):
 *   - `logo` (the default): a still picture of Sidekick's logo (meetbot/bot-logo.png). The bot runs at its normal size
 *     (2 vCPU / 4 GiB, lib/live-meetings/launcher.ts `botSize`).
 *   - `orb`: the moving crystal ball, Sidekick's page /live/orb drawn in a second browser inside the bot's container
 *     (lib/live-meetings/orb.ts). The container has no graphics card, so that needs a bigger bot (4 vCPU / 8 GiB), which
 *     costs about twice as much per meeting hour. That's why it's opt-in: the client decides.
 * - **Falls back to the logo** by itself: when the moving ball's browser doesn't start, Attendee refuses it or the
 *   container stays too busy (meetbot/shim/core.mjs), and when the Sidekick team turned the moving ball off for
 *   everyone (`SIDEKICK_MEETBOT_ORB=off` on the app, a platform switch; on by default).
 * - **Costs**: each session records the camera it got and its container's size (`live_sessions.bot_camera`, `bot_cpu`,
 *   `bot_memory_gib`), so the Owner Console's cost meter (lib/live-meetings/spend.ts) and its per-client camera line
 *   use each meeting's own size. Firms are told only, in plain words, that the moving ball uses a bigger meeting bot
 *   and costs more per meeting hour; never what it costs (lib/firm-usage.ts rules). The surcharge price is a
 *   placeholder (`MOVING_BALL_ADDON` in lib/plans.ts, unset until Cody prices it).
 * - **Audited**: changing it is a "Policy change" in the audit log.
 *
 * Who may call: the route /api/live/camera (status, set), lib/live-meetings/sessions.ts (`cameraFor` before a bot
 * joins). Every query names the org.
 */
import "server-only";
import { get, run } from "../db";
import { audit, HttpError, isAdmin, type User } from "../auth";
import { BRAND } from "../brand";

/** What the bot shows: Sidekick's logo (still) or the moving crystal ball. */
export type Camera = "logo" | "orb";

/** The choices as Settings shows them, default first. `bigger` = needs the bigger meeting bot (costs more). */
export const CAMERAS: readonly { id: Camera; label: string; note: string; bigger: boolean }[] = [
  { id: "logo", label: `${BRAND.name} logo`, note: `A still picture of the ${BRAND.name} logo. Uses the standard meeting bot.`, bigger: false },
  { id: "orb", label: "Moving crystal ball", note: `${BRAND.name}'s crystal ball, moving: it sparkles while ${BRAND.name} speaks and swirls while it thinks. Uses a bigger meeting bot, so it costs more per meeting hour.`, bigger: true },
];

/** Whether a value is one of the choices. */
export const isCamera = (v: unknown): v is Camera => v === "logo" || v === "orb";

/** Whether the Sidekick team allows the moving ball at all (`SIDEKICK_MEETBOT_ORB=off` turns it off for everyone). */
export const orbAllowed = () => (process.env.SIDEKICK_MEETBOT_ORB ?? "").trim().toLowerCase() !== "off";

/** The organization's choice (the logo until someone picks the moving ball). */
export async function orgCamera(orgId: string): Promise<Camera> {
  const v = (await get<{ live_camera: string | null }>("SELECT live_camera FROM orgs WHERE id = ?", orgId))?.live_camera;
  return v === "orb" ? "orb" : "logo";
}

/** The camera a new meeting's bot is started with: the organization's choice, or the logo while the moving ball is off. */
export async function cameraFor(orgId: string): Promise<Camera> {
  return orbAllowed() ? orgCamera(orgId) : "logo";
}

/** The Settings panel: the organization's choice, the choices, whether the moving ball is available, who may change it. */
export async function cameraStatus(user: User) {
  return { camera: await orgCamera(user.org_id), cameras: CAMERAS, orbAllowed: orbAllowed(), canManage: isAdmin(user) };
}

/**
 * Sets what the organization's meeting bot shows (Org Owner/Admin: 403 otherwise; 400 for anything but `logo` or
 * `orb`). Applies to meetings the bot joins from now on. Audited. Returns the new status.
 */
export async function setOrgCamera(user: User, body: { camera?: unknown } | null) {
  if (!isAdmin(user)) throw new HttpError(403, `Only an Org Owner or Org Admin chooses ${BRAND.name}'s camera in meetings.`);
  if (!isCamera(body?.camera)) throw new HttpError(400, `Pick the ${BRAND.name} logo or the moving crystal ball.`);
  if (body.camera !== (await orgCamera(user.org_id))) {
    await run("UPDATE orgs SET live_camera = ? WHERE id = ?", body.camera, user.org_id);
    await audit(user, `Set ${BRAND.name}'s camera in meetings to ${body.camera === "orb" ? "the moving crystal ball (bigger meeting bot)" : `the ${BRAND.name} logo`}`, "Policy change");
  }
  return cameraStatus(user);
}
