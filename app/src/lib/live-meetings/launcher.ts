/**
 * @file Starting and stopping Sidekick's own meeting bot: **one Azure Container Apps job execution per meeting**
 * (docs/LIVE-MEETINGS.md → "Runs only during meetings"). Nothing runs between meetings, so there's no fixed cost: the
 * job's container (Attendee + our raise-hand patch + Redis + the shim, image `meetbot/`) starts about 2 minutes before a
 * meeting or on "@Sidekick join" and exits when the meeting ends or Sidekick is stopped.
 *
 * Concepts
 * - **Azure Resource Manager**: `POST …/Microsoft.App/jobs/{job}/start` with the meeting's settings as environment
 *   variable overrides, and `POST …/jobs/{job}/executions/{name}/stop` (API version 2024-03-01,
 *   https://learn.microsoft.com/rest/api/resource-manager/containerapps/jobs/start).
 * - **Who may start it**: the Sidekick app's managed identity (Container Apps gives it `IDENTITY_ENDPOINT` and
 *   `IDENTITY_HEADER`), with a role on the job only (infra/azure/meetbot-setup.sh). No keys are stored.
 * - **Settings** (environment): `SIDEKICK_MEETBOT_JOB` (job name), `SIDEKICK_MEETBOT_RG` (default `sidekick-rg`),
 *   `AZURE_SUBSCRIPTION_ID`, `SIDEKICK_MEETBOT_IMAGE` (the pinned image), `SIDEKICK_MEETBOT_CPU` / `_MEMORY_GIB`
 *   (default 2 vCPU / 4 GiB; measure and adjust). `SIDEKICK_ARM_BASE` points at a fake in the tests (http only outside
 *   production).
 * - **What the container gets**: the session id, the meeting link, the bot's name, Sidekick's address, the session's own
 *   key (`botKey`: an HMAC of the session id with `SIDEKICK_MEETBOT_SECRET`, so a container can only act for its own
 *   meeting), whether to raise its hand in Teams. The Azure speech key comes from the job's own Key Vault secret.
 *
 * Who may call: lib/live-meetings/attendee.ts only. Each call is a trace span (kind `live`).
 */
import "server-only";
import crypto from "node:crypto";
import { span } from "../trace";

/** The job's secrets (env name → the job's secret name), as infra/azure/meetbot-setup.sh sets them up. */
const JOB_SECRETS: [string, string][] = [
  ["DATABASE_URL", "database-url"], ["DJANGO_SECRET_KEY", "django-secret"], ["CREDENTIALS_ENCRYPTION_KEY", "credentials-key"], ["AZURE_SPEECH_KEY", "speech-key"],
];

/** Container size for one meeting (vCPU, GiB). Start at 2 / 4 and measure (Chrome is the heavy part). */
export function botSize(): { cpu: number; memoryGib: number } {
  const cpu = Number(process.env.SIDEKICK_MEETBOT_CPU) || 2;
  const memoryGib = Number(process.env.SIDEKICK_MEETBOT_MEMORY_GIB) || 4;
  return { cpu, memoryGib };
}

/** The job's address in Azure Resource Manager, or null when the meeting bot isn't set up on this copy. */
function jobUrl(): string | null {
  const job = process.env.SIDEKICK_MEETBOT_JOB?.trim();
  const sub = process.env.AZURE_SUBSCRIPTION_ID?.trim();
  const rg = process.env.SIDEKICK_MEETBOT_RG?.trim() || "sidekick-rg";
  const base = (process.env.SIDEKICK_ARM_BASE?.trim() || "https://management.azure.com").replace(/\/+$/, "");
  if (!job || !sub || !process.env.SIDEKICK_MEETBOT_SECRET?.trim()) return null;
  if (!base.startsWith("https://") && process.env.NODE_ENV === "production") return null;
  return `${base}/subscriptions/${encodeURIComponent(sub)}/resourceGroups/${encodeURIComponent(rg)}/providers/Microsoft.App/jobs/${encodeURIComponent(job)}`;
}

/** Whether Sidekick can start its own meeting bot here (job, subscription, secret and a managed identity). */
export const launcherConfigured = () => Boolean(jobUrl() && process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER);

