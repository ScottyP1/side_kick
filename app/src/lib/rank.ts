/**
 * @file Answer quality at scale: re-ranking the passages search found before they go to Claude. Pure (no
 * database, no network), so it is unit-tested directly (tests/db.test.mjs) and cheap to run on every question.
 *
 * Concepts
 * - **Candidates**: search (lib/search.ts) returns more passages than an answer needs (about 30), from the group
 *   and the firm library, best first by the search engine's own order (keyword BM25 locally, hybrid keyword +
 *   meaning in Azure). search.ts adds what the database knows about each one's source: its date, whether it
 *   comes from the group or the firm library, a hash of its document's text and whether it's outdated.
 * - **Re-ranking** (`rerank`): each candidate gets a score for how well it fits the *whole* question (how many
 *   of the question's words it contains, rarer words counting more, so a generic word like "client" that most
 *   candidates share can't outweigh the topic word "PCI"; whether it has them next to each other as in the question, and a
 *   share of the engine's own order, which carries meaning-based matches the words alone miss). Then:
 *   - **Freshness**: newer group sources win on the same topic (a meeting from this week beats one from two
 *     months ago, a little). Firm documents don't age this way: a policy is valid until it's superseded.
 *   - **Outdated**: a firm document marked "superseded by" another, or a group document that has a newer
 *     version (same name apart from "v2", "final", a date…) is down-ranked, and the answer prompt flags it.
 *   - **Priority**: for policy and compliance questions ("Can I expense…", "What's the travel policy…") the
 *     firm library ranks higher; for engagement facts the group's own sources do.
 *   - **What someone said** (`isSaidQuestion`): for "what did the client say about X?" the group's meetings,
 *     notes and chats rank higher and the firm library lower; "say", "said", "told"… don't count as topic words.
 *   - **Summaries first**: meeting notes (the summary and decisions Sidekick wrote) rank a little above raw
 *     transcript passages; the transcript is still there for the detail.
 * - **De-duplication** (`dedupe`, inside `rerank`): the same document uploaded twice (same text hash), or a
 *   passage contained in another (a chat reply quoting the message it answers) is kept once: the better
 *   ranked (and, for equal ones, the newer) copy.
 * - **Diversity**: at most `perSource` passages per source, so one long document can't crowd out the rest.
 *
 * Who calls it: `findSources` in lib/search.ts (Ask in the portal and Teams).
 */
import crypto from "node:crypto";

/** Where a passage comes from: the group's own sources, or the organization's firm library. */
export type Origin = "group" | "firm";

/** One passage from search, with what the database knows about its source (see `findSources` in search.ts). */
export type Candidate = {
  rowid: number;
  text: string;
  title: string;
  loc: string;
  source_type: string;
  source_id: string;
  audience: string;
  origin: Origin;
  /** YYYY-MM-DD: document added, meeting held, chat message sent, firm document effective from. */
  date: string | null;
  /** SHA-256 of the whole document's text (documents and firm documents), to spot duplicate uploads. */
  hash?: string | null;
  /** Why it's outdated, shown to Claude and in citations ("superseded by Expense policy v3"), or null. */
  outdated?: string | null;
};

/** A candidate with its final score (higher is better). */
export type Ranked = Candidate & { score: number };

// Words that say nothing about the topic. Kept separate from search.ts's list on purpose: this one also drops
// question words that matter for keyword search's recall but not for judging a passage's fit.
const STOP = new Set(
  "a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with would you your about again also any just more most much not now only other over some such too very done get got let make made need should tell us please".split(" "),
);

// Verbs of speech ("what did the client say about…"): they tell us the answer is in what someone said, not what
// the topic is, so they don't count towards a passage's fit (`isSaidQuestion` uses them instead).
const SPEECH = new Set("say said says saying tell told telling mention mentioned mentions think thought ask asked asking".split(" "));
/** A transcript line inside a passage: `[00:01:33] Tom Becker: …`. */
const SPOKEN = /^\[\d{2}:\d{2}:\d{2}\] [^:\n]{1,80}:/m;

