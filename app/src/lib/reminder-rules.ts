/**
 * @file The plain rules behind per-chat settings and reminder timing: defaults, checking what an admin
 * saves, and "is a reminder due right now in this chat's time zone?". No database or network here, so
 * the tests can call these directly (tests/db.test.mjs).
 *
 * Concepts
 * - **Chat settings**: every linked Teams channel or chat has its own settings (stored as JSON in
 *   `teams_chat_settings`, missing fields = the defaults below):
 *   - `track`: Sidekick reads and remembers every message in the chat (not only @mentions);
 *   (Which chats get meeting notes is one choice per group since Oct 2026: lib/notes-chats.ts. An old `notes` field in
 *   the JSON is ignored here; lib/db.ts `DATA_MIGRATIONS` carried it over.)
 *   - `reminders`: a reminder card is posted once a day at `time` (24-hour "HH:MM") in `timeZone`,
 *     except on `quietDays` (0 = Sunday … 6 = Saturday);
 *   - `afterMeeting` (with `reminders` on): after a meeting, the group's notes card in this chat ends with a short
 *     "3 older items still open" line (items today's daily reminder already listed don't count); a chat that doesn't
 *     get the notes gets a reminder card instead (lib/reminders.ts `remindAfterMeeting`);
 *   - `kinds`: which reminders to include (overdue/unowned action items, open questions and decisions,
 *     out-of-date documents, conflicting sources).
 * - **Slot**: the name of one reminder run, used to never post twice: the chat's local date
 *   ("2026-10-16") for the daily reminder.
 */

/** Which kinds of reminders a chat gets. */
export type ReminderKinds = { actions: boolean; questions: boolean; outdated: boolean; conflicts: boolean };

/** One linked Teams chat's settings (see the file comment). */
export type ChatSettings = {
  track: boolean;
  reminders: boolean;
  time: string;
  timeZone: string;
  quietDays: number[];
  afterMeeting: boolean;
  kinds: ReminderKinds;
};

/**
 * Settings for a chat nobody has changed yet: message tracking and reminders off until an admin turns them on,
 * 9:00 on weekdays, every kind of reminder.
 */
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  track: false,
  reminders: false,
  time: "09:00",
  timeZone: "America/New_York",
  quietDays: [0, 6],
  afterMeeting: true,
  kinds: { actions: true, questions: true, outdated: true, conflicts: true },
};

/** Plain-language names, used in audit entries and the portal. */
export const KIND_LABELS: Record<keyof ReminderKinds, string> = {
  actions: "Overdue or unowned action items",
  questions: "Open questions and decisions",
  outdated: "Out-of-date documents",
  conflicts: "Sources that disagree",
};

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** True if `tz` is a time zone name this server knows (e.g. "Europe/London"). */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Reads stored JSON into full settings: unknown or broken values fall back to the defaults. */
export function parseChatSettings(json: string | null | undefined): ChatSettings {
  let raw: Record<string, unknown> = {};
  try {
    raw = json ? JSON.parse(json) : {};
  } catch {
    raw = {};
  }
  const d = DEFAULT_CHAT_SETTINGS;
  const k = (raw.kinds ?? {}) as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    track: bool(raw.track, d.track),
    reminders: bool(raw.reminders, d.reminders),
    time: typeof raw.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time) ? raw.time : d.time,
    timeZone: validTimeZone(raw.timeZone) ? raw.timeZone : d.timeZone,
    quietDays: Array.isArray(raw.quietDays) ? [...new Set(raw.quietDays.filter((x): x is number => Number.isInteger(x) && x >= 0 && x <= 6))].sort() : d.quietDays,
    afterMeeting: bool(raw.afterMeeting, d.afterMeeting),
    kinds: { actions: bool(k.actions, d.kinds.actions), questions: bool(k.questions, d.kinds.questions), outdated: bool(k.outdated, d.kinds.outdated), conflicts: bool(k.conflicts, d.kinds.conflicts) },
  };
}

/**
 * Applies the changes an admin sent to the current settings. Only known fields are accepted, each
 * checked; anything wrong returns `error` (a sentence to show) and changes nothing. `changed` lists what
 * changed in plain words, for the audit log.
 */
