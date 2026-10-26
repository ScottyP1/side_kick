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
 *   phrases with one clear meaning are resolved; anything else keeps no date rather than a guessed one.
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
 * phrase but no calendar date get one. Returns new lists; the input is not changed.
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
    return when ? { ...a, due: a.due ?? when.due, due_date: when.dueDate } : a;
  });
  return { ...notes, decisions: notes.decisions.filter((d) => !followUps.includes(d)), action_items: [...actions, ...moved] };
}
