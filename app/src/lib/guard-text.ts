/**
 * @file The quick guardrail text checks: plain functions with no I/O and no AI, so they can be unit-tested
 * (tests/db.test.mjs) and run before any paid Claude check. `guardrails.ts` uses and re-exports them.
 *
 * Concepts
 * - **Question check** (`localQuestionCheck`): slurs, known jailbreak phrases and, when that switch is on,
 *   strong swearing. Look-alike characters ("sh1t") and spelled-out words ("f u c k") are undone first.
 * - **Rule checks** (`localRuleCheck`, `broadRuleCheck`): a proposed custom rule is refused when it would
 *   loosen the guardrails ("ignore the rules", "you may swear") or when it is so broad it would refuse
 *   every ordinary work question ("Don't answer any questions"). Claude checks the rest at save time.
 * - **Answer masking** (`maskSwearing`, `maskContacts`): swear words become f***; emails and phone numbers
 *   become "[email hidden]" / "[phone hidden]". Dates and times ("[2026-10-07 15:40]") are not phone numbers.
 * - **Source tags** (`tidyCitations`): an answer's [S#] tags only point at sources it really cites, once each.
 * - **Personal data masking** (`maskPersonalData`): what a website visitor types to the help bot is masked
 *   before it's stored (contact details, plus long digit runs such as card or account numbers).
 */
import type { BuiltinRuleId, GuardSettings } from "./guardrails";
import { BRAND } from "./brand";

// Ways of trying to switch the guardrails off through a rule ("ignore the rules", "turn off the filter").
const LOOSEN_RULES = /\b(ignore|disregard|forget|override|bypass|skip|disable|turn off|switch off|relax|loosen|lift|suspend|remove|drop)\b.{0,25}\b(rules?|guardrails?|restrictions?|filters?|floor|limits?|checks?|instructions?|policy|policies|safety)\b/i;
const NO_RULES = /\b(no|without)\s+(any\s+)?(rules|restrictions|limits|filters?|guardrails)\b|\b(unrestricted|unfiltered|uncensored)\b/i;
// Permission to do something the floor or the switches forbid ("you may swear", "it's fine to guess").
const PERMIT = /\b(may|can|could|allowed to|free to|ok to|okay to|fine to|permitted to|welcome to|no longer need to|don'?t need to|doesn'?t need to|do not need to|does not need to|need not|go ahead and)\b/i;
const PERMIT_TARGET = /\b(swear\w*|curs\w*|profan\w*|slurs?|insult\w*|explicit|sexual|guess\w*|speculat\w*|make (things )?up|invent\w*|other (clients?|workspaces?|organi[sz]ations?|orgs?)|system prompt|instructions|rules|cite|sources?|judg\w*|rank\w*|rate people|jokes?|small talk|chit-?chat|competitors?|emails?|phone|contact)\b/i;

const LOCAL_REASONS = {
  loosen: `This would loosen ${BRAND.name}'s guardrails: it tries to switch off or get around them. Custom rules can only add restrictions; the locked rules and the organization switches can't be relaxed here.`,
  permit: `This would loosen ${BRAND.name}'s guardrails: it gives ${BRAND.name} permission to do something they forbid. Custom rules can only add restrictions, e.g. “Never quote day rates”.`,
  hate: `This rule contains language ${BRAND.name} never uses. Rewrite it without it.`,
};

/** Quick local check of a proposed rule (no AI). Returns the reason it's refused, or null. */
export function localRuleCheck(text: string): string | null {
  if (hasSlur(text)) return LOCAL_REASONS.hate;
  if (JAILBREAK.some((r) => r.test(text)) || LOOSEN_RULES.test(text) || NO_RULES.test(text)) return LOCAL_REASONS.loosen;
  for (const clause of text.split(/[.;,]|\b(?:and|but)\b/i)) {
    const m = PERMIT.exec(clause);
    // "you may only…", "can never…", "can't…" are restrictions, not permissions.
    if (m && !/^\s*(only|not|never|no longer)\b/i.test(clause.slice(m.index + m[0].length)) && PERMIT_TARGET.test(clause.slice(m.index))) return LOCAL_REASONS.permit;
  }
  return null;
}

// Look-alike characters people use to slip words past filters ("sh1t", "f@ck").
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

/**
 * Lower-cases, removes invisible characters, undoes look-alike characters, shortens stretched letters
 * ("fuuuck") and joins letters spelled out with dots or spaces ("f.u.c.k"), then splits into words.
 */
function words(text: string): string[] {
  const t = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ​-‏⁠﻿]/g, "")
    .replace(/[013457@$!]/g, (c) => LEET[c] ?? c)
    .replace(/([a-z])\1{2,}/g, "$1");
  const out = t.split(/[^a-z]+/).filter(Boolean);
  // Spelled-out words: runs of single letters ("f u c k") are also tried joined together.
  const joined: string[] = [];
  let run = "";
  for (const w of out) {
    if (w.length === 1) run += w;
    else {
      if (run.length > 2) joined.push(run);
      run = "";
    }
  }
  if (run.length > 2) joined.push(run);
  return [...out, ...joined];
}

