/**
 * @file Plain rules applied to the meeting notes Claude writes (`processMeeting` in lib/sidekick.ts), before they
 * are saved. Pure (no database, no AI), so they are unit-tested directly (tests/db.test.mjs).
 *
 * Concepts
 * - **Follow-ups are not decisions** (`isFollowUp`, `tidyNotes`): "Let's look at all of this again in two weeks" is
 *   a plan to meet or review again, not a project decision. The notes prompt asks Claude to make it an action item;
 *   if it still comes back as a decision, it is moved to the action items here, so decision lists (and the
 *   watchers' "a later decision changed this document" check, lib/watchers.ts) only hold real decisions.
 * - **Relative due dates** (`relativeDue`): "in two weeks", "next week", "tomorrow" are worked out from the meeting
 *   day when Claude gave no calendar date, so the follow-up gets a due date (Nov 5 for a meeting on Oct 22). Only
 *   phrases with one clear meaning are resolved; anything else keeps no date rather than a guessed one. A due phrase
 *   on its own (`dueFromPhrase`: "Wednesday", "by Friday", "Nov 12") is resolved too, but only from the item's due
 *   field, never from its sentence ("Review the Friday checklist" isn't due Friday).
 * - **Sidekick was in the meeting live** (`LiveContext`, lib/live-meetings/claims.ts `liveContext`): its running list
 *   of decisions and action items (owners and dates heard live, including replies to its own "by when…?" questions)
 *   and its own answers in the meeting. `liveContextBlock` gives them to Claude with the transcript (the answers count
 *   as meeting content, marked as Sidekick's); `mergeLiveList` then carries the list's owners and dates onto the notes
 *   (an item with no owner or date gets the list's) and adds list action items the notes left out, so nothing heard
 *   live is lost (first live trial, Nov 1 2026: "by Wednesday" was on the list but the card said "No date").
 */

/** Words for numbers people say in meetings ("in two weeks"). */
const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10 };

/** "Review X again in two weeks", "revisit on Monday", "let's check back next week", "reconvene", "regroup". */
const FOLLOW_UP = /\b(?:(?:review|revisit|look (?:at|over)|check|come back to|go over|discuss|meet|catch up|sync)\b[^.;]{0,80}\b(?:again|back)\b|revisit|reconvene|regroup|check back|follow[- ]up meeting|touch base)\b/i;

/** True when a "decision" is really a plan to meet or review again later (see the file comment). */
export const isFollowUp = (text: string) => FOLLOW_UP.test(text);

/** A YYYY-MM-DD day plus `days`. */
const addDays = (day: string, days: number) => new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);

/**
 * The due date a relative phrase in `text` means, counted from the meeting day `heldAt` (YYYY-MM-DD…): "in two
 * weeks" (+14), "in 3 days" (+3), "in a fortnight" (+14), "next week" (+7), "tomorrow" (+1). Returns the phrase as
 * spoken and the day, or null when there is no such phrase (or the meeting day can't be read).
 */
export function relativeDue(text: string, heldAt: string): { due: string; dueDate: string } | null {
  if (Number.isNaN(Date.parse(heldAt.slice(0, 10)))) return null;
  const n = text.match(/\bin (a|an|one|two|three|four|five|six|seven|eight|ten|\d{1,2}) (day|week)s?\b/i);
  if (n) {
    const count = NUMBERS[n[1].toLowerCase()] ?? Number(n[1]);
    return { due: n[0], dueDate: addDays(heldAt, count * (n[2].toLowerCase() === "week" ? 7 : 1)) };
  }
  const fixed: [RegExp, number][] = [[/\bin a fortnight\b/i, 14], [/\bnext week\b/i, 7], [/\btomorrow\b/i, 1]];
  for (const [re, days] of fixed) {
    const m = text.match(re);
    if (m) return { due: m[0], dueDate: addDays(heldAt, days) };
  }
  return null;
}

/** The notes fields these rules touch (the shape of `MeetingSchema` in lib/sidekick.ts). */
type Notes = {
  decisions: { text: string; made_by: string | null }[];
  action_items: { text: string; owner: string | null; due: string | null; due_date: string | null }[];
};

/**
 * Applies the rules to Claude's notes for a meeting held on `heldAt`: decisions that are follow-ups become action
 * items (owner: whoever made the "decision", due date from `relativeDue`), and action items with a relative due
 * phrase (or a due field `dueFromPhrase` reads, "Wednesday") but no calendar date get one. Returns new lists; the input is not changed.
 */