/** The meaningful words of a text: lower case, stop words dropped, a light plural/verb ending removed ("stores" → "store"). */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => w.length > 1 && !STOP.has(w) && !SPEECH.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w));
}

/**
 * True when a question is about firm policy or compliance (expenses, travel, approvals, rate cards, templates,
 * standards, security or data rules) rather than an engagement fact. Decides whether the firm library or the
 * group's own sources rank first. Plain word matching: cheap, predictable, and only a nudge on the ranking.
 */
export function isPolicyQuestion(question: string): boolean {
  return /\b(polic(y|ies)|allowed|allowance|permitted|approv\w*|expens\w*|reimburs\w*|travel|per diem|mileage|complian\w*|standards?|templates?|guidelines?|procedures?|rate cards?|day rates?|billing rates?|code of conduct|gifts?|hospitality|conflicts? of interest|retention|confidential\w*|gdpr|privacy|procurement|methodolog\w*|can i (claim|expense|book|bill)|can we (claim|expense|book|bill)|are we allowed|must we|firm('s)? (rule|policy|standard))\b/i.test(question);
}

/**
 * True when a question asks what someone said in a meeting or chat ("What did the client say about PCI?", "What
 * did Tom mention about the card readers?", "What was said about rollback?"). Then the group's meetings, meeting
 * notes and chats rank higher and the firm library lower: the answer is in what people said, not in a policy.
 */
export function isSaidQuestion(question: string): boolean {
  return /\b(what|how|did|has|have|when)\b[^?]{0,60}\b(say|said|says|tell|told|mention(ed)?|think|thought|ask(ed)?|raise[ds]?|propose[ds]?|suggest(ed)?|agree[ds]?|object(ed)?|complain(ed)?|want(ed)?)\b/i.test(question)
    || /\bwhat was (said|discussed|agreed)\b/i.test(question);
}

/**
 * A document's name without version markers, so versions of one document share a key: "Wave 2 cutover runbook
 * v0.3.md" and "Wave 2 cutover runbook v0.4 FINAL.docx" are both "wave 2 cutover runbook". Used to flag the
 * older one as outdated.
 */
export function versionKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, "")
    .replace(/\b(v|ver|version|rev|revision)\s*\.?\s*\d+(\.\d+)*\b/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\((\d+|copy)\)/g, " ")
    .replace(/\b(final|draft|latest|updated|copy|new|old)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** SHA-256 of a document's text with whitespace evened out, so a re-saved copy of the same text matches. */
export const contentHash = (text: string) => crypto.createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");

/** Whole days between a YYYY-MM-DD date and `today` (0 when unknown or in the future). */
function ageDays(date: string | null, today: Date): number {
  if (!date) return 0;
  const t = Date.parse(date.slice(0, 10));
  return Number.isNaN(t) ? 0 : Math.max(0, (today.getTime() - t) / 86400_000);
}

/** Four-word windows of a text, for spotting a passage contained in another. */
function shingles(text: string): Set<string> {
  const w = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  if (w.length < 4) return new Set([w.join(" ")]);
  const out = new Set<string>();
  for (let i = 0; i + 4 <= w.length; i++) out.add(w.slice(i, i + 4).join(" "));
  return out;
}

/** Share of `a`'s windows that also appear in `b`. */
function containedIn(a: Set<string>, b: Set<string>): number {
  if (!a.size) return 0;
  let n = 0;
  for (const s of a) if (b.has(s)) n++;
  return n / a.size;
}

/**
 * Drops duplicates from a list that is already best first: a passage from another source with the same document
 * hash (the same file uploaded twice), or one whose text is mostly (80%+) contained in a passage already kept,
 * or that mostly contains one (a chat reply quoting the message it answers). The first (better ranked) copy stays.
 */
export function dedupe<T extends Candidate>(list: T[]): T[] {
  const kept: { c: T; sh: Set<string> }[] = [];
  const hashOwner = new Map<string, string>();
  for (const c of list) {
    if (c.hash) {
      const owner = hashOwner.get(c.hash);
      if (owner && owner !== c.source_id) continue;
      hashOwner.set(c.hash, c.source_id);
    }
    const sh = shingles(c.text);
    if (kept.some((k) => k.c.source_id !== c.source_id && (containedIn(sh, k.sh) >= 0.8 || containedIn(k.sh, sh) >= 0.8))) continue;
    kept.push({ c, sh });
  }
  return kept.map((k) => k.c);
}

/**
 * Re-ranks search candidates for one question (see the file comment), removes duplicates, keeps at most
 * `perSource` passages per source and returns the best `limit`, best first, each with its score.
 *
 * @param candidates in the search engine's order, best first
 * @param opts.limit     how many to keep (default 10)
 * @param opts.perSource most passages from one source (default 3)
 * @param opts.today     "now" for freshness (tests pass a fixed date)
 */
export function rerank(question: string, candidates: Candidate[], opts: { limit?: number; perSource?: number; today?: Date } = {}): Ranked[] {
  const limit = opts.limit ?? 10;
  const perSource = opts.perSource ?? 3;
  const today = opts.today ?? new Date();
  const qt = terms(question);
  const q = [...new Set(qt)];
  // Word pairs as they stand in the question ("cutover date"), to reward passages that keep them together.
  const pairs = qt.slice(1).map((w, i) => `${qt[i]} ${w}`);
  const policy = isPolicyQuestion(question);
  const said = isSaidQuestion(question);
  const bags = candidates.map((c) => terms(`${c.title} ${c.text}`));
  // Rarer question words count more: "pci" (in a few candidates) outweighs "client" (in most of them).
  const weight = new Map(q.map((w) => [w, Math.log(1 + candidates.length / (1 + bags.filter((b) => b.includes(w)).length))]));
  const total = q.reduce((n, w) => n + weight.get(w)!, 0);
  const scored: Ranked[] = candidates.map((c, i) => {
    const words = bags[i];
    const bag = new Set(words);
    const coverage = total ? q.filter((w) => bag.has(w)).reduce((n, w) => n + weight.get(w)!, 0) / total : 0;
    const seq = new Set(words.slice(1).map((w, j) => `${words[j]} ${w}`));
    const phrase = pairs.length ? pairs.filter((p) => seq.has(p)).length / pairs.length : 0;
    const prior = 1 / (1 + i / 5);
    let score = 0.5 * coverage + 0.2 * phrase + 0.3 * prior;
    // Freshness (group sources only): from x1.1 for today down towards x0.9, halving the bonus every 45 days.
    if (c.origin === "group" && c.date) score *= 0.9 + 0.2 * Math.pow(0.5, ageDays(c.date, today) / 45);
    if (c.outdated) score *= 0.55;
    if (policy) score *= c.origin === "firm" ? 1.25 : 1;
    else score *= c.origin === "firm" ? (said ? 0.7 : 0.85) : 1;
    // People speaking: meetings, their notes, chats, and transcripts uploaded as documents ("[00:01:33] Tom: …").
    if (said && (["meeting", "notes", "chat"].includes(c.source_type) || SPOKEN.test(c.text))) score *= 1.2;
    if (c.source_type === "notes") score *= 1.15;
    return { ...c, score: Math.round(score * 10000) / 10000 };
  });
  // Equal scores: the newer source first (so of two identical uploads the newer one stays).
  scored.sort((a, b) => b.score - a.score || (b.date ?? "").localeCompare(a.date ?? ""));
  const perCount = new Map<string, number>();
  const out: Ranked[] = [];
  for (const c of dedupe(scored)) {
    const n = perCount.get(c.source_id) ?? 0;
    if (n >= perSource) continue;
    perCount.set(c.source_id, n + 1);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}