// Strong swearing. A word matches if it is the stem, or the stem plus an ordinary ending (fucking, shits).
// Kept to unambiguous words so normal business language ("assess", "Scunthorpe", "cockpit") is never hit.
const SWEAR_ANY_ENDING = ["fuck", "motherfuck", "cunt", "shit", "bullshit"];
const SWEAR_STEMS = ["bitch", "asshole", "arsehole", "bastard", "wanker", "twat", "dickhead", "piss", "slut", "whore", "douchebag", "jackass", "dumbass"];
const ENDINGS = /^(s|es|ed|er|ers|ing|in|y|ty|head|heads|face)?$/;

// Slurs: always refused (part of the locked floor). A short list of unambiguous ones; the Claude check
// catches the rest, including hateful questions written without any slur.
const SLURS = ["nigger", "nigga", "faggot", "kike", "spic", "chink", "tranny", "wetback", "raghead", "towelhead", "gook", "retard"];

const matches = (w: string, stems: string[], anyEnding: boolean) =>
  stems.some((s) => w.startsWith(s) && (anyEnding || ENDINGS.test(w.slice(s.length))));
const isSwear = (w: string) => matches(w, SWEAR_ANY_ENDING, true) || matches(w, SWEAR_STEMS, false);
const isSlur = (w: string) => matches(w, SLURS, false);

// Known ways of trying to talk an AI out of its rules. Checked on the raw text (case-insensitive).
const JAILBREAK = [
  // "Ignore your/previous/all instructions", not "should we ignore the old firewall rules?".
  /\b(ignore|disregard|forget|override|bypass)\b.{0,20}\b(your|previous|prior|above|earlier|all|any|these|those|system)\b.{0,15}\b(instructions?|rules?|guidelines?|guardrails?|prompt|restrictions?|programming)\b/i,
  /\b(reveal|show|print|repeat|leak)\b.{0,30}\b(system prompt|your (instructions|prompt|rules))\b/i,
  /\bsystem prompt\b/i,
  /\b(developer|god|admin|debug|unrestricted|jailbreak|dan)\s+mode\b/i,
  /\b(you are now|from now on you are|act as|pretend (to be|you are)|roleplay as)\b.{0,40}\b(unfiltered|uncensored|unrestricted|no rules|without (any )?(rules|limits|restrictions)|evil|dan)\b/i,
  /\bpretend\b.{0,30}\b(no|without)\b.{0,10}\b(rules|restrictions|limits|guardrails)\b/i,
  /\bjailbreak\b/i,
  /<\/?(system|assistant|instructions?)>/i,
];

/** Quick local check of a question. Returns the rule it breaks, or null. */
export function localQuestionCheck(text: string, settings: GuardSettings): BuiltinRuleId | null {
  const ws = words(text);
  if (ws.some(isSlur)) return "hate";
  if (JAILBREAK.some((r) => r.test(text))) return "jailbreak";
  if (settings.profanity && ws.some(isSwear)) return "profanity";
  return null;
}

/** True if the text contains a slur (used on answers: the whole answer is replaced). */
export function hasSlur(text: string) {
  return words(text).some(isSlur);
}

