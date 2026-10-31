/**
 * @file What Sidekick's live meeting bots cost this month, and the platform-wide cap the Sidekick team sets so they can't
 * overspend (docs/LIVE-MEETINGS.md → "Spending controls"). Per-customer plan limits (live meeting hours, lib/limits.ts)
 * are separate and unchanged.
 *
 * Concepts
 * - **The estimate** (`monthSpend`): from Sidekick's own records and Azure's list prices (East US, pay as you go,
 *   checked Oct 31, 2026), no Azure billing API:
 *   - the bot's container: seconds from launch to exit × (vCPU × $0.000024 + GiB × $0.000003)
 *     (`live_sessions.launched_at` / `exited_at`, the size from lib/live-meetings/launcher.ts; one still running counts
 *     up to now);
 *   - Azure AI Speech speech-to-text: minutes heard that way (`live_hearing`) × $1 per hour;
 *   - Azure AI Speech text-to-speech: characters spoken (`live_sessions.tts_chars`) × $15 per million;
 *   - the hosted Recall.ai (organizations that opted in): meeting hours × $0.65.
 *   "On pace for" scales it to the whole month. Claude's part is the AI spend shown next to it, not counted here.
 * - **The cap** (`platform_settings` 'live_cap'): dollars or meeting hours a month, $50 by default, set by the Sidekick
 *   team in the Owner Console (audited in the operator log). At 80% a warning, at 100% an alert (the operator log once
 *   per level per month, and the Owner Console home). Once it's reached Sidekick joins **no new meetings** and says
 *   "live help is paused" (`LIVE_PAUSED`); meetings already running finish; notes after meetings still work.
 * - Azure budgets on the bot's resources (infra/azure/meetbot-setup.sh) only email; this cap is what stops spending.
 *
 * Who may call: lib/live-meetings/sessions.ts (before joining, every minute), the Owner Console routes. Platform-wide
 * work, so it reads across organizations under named system scopes; it returns money and counts only.
 */
import "server-only";
import { all, asSystem, get, now, run } from "../db";
import { platformLog } from "../owner";
import { HttpError } from "../http-error";
import { botSize } from "./launcher";
import { liveMinutes } from "./rules";
import { BRAND } from "../brand";

/** Azure's and Recall.ai's list prices used for the estimate (USD). */
export const RATES = { vcpuSecond: 0.000024, gibSecond: 0.000003, sttHour: 1, ttsPerMillion: 15, recallHour: 0.65 } as const;

/** Said in the chat or the reply when the cap stops Sidekick from joining. */
export const LIVE_PAUSED = `Live help is paused: ${BRAND.name}'s monthly budget for its meeting bot is used up. Meetings already running finish, and the notes after meetings still work.`;

/** The cap: dollars (`usd`) or meeting hours (`hours`) per calendar month (UTC). */
export type LiveCap = { kind: "usd" | "hours"; amount: number };
export const DEFAULT_CAP: LiveCap = { kind: "usd", amount: 50 };