export function tidyNotes<T extends Notes>(notes: T, heldAt: string): T {
  const followUps = notes.decisions.filter((d) => isFollowUp(d.text));
  const moved = followUps.map((d) => {
    const when = relativeDue(d.text, heldAt);
    return { text: d.text, owner: d.made_by, due: when?.due ?? null, due_date: when?.dueDate ?? null };
  });
  const actions = notes.action_items.map((a) => {
    if (a.due_date) return a;
    const when = relativeDue(`${a.due ?? ""} ${a.text}`, heldAt);
    if (when) return { ...a, due: a.due ?? when.due, due_date: when.dueDate };
    const day = dueFromPhrase(a.due, heldAt);
    return day ? { ...a, due_date: day } : a;
  });
  return { ...notes, decisions: notes.decisions.filter((d) => !followUps.includes(d)), action_items: [...actions, ...moved] };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The day a due phrase means on its own, counted from the meeting day `heldAt` (YYYY-MM-DD…): a weekday ("Wednesday",
 * "by Wednesday", "this Wednesday", "on Wed") is the next one after the meeting day (a week later when it's the same
 * weekday); "today"/"EOD" is the meeting day; a month and day ("Nov 12", "12 November") is that day in the meeting's
 * year (the next year when that is more than 60 days before the meeting). Anything else, "next Wednesday" included
 * (people mean different weeks by it), is null. Used for the due field only (see the file comment).
 */
export function dueFromPhrase(phrase: string | null | undefined, heldAt: string): string | null {
  const day = heldAt.slice(0, 10);
  const base = Date.parse(`${day}T00:00:00Z`);
  if (!phrase || Number.isNaN(base)) return null;
  const p = phrase.toLowerCase().replace(/[.,!]/g, " ").replace(/\s+/g, " ").trim().replace(/^(?:by|on|before|due|until)\s+/, "");
  if (/^(?:today|tonight|eod|(?:the )?end of (?:the )?day)$/.test(p)) return day;
  const wd = p.match(/^(?:this\s+)?([a-z]{3,})$/);
  const target = wd ? WEEKDAYS.findIndex((w) => w.startsWith(wd[1])) : -1;
  if (target >= 0) {
    const from = new Date(base).getUTCDay();
    return addDays(day, ((target - from + 7) % 7) || 7);
  }
  const md = p.match(/^([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?$/) ?? p.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3})[a-z]*$/);
  if (md) {
    const [mon, dd] = /^\d/.test(md[1]) ? [md[2], Number(md[1])] : [md[1], Number(md[2])];
    const month = MONTHS.indexOf(mon);
    if (month < 0 || dd < 1 || dd > 31) return null;
    let year = new Date(base).getUTCFullYear();
    let at = Date.UTC(year, month, dd);
    if (at < base - 60 * 86400_000) at = Date.UTC(++year, month, dd);
    const d = new Date(at);
    return d.getUTCDate() === dd ? d.toISOString().slice(0, 10) : null;
  }
  return null;
}

/** What Sidekick heard and said in a meeting it was in live (see the file comment). Saved as `meetings.live_context`. */
export type LiveContext = {
  decisions: { text: string; who: string | null }[];
  actions: { text: string; who: string | null; due?: string | null }[];
  /** Sidekick's own answers in the meeting, in order. */
  answers: { question: string; answer: string }[];
};

/** Reads `meetings.live_context` (null when Sidekick wasn't there live, or nothing was kept). */
export function parseLiveContext(json: string | null | undefined): LiveContext | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<LiveContext>;
    const ctx: LiveContext = { decisions: Array.isArray(v.decisions) ? v.decisions : [], actions: Array.isArray(v.actions) ? v.actions : [], answers: Array.isArray(v.answers) ? v.answers : [] };
    return ctx.decisions.length || ctx.actions.length || ctx.answers.length ? ctx : null;
  } catch {
    return null;
  }
}

/**
 * The live context as the notes prompt gets it (after the transcript): the running list with owners and dates, and
 * Sidekick's answers, each marked as Sidekick's. `safe` escapes text for the prompt's tags (lib/security.ts tagSafe).
 * Empty when there is nothing.
 */
export function liveContextBlock(ctx: LiveContext | null, safe: (s: string) => string = (s) => s): string {
  if (!ctx) return "";
  const parts: string[] = [];
  if (ctx.decisions.length || ctx.actions.length) {
    const list = [
      ...ctx.decisions.map((d) => `- Decision: ${d.text}${d.who ? ` (${d.who})` : ""}`),
      ...ctx.actions.map((a) => `- Action item: ${a.text}${a.who ? ` (owner: ${a.who})` : ""}${a.due ? ` (due: ${a.due})` : ""}`),
    ];
    parts.push(`<live_running_list>\n${safe(list.join("\n"))}\n</live_running_list>`);
  }
  if (ctx.answers.length) {
    const said = ctx.answers.map((a) => `- Asked: ${a.question}\n  Sidekick answered: ${a.answer}`);
    parts.push(`<sidekick_answers>\n${safe(said.join("\n"))}\n</sidekick_answers>`);
  }
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

const STOP = new Set(["the", "a", "an", "to", "and", "or", "of", "for", "on", "in", "with", "by", "at", "it", "is", "be", "this", "that", "our", "we", "i", "will", "all"]);
const words = (text: string) => new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));

/** True when two item sentences are about the same thing: most of the shorter one's words are in the other. */
export function sameItem(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size) >= 0.6;
}

/**
 * Carries the live running list onto Claude's notes (see the file comment): a notes action item that matches a list
 * item (`sameItem`) and has no owner or no due gets the list's; list action items no notes item matches are added;
 * a decision with no maker gets the list's. Run before `tidyNotes`, which turns the due phrases into dates. Returns
 * new lists; the input is not changed.
 */
export function mergeLiveList<T extends Notes>(notes: T, ctx: LiveContext | null): T {
  if (!ctx) return notes;
  const used = new Set<number>();
  const actions = notes.action_items.map((a) => {
    const i = ctx.actions.findIndex((l, j) => !used.has(j) && sameItem(a.text, l.text));
    if (i < 0) return a;
    used.add(i);
    const l = ctx.actions[i];
    return { ...a, owner: a.owner ?? l.who ?? null, due: a.due ?? l.due ?? null };
  });
  const added = ctx.actions.filter((_, j) => !used.has(j)).map((l) => ({ text: l.text, owner: l.who ?? null, due: l.due ?? null, due_date: null }));
  const decisions = notes.decisions.map((d) => (d.made_by ? d : { ...d, made_by: ctx.decisions.find((l) => sameItem(d.text, l.text))?.who ?? null }));
  return { ...notes, decisions, action_items: [...actions, ...added] };
}