/** Masks strong swear words as f*** (first letter kept), leaving the rest of the text as it was. */
export function maskSwearing(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(/[\p{L}\p{N}@$!*.]+/gu, (token) => {
    if (words(token).some(isSwear)) {
      count++;
      return token[0] + "*".repeat(Math.max(3, token.length - 1));
    }
    return token;
  });
  return { text: out, count };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone numbers: optional +country code, then 9+ digits with spaces, dots, dashes or brackets between.
const PHONE = /(?<![\w.])\+?\d[\d ().-]{7,}\d(?![\w])/g;

/** True for dates and times that the phone pattern would otherwise catch ("2026-10-07 15" before ":40"). */
function looksLikeDateTime(m: string, next: string | undefined) {
  return /\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/.test(m) || /\b\d{1,2}[-./]\d{1,2}[-./]\d{4}\b/.test(m) || next === ":";
}

/** Hides email addresses and phone numbers. Dates and plain numbers (like "48 stores") are left alone. */
export function maskContacts(text: string): { text: string; count: number } {
  let count = 0;
  const out = text
    .replace(EMAIL, () => (count++, "[email hidden]"))
    .replace(PHONE, (m, at: number, all: string) => (m.replace(/\D/g, "").length >= 9 && !looksLikeDateTime(m, all[at + m.length]) ? (count++, "[phone hidden]") : m));
  return { text: out, count };
}

// Rules that would refuse every ordinary work question: "Don't answer any questions", "Refuse everything",
// "Never discuss the project". A rule about one topic ("Don't answer questions about rates") is fine.
const REFUSE_VERB = String.raw`(?:(?:you\s+)?(?:don'?t|do\s+not|never|must\s+not|should\s+not|shouldn'?t|cannot|can'?t|won'?t|will\s+not|no\s+longer|stop)\s+(?:answer(?:ing)?|respond(?:ing)?\s+to|reply(?:ing)?\s+to|help(?:ing)?(?:\s+with)?|discuss(?:ing)?|talk(?:ing)?\s+about|share)|(?:refuse|decline|block|ignore)(?:\s+to\s+(?:answer|respond\s+to|help\s+with))?)`;
const CATCH_ALL = String.raw`(?:(?:any|all|every|each)\s+(?:single\s+)?)?(?:questions?|requests?|messages?|queries|anything|everything|anyone|anybody|the\s+(?:project|work|client|engagement|workspace)|this\s+(?:project|workspace|engagement)|work(?:\s+questions?)?)`;
const TOO_BROAD = new RegExp(String.raw`^\s*(?:please\s+)?(?:sidekick\s*[:,]?\s*)?(?:${REFUSE_VERB})\s+(?:to\s+)?${CATCH_ALL}(?:\s+(?:at\s+all|whatsoever|from\s+anyone|here|in\s+this\s+workspace|asked))*\s*[.!]*\s*$`, "i");
const TOO_BROAD_SHORT = /^\s*(?:answer|say|share)\s+nothing\s*[.!]*\s*$|^\s*(?:no|zero)\s+(?:answers|questions)\s*[.!]*\s*$/i;

/** Why a rule that blocks (nearly) every question is refused at save time. Shared with the Claude check. */
export const TOO_BROAD_REASON =
  `This rule is too broad: it would refuse every ordinary work question in the workspace. Name the topic to avoid instead, e.g. “Never quote day rates”. To stop ${BRAND.name} answering altogether, ask the ${BRAND.name} team to pause it.`;

/**
 * Quick local check for a proposed custom rule that would block all or most work questions. Returns the
 * reason it's refused, or null. Claude's save-time check catches broader wordings this misses.
 */
export function broadRuleCheck(text: string): string | null {
  return TOO_BROAD.test(text) || TOO_BROAD_SHORT.test(text) ? TOO_BROAD_REASON : null;
}

/**
 * Masks personal data in text a website visitor typed, before it's stored (help bot conversations and the
 * list of unanswered questions): emails, phone numbers, and runs of 12-19 digits such as card or account
 * numbers ("[number hidden]"). Returns the masked text and how many things were hidden.
 */
export function maskPersonalData(text: string): { text: string; count: number } {
  const c = maskContacts(text);
  let count = c.count;
  const out = c.text
    .replace(/\b(?:\d[ -]?){12,19}\b/g, () => (count++, "[number hidden]"))
    // Stricter than answers: any other 9+ digit number is hidden too, even before a ":" (only real dates stay).
    .replace(/(?<![\w.])\+?\d[\d ().-]{7,}\d(?![\w])/g, (m) => (m.replace(/\D/g, "").length >= 9 && !/\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/.test(m) ? (count++, "[number hidden]") : m));
  return { text: out, count };
}

/**
 * Tidies an answer's source tags against the sources it really cites (Ask, portal and Teams, after the grounding
 * check): tags for sources that aren't in the list ("I don't know [S1]" when nothing is cited) are removed, two
 * passages of the same source are merged into one entry (the first; its location lists both, "00:01:33, 00:04:10")
 * with their tags rewritten to it, and repeated tags ("[S1] [S1]", "[S1, S1]") are collapsed. Grouped tags
 * ("[S1, S3]") are kept as a group. Pure; called by `ask` in lib/sidekick.ts.
 */
export function tidyCitations<T extends { id: string; sourceId: string; loc: string }>(answer: string, sources: T[]): { answer: string; sources: T[] } {
  const keep: T[] = [];
  const alias = new Map<string, string>();
  for (const s of sources) {
    const first = keep.find((k) => k.sourceId === s.sourceId);
    if (!first) {
      keep.push({ ...s });
      alias.set(s.id, s.id);
      continue;
    }
    alias.set(s.id, first.id);
    if (s.loc && !first.loc.split(", ").includes(s.loc)) first.loc = first.loc ? `${first.loc}, ${s.loc}` : s.loc;
  }
  let text = answer.replace(/\s*\[(S\d+(?:\s*,\s*S\d+)*)\]/g, (m, ids: string) => {
    const mapped = [...new Set(ids.split(/\s*,\s*/).map((id) => alias.get(id)).filter(Boolean))];
    return mapped.length ? `${m.match(/^\s*/)![0]}[${mapped.join(", ")}]` : "";
  });
  // The same tag twice in a row (after merging) becomes one.
  text = text.replace(/(\[S\d+(?:, S\d+)*\])(\s*\1)+/g, "$1");
  return { answer: text.trim(), sources: keep };
}