export function applySettingsChanges(current: ChatSettings, changes: unknown): { settings: ChatSettings; changed: string[] } | { error: string } {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return { error: "Send the settings to change." };
  const c = changes as Record<string, unknown>;
  const next: ChatSettings = { ...current, kinds: { ...current.kinds }, quietDays: [...current.quietDays] };
  const changed: string[] = [];
  if ("notes" in c) return { error: "Choose where meeting notes go with “Meeting notes go to” on the group's Teams chats tab." };
  const known = new Set(["track", "reminders", "time", "timeZone", "quietDays", "afterMeeting", "kinds"]);
  const unknown = Object.keys(c).find((key) => !known.has(key));
  if (unknown) return { error: `Unknown setting “${unknown.slice(0, 40)}”.` };
  const onOff = (v: boolean) => (v ? "on" : "off");
  for (const [key, label] of [["track", "message tracking"], ["reminders", "reminders"], ["afterMeeting", "reminders after meetings"]] as const) {
    if (!(key in c)) continue;
    if (typeof c[key] !== "boolean") return { error: `“${label}” must be on or off.` };
    if (next[key] !== c[key]) changed.push(`${label} ${onOff(c[key] as boolean)}`);
    next[key] = c[key] as boolean;
  }
  if ("time" in c) {
    if (typeof c.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.time)) return { error: "Time of day must look like 09:00 (24-hour clock)." };
    if (next.time !== c.time) changed.push(`time ${c.time}`);
    next.time = c.time;
  }
  if ("timeZone" in c) {
    if (!validTimeZone(c.timeZone)) return { error: "That time zone isn't one I know (use a name like Europe/London)." };
    if (next.timeZone !== c.timeZone) changed.push(`time zone ${c.timeZone}`);
    next.timeZone = c.timeZone;
  }
  if ("quietDays" in c) {
    const days = c.quietDays;
    if (!Array.isArray(days) || !days.every((x) => Number.isInteger(x) && x >= 0 && x <= 6)) return { error: "Quiet days must be days of the week (0 = Sunday … 6 = Saturday)." };
    const clean = [...new Set(days as number[])].sort();
    if (clean.length === 7) return { error: "Leave at least one day for reminders (or turn reminders off)." };
    if (clean.join() !== next.quietDays.join()) changed.push(`quiet days ${clean.map((x) => DAY_NAMES[x]).join(", ") || "none"}`);
    next.quietDays = clean;
  }
  if ("kinds" in c) {
    const k = c.kinds as Record<string, unknown>;
    if (!k || typeof k !== "object" || Array.isArray(k)) return { error: "Choose which reminders to send." };
    for (const [key, v] of Object.entries(k)) {
      if (!(key in KIND_LABELS)) return { error: `Unknown kind of reminder “${key.slice(0, 40)}”.` };
      if (typeof v !== "boolean") return { error: `“${KIND_LABELS[key as keyof ReminderKinds]}” must be on or off.` };
      if (next.kinds[key as keyof ReminderKinds] !== v) changed.push(`${KIND_LABELS[key as keyof ReminderKinds].toLowerCase()} ${onOff(v)}`);
      next.kinds[key as keyof ReminderKinds] = v;
    }
    if (!Object.values(next.kinds).some(Boolean)) return { error: "Keep at least one kind of reminder (or turn reminders off)." };
  }
  return { settings: next, changed };
}

/** The local calendar day ("YYYY-MM-DD"), weekday (0 = Sunday) and minutes since midnight of `at` in `timeZone`. */
export function localTime(at: Date, timeZone: string): { day: string; weekday: number; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: DAY_NAMES.indexOf(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * Whether this chat's daily reminder is due at `at`: reminders on, not a quiet day where the chat is,
 * and the local time is at or past the chosen time. Returns the slot (the local date) or null. A server
 * that was down at 9:00 still sends that day's reminder when it comes back, but never the day after.
 */
export function dailySlotDue(s: ChatSettings, at: Date): string | null {
  if (!s.reminders) return null;
  const local = localTime(at, s.timeZone);
  if (s.quietDays.includes(local.weekday)) return null;
  const [h, m] = s.time.split(":").map(Number);
  return local.minutes >= h * 60 + m ? local.day : null;
}

/** Adds `days` to a "YYYY-MM-DD" day and returns the new day. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}

/**
 * How many older open items the "N older items still open" line on a meeting-notes card counts: the items that would
 * be reminded about now (`openKeys`, the meeting's own items already left out) minus those today's daily reminder in
 * the same chat already listed (`listedToday`). 0 means no line at all, so a chat isn't told twice in one day.
 */
export function olderOpenCount(openKeys: readonly string[], listedToday: readonly string[]): number {
  const listed = new Set(listedToday);
  return new Set(openKeys.filter((k) => !listed.has(k))).size;
}