/** The session's own key: what its container signs events and fetches commands with (never stored). */
export function botKey(sessionId: string): string {
  return crypto.createHmac("sha256", process.env.SIDEKICK_MEETBOT_SECRET ?? "").update(`meetbot:${sessionId}`).digest("base64url");
}

let cached: { token: string; until: number } | null = null;
/** A token for Azure Resource Manager from the app's managed identity (cached until 5 minutes before it expires). */
async function armToken(): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) throw new Error("Sidekick's managed identity isn't available to start the meeting bot.");
  const res = await fetch(`${endpoint}?resource=${encodeURIComponent("https://management.azure.com/")}&api-version=2019-08-01`, {
    headers: { "X-IDENTITY-HEADER": header }, signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Sidekick's managed identity didn't give a token (${res.status}).`);
  const body = (await res.json()) as { access_token?: string; expires_on?: string | number };
  if (!body.access_token) throw new Error("Sidekick's managed identity didn't give a token.");
  const expires = Number(body.expires_on) * 1000 || Date.now() + 30 * 60_000;
  cached = { token: body.access_token, until: expires - 5 * 60_000 };
  return body.access_token;
}

/** One call to Azure Resource Manager; a plain error on failure (status and Azure's short message, never the token). */
async function arm(path: string, body: unknown, what: string): Promise<Record<string, unknown>> {
  const url = jobUrl();
  if (!url) throw new Error("Sidekick's meeting bot isn't set up on this copy (SIDEKICK_MEETBOT_JOB).");
  const res = await fetch(`${url}${path}?api-version=2024-03-01`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await armToken()}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = String(((await res.json()) as { error?: { message?: unknown } }).error?.message ?? "").replace(/\s+/g, " ").slice(0, 200);
    } catch {
      // not JSON
    }
    throw new Error(`Azure couldn't ${what} (${res.status}${detail ? `: ${detail}` : ""}).`);
  }
  return res.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

/**
 * Starts one execution of the meeting-bot job for a session, with its settings as environment overrides. Returns the
 * execution's name (to stop it later).
 */
export async function startBot(o: { sessionId: string; meetingUrl: string; botName: string; sidekickUrl: string; raiseHand: boolean }): Promise<string> {
  const { cpu, memoryGib } = botSize();
  const image = process.env.SIDEKICK_MEETBOT_IMAGE?.trim();
  if (!image) throw new Error("Sidekick's meeting bot image isn't set (SIDEKICK_MEETBOT_IMAGE).");
  const env = [
    { name: "SIDEKICK_SESSION", value: o.sessionId },
    { name: "SIDEKICK_URL", value: o.sidekickUrl },
    { name: "SIDEKICK_BOT_KEY", value: botKey(o.sessionId) },
    { name: "MEETING_URL", value: o.meetingUrl },
    { name: "BOT_NAME", value: o.botName },
    { name: "RAISE_HAND", value: o.raiseHand ? "1" : "0" },
    // A start's container replaces the job's own, so the job's secrets are named again here (the same names as
    // infra/azure/meetbot-setup.sh gives them; the values stay in Key Vault).
    ...JOB_SECRETS.map(([name, secretRef]) => ({ name, secretRef })),
    { name: "AZURE_SPEECH_REGION", value: process.env.AZURE_SPEECH_REGION?.trim() || "eastus" },
    { name: "POSTGRES_SSL_REQUIRE", value: "true" },
  ];
  const out = await span("live", "Start the meeting bot's container", () =>
    arm("/start", { containers: [{ name: "meetbot", image, env, resources: { cpu, memory: `${memoryGib}Gi` } }] }, "start the meeting bot"), { cpu, memoryGib });
  const name = typeof out.name === "string" ? out.name : typeof out.id === "string" ? String(out.id).split("/").pop() ?? "" : "";
  if (!name) throw new Error("Azure didn't name the meeting bot's execution.");
  return name;
}

/** Stops a meeting bot's execution (when its container didn't leave by itself). An execution already gone is fine. */
export async function stopBot(execution: string): Promise<void> {
  try {
    await span("live", "Stop the meeting bot's container", () => arm(`/executions/${encodeURIComponent(execution)}/stop`, {}, "stop the meeting bot"));
  } catch (e) {
    if (e instanceof Error && /\((404|409)\b/.test(e.message)) return;
    throw e;
  }
}