const monthStart = (at: number) => {
  const d = new Date(at);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** This month's live meeting bot spend (estimate) and use, with "on pace for" (see the file header). */
export async function monthSpend(at = Date.now()) {
  const from = monthStart(at);
  return asSystem("live meetings: this month's bot spend across clients", async () => {
    const sessions = await all<{ provider: string; launched_at: string | null; exited_at: string | null; joined_at: string | null; ended_at: string | null; tts_chars: number | null }>(
      "SELECT provider, launched_at, exited_at, joined_at, ended_at, tts_chars FROM live_sessions WHERE created_at >= ? OR (launched_at IS NOT NULL AND exited_at IS NULL)",
      from,
    );
    const { cpu, memoryGib } = botSize();
    let containerSeconds = 0;
    let hours = 0;
    let recallHours = 0;
    let ttsChars = 0;
    for (const s of sessions) {
      if (s.launched_at) {
        const start = Math.max(Date.parse(s.launched_at), Date.parse(from));
        const end = s.exited_at ? Date.parse(s.exited_at) : at;
        if (end > start) containerSeconds += (end - start) / 1000;
      }
      const h = liveMinutes(s.joined_at, s.ended_at, at) / 60;
      hours += h;
      if (s.provider === "recall") recallHours += h;
      ttsChars += Number(s.tts_chars) || 0;
    }
    const sttMinutes = Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM live_hearing WHERE minute >= ? AND source IN ('stt', 'both')", from.slice(0, 16)))?.n ?? 0);
    const containerUsd = containerSeconds * (cpu * RATES.vcpuSecond + memoryGib * RATES.gibSecond);
    const sttUsd = (sttMinutes / 60) * RATES.sttHour;
    const ttsUsd = (ttsChars / 1e6) * RATES.ttsPerMillion;
    const recallUsd = recallHours * RATES.recallHour;
    const totalUsd = containerUsd + sttUsd + ttsUsd + recallUsd;
    // The share of the month gone (at least a day, so the first hours don't project wildly).
    const start = Date.parse(from);
    const d = new Date(at);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const share = Math.min(1, Math.max(86400_000, at - start) / (end - start));
    return {
      containerUsd: round(containerUsd), sttUsd: round(sttUsd), ttsUsd: round(ttsUsd), recallUsd: round(recallUsd), totalUsd: round(totalUsd),
      onPaceUsd: round(totalUsd / share), hours: round(hours, 1), onPaceHours: round(hours / share, 1),
      containerHours: round(containerSeconds / 3600, 1), sttMinutes, ttsChars, size: { cpu, memoryGib },
    };
  });
}

/** The cap the Sidekick team set ($50 a month until then). */
export async function liveCap(): Promise<LiveCap> {
  const row = await asSystem("live meetings: the platform cap", () => get<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'live_cap'"));
  try {
    const v = JSON.parse(row?.value ?? "null") as LiveCap | null;
    if (v && (v.kind === "usd" || v.kind === "hours") && Number.isFinite(v.amount) && v.amount >= 0) return v;
  } catch {
    // fall through
  }
  return DEFAULT_CAP;
}

/**
 * Sets the cap (Owner Console; operators only, the route checks). `kind` usd or hours, `amount` 0 to 100,000 (0 pauses
 * live help at once). Written to the operator log. Returns the new state.
 */
export async function setLiveCap(ownerName: string, body: { kind?: unknown; amount?: unknown }) {
  const kind = body.kind;
  const amount = Number(body.amount);
  if ((kind !== "usd" && kind !== "hours") || !Number.isFinite(amount) || amount < 0 || amount > 100_000) {
    throw new HttpError(400, "Set the cap in dollars or meeting hours a month (0 to 100,000).");
  }
  const cap: LiveCap = { kind, amount: round(amount) };
  await asSystem("live meetings: set the platform cap", () => run(
    "INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('live_cap', ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    JSON.stringify(cap), ownerName, now(),
  ));
  await platformLog(ownerName, `Set the live meeting bot cap to ${cap.kind === "usd" ? `$${cap.amount}` : `${cap.amount} meeting hours`} a month`);
  return capState();
}

/** How much of the cap is used: `ok`, `warn` (80%+) or `reached` (100%+), with this month's spend. */
export async function capState(at = Date.now()) {
  const [cap, spend] = await Promise.all([liveCap(), monthSpend(at)]);
  const used = cap.kind === "usd" ? spend.totalUsd : spend.hours;
  const pct = cap.amount > 0 ? Math.round((used / cap.amount) * 100) : 100;
  const level: "ok" | "warn" | "reached" = pct >= 100 ? "reached" : pct >= 80 ? "warn" : "ok";
  const unit = (n: number) => (cap.kind === "usd" ? `$${round(n).toFixed(2)}` : `${round(n, 1)} h`);
  const message = level === "ok" ? null : level === "reached"
    ? `Live meeting bots reached this month's cap (${unit(used)} of ${unit(cap.amount)}): ${BRAND.name} joins no new meetings until you raise it or the month ends.`
    : `Live meeting bots are at ${pct}% of this month's cap (${unit(used)} of ${unit(cap.amount)}; on pace for ${unit(cap.kind === "usd" ? spend.onPaceUsd : spend.onPaceHours)}).`;
  return { cap, used: cap.kind === "usd" ? round(used) : round(used, 1), pct, level, message, spend };
}

/** Whether the cap stops new meetings now. */
export const capReached = async () => (await capState()).level === "reached";

/**
 * Raises the cap's warning (80%) and alert (100%) once per level per month: an operator log entry and a server warning
 * (the Owner Console home shows the message while it lasts). Called every minute by `live.watch`. Returns the level.
 */
export async function checkCapAlerts(at = Date.now()): Promise<"ok" | "warn" | "reached"> {
  const st = await capState(at);
  if (st.level === "ok") return st.level;
  const month = monthStart(at).slice(0, 7);
  const prev = await asSystem("live meetings: last cap alert", () => get<{ value: string }>("SELECT value FROM platform_settings WHERE key = 'live_cap_alert'"));
  let last: { month?: string; level?: string } = {};
  try {
    last = JSON.parse(prev?.value ?? "{}");
  } catch {
    last = {};
  }
  const rank = { ok: 0, warn: 1, reached: 2 } as const;
  if (last.month === month && rank[(last.level as keyof typeof rank) ?? "ok"] >= rank[st.level]) return st.level;
  await asSystem("live meetings: record the cap alert", () => run(
    "INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('live_cap_alert', ?, 'Sidekick', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    JSON.stringify({ month, level: st.level }), now(),
  ));
  await platformLog(BRAND.name, st.message!);
  console.warn(st.message);
  return st.level;
}
