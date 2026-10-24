/**
 * @file The only place Sidekick talks to Claude (Anthropic's AI model).
 *
 * Concepts
 * - **Feature**: each kind of AI work has a name (`ask`, `extract`, `insights`, `assist`, `guard`, `remind`, `support`,
 *   `helpbot`, `followup`, `watch`) so it can use its own
 *   model, be metered separately on the Usage page, and be paused with a kill switch in the Owner Console.
 * - **Structured output**: instead of free text, Claude must reply with JSON matching a Zod schema, so the
 *   app can save answers, decisions and action items without guessing at their shape.
 * - **Tokens and cost**: Claude bills per token (roughly ¾ of a word). Every call is logged to
 *   `usage_events` with tokens, USD cost, latency and any error, whether it succeeded or not.
 * - **Prompt caching**: repeated instructions are cached by Anthropic, so follow-up calls cost less.
 * - **Server-side fallback**: if a model declines a request on policy grounds, Anthropic retries it on
 *   their recommended fallback model automatically.
 * - **AI credit** (lib/credit.ts): before each call, the organization's monthly AI credit is checked. From
 *   100% ("essentials only") answers and guardrail checks run on cheaper models and the extras pause. A
 *   call can opt out with `skipCredit` (work Sidekick pays for itself, like the coming support assistant).
 * - **Busy API**: rate limits (429), "overloaded" (529) and server hiccups are retried with exponential
 *   backoff and jitter (`withRetry`, honouring Retry-After); if Claude stays busy the person gets a plain
 *   "very busy, try again in a minute" (`AiBusyError`), never a raw API error.
 * - **Prompt caching**: the system prompt (instructions + the organization's guardrail rules, stable between
 *   calls) carries a cache breakpoint, so repeats read it from Anthropic's cache at a tenth of the price.
 *   The per-call content (sources, the question, a transcript) is never marked: it doesn't repeat, and a
 *   cache write costs 1.25x. Prompts shorter than the model's minimum cacheable length (about 1-4k tokens)
 *   simply aren't cached. Cache reads are recorded per call (`usage_events.cache_read_tokens`) and shown
 *   per client and model in the Owner Console.
 * - **Fair turns between companies** (`AI_LIMITS`, lib/fair-limiter.ts): live calls take a turn first. At most
 *   `SIDEKICK_CLAUDE_CONCURRENCY` calls run at once per app copy (default 24) and at most
 *   `SIDEKICK_CLAUDE_ORG_CONCURRENCY` for one organization (default 6); when calls have to wait, turns go round the
 *   waiting organizations in turn, and calls a person waits on go before background ones (the watchers' checks and
 *   reminder wording). So one company asking hundreds of questions at once can't use up the API's rate limit for
 *   everyone. A call that waits over `SIDEKICK_CLAUDE_WAIT_MS` (default 45 s) gets the "very busy" message. The
 *   wait is recorded on the step (`queued_ms`). Details and numbers: docs/SCALE.md.
 * - **Batch API** for work nobody waits for (`queueStructured` + `runBatches`): daily reminder digests are
 *   sent as one Message Batch per timer tick and collected on a later tick, at half the price. Anything a
 *   person is waiting for (answers, notes, the knowledge map button, the assistant) stays a live call.
 *   `SIDEKICK_BATCH=off` turns batching off (everything live).
 * - **Models**: one per feature in `MODELS`, each overridable by env. Don't switch a feature's model
 *   without measuring answer quality first; Claude Haiku 5.5 is the candidate for cheap, simple jobs
 *   (guardrail check, reminder wording).
 * - **Plumbing stays here**: customers see plain wording ("AI answers"); model names and providers are
 *   shown only in the Owner Console.
 *
 * The key comes from `ANTHROPIC_API_KEY` in app/.env.local. A second route (Claude in Sidekick's own Azure
 * AI Foundry) would go in `aiClient()` only, without changing callers.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { HttpError } from "./auth";
import { all, newId, now, run } from "./db";
import { assertEnabled } from "./owner";
import { span, spanAttrs, traceUserId } from "./trace";
import { addSpend, creditGate } from "./credit";
import { BRAND } from "./brand";
import { FairLimiter, LimiterBusyError } from "./fair-limiter";

// One place to choose models. Defaults to Claude Opus 5.5 everywhere; override per feature in .env.local
// (e.g. SIDEKICK_MODEL_ASK=claude-sonnet-5-5) to trade quality for cost. In step 2 this client is swapped
// for AnthropicFoundry (Claude hosted on Azure) with no other code changes.
export const MODELS = {
  extract: process.env.SIDEKICK_MODEL_EXTRACT || process.env.SIDEKICK_MODEL || "claude-opus-5-5",
  ask: process.env.SIDEKICK_MODEL_ASK || process.env.SIDEKICK_MODEL || "claude-opus-5-5",
  insights: process.env.SIDEKICK_MODEL_INSIGHTS || process.env.SIDEKICK_MODEL || "claude-opus-5-5",
  assist: process.env.SIDEKICK_MODEL_ASSIST || process.env.SIDEKICK_MODEL || "claude-opus-5-5",
  // The guardrail check on every question (see guardrails.ts). A short yes/no judgement, so a smaller
  // model (SIDEKICK_MODEL_GUARD=claude-haiku-5-5) is a good way to cut its cost.
  guard: process.env.SIDEKICK_MODEL_GUARD || process.env.SIDEKICK_MODEL || "claude-opus-5-5",
  // Proactive reminders in Teams (see reminders.ts): rewords a short list of items picked in code, so a
  // smaller model (SIDEKICK_MODEL_REMIND=claude-sonnet-5-5) works well here too.
  remind: process.env.SIDEKICK_MODEL_REMIND || process.env.SIDEKICK_MODEL || "claude-opus-5-5",
  // The signed-in support assistant (lib/support-assistant.ts) and drafting support articles from resolved
  // tickets (lib/support-articles.ts). Paid by Sidekick, never the customer's AI credit (`payer`).
  support: process.env.SIDEKICK_MODEL_SUPPORT || process.env.SIDEKICK_MODEL || "claude-opus-5-5",
  // The public "Ask about Sidekick" help bot (lib/helpbot.ts): short answers from public help articles, so it
  // defaults to the cheapest model; check it holds quality with scripts/helpbot-check.mjs before and after a
  // change, and move up to claude-sonnet-5-5 (SIDEKICK_MODEL_HELPBOT) if it doesn't.
  helpbot: process.env.SIDEKICK_MODEL_HELPBOT || "claude-haiku-5-5",
  // Rewrites a follow-up ("and wave 3?") into a full question before searching (lib/conversations.ts).
  // A short rewording job, so the cheapest model by default.
  followup: process.env.SIDEKICK_MODEL_FOLLOWUP || "claude-haiku-5-5",
  // Watchers (lib/watchers.ts): only called when a cheap check already found a likely problem, e.g. "does this
  // newer decision change what this document says?". A short judgement, so a mid-size model by default.
  watch: process.env.SIDEKICK_MODEL_WATCH || process.env.SIDEKICK_MODEL || "claude-sonnet-5-5",
};
export type Feature = keyof typeof MODELS;

// USD per million tokens (Claude API list prices). Used for the Usage page. Cache writes cost 1.25x input.
const PRICES: Record<string, { in: number; out: number; cacheRead: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
};

/**
 * Test mode: SIDEKICK_FAKE_CLAUDE=1 makes every call return a small canned answer instead of calling
 * Claude, so the automated tests are free, fast and predictable. It can never switch on in production.
 */
export const FAKE_CLAUDE = process.env.SIDEKICK_FAKE_CLAUDE === "1" && process.env.NODE_ENV !== "production";
/** Test mode only: how long a fake call takes on average (SIDEKICK_FAKE_CLAUDE_MS, default 0 = instant). */
const FAKE_LATENCY_MS = FAKE_CLAUDE ? Math.max(0, Number(process.env.SIDEKICK_FAKE_CLAUDE_MS || 0)) : 0;
/**
 * Test mode only: how many fake calls may be in flight at once before more are refused as "rate limited", like the
 * real account's limit shared by every customer (SIDEKICK_FAKE_CLAUDE_CAPACITY, default 0 = unlimited). The load
 * test uses it to show whether one company can crowd out the others.
 */
const FAKE_CAPACITY = FAKE_CLAUDE ? Math.max(0, Number(process.env.SIDEKICK_FAKE_CLAUDE_CAPACITY || 0)) : 0;
let fakeInFlight = 0;

/**
 * Canned, schema-shaped outputs for test mode. A content containing "__FAIL__" makes the call fail, so
 * tests can check that failures are reported (e.g. a meeting marked Failed with a reason).
 * "__SPEND_<dollars>__" in the content records that cost for the call, so tests can drive the AI credit.
 * "__BUSY_<n>__" makes the first n attempts fail as "overloaded", to test retries and the busy message.
 * The recorded model is "fake-claude", or "fake-claude:<model>" when the call didn't use the feature's
 * normal model (essentials mode).
 */
async function fakeClaude(feature: Feature, ctx: Ctx, content: string, model: string, attempt = 0): Promise<unknown> {
  // "__BUSY_<n>__": the first n attempts fail like an overloaded API (529), so tests can check the retries.
  if (attempt < Number(content.match(/__BUSY_(\d+)__/)?.[1] ?? 0)) throw new FakeBusyError();
  // For the load test (scripts/load-test.mjs): SIDEKICK_FAKE_CLAUDE_CAPACITY refuses calls beyond that many at once
  // as "rate limited", and SIDEKICK_FAKE_CLAUDE_MS answers after about that long (±50%), like the real API, so
  // calls overlap and the per-organization turns in `structured` matter.
  if (FAKE_CAPACITY > 0 && fakeInFlight >= FAKE_CAPACITY) throw new FakeBusyError();
  fakeInFlight++;
  try {
    if (FAKE_LATENCY_MS > 0) await new Promise((r) => setTimeout(r, FAKE_LATENCY_MS * (0.5 + Math.random())));
  } finally {
    fakeInFlight--;
  }
  const cost = Number(content.match(/__SPEND_(\d+(?:\.\d+)?)__/)?.[1] ?? 0);
  await run(
    `INSERT INTO usage_events (org_id, workspace_id, user_id, feature, model, input_tokens, output_tokens, cost_usd, latency_ms, ok, error, payer, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?)`,
    ctx.orgId, ctx.workspaceId, traceUserId(), feature, model === MODELS[feature] ? "fake-claude" : `fake-claude:${model}`, cost,
    content.includes("__FAIL__") ? 0 : 1, content.includes("__FAIL__") ? "Fake failure" : null, ctx.payer ?? null, now(),
  );
  if (!ctx.payer) addSpend(ctx.orgId, cost);
  if (content.includes("__FAIL__")) throw new HttpError(502, "Claude API error (test): fake failure for testing.");
  if (feature === "guard") return fakeGuard(content);
  if (feature === "followup") return fakeFollowUp(content);
  if (feature === "helpbot" || feature === "support") return fakeSupport(feature, content);
  if (feature === "watch") {
    // Stale-document check: the decision "changes" the document when it says so in so many words
    // (instead, moved, changed, no longer, replaced, postponed, switched to).
    const decision = content.match(/<decision[^>]*>([\s\S]*?)<\/decision>/)?.[1] ?? "";
    const contradicts = /\b(instead|moved|changed|no longer|replaced?|replaces|postponed|switch(?:ed)? to)\b/i.test(decision);
    return { contradicts, reason: contradicts ? "The decision changes what the document says." : "They agree." };
  }
  if (feature === "remind") {
    // One point per item it was given, plus one pointing at an item that doesn't exist ("R99"), so tests
    // can check that points without a real source are dropped. "__CONTACT__" in an item adds an email.
    const ids = [...content.matchAll(/<item id="(R\d+)"[^>]*>([\s\S]*?)<\/item>/g)];
    return {
      intro: "A few things still need the team's attention.",
      points: [
        ...ids.map(([, id, body]) => ({ item_id: id, text: `Reminder: ${body.split("\n")[0].slice(0, 120)}${body.includes("__CONTACT__") ? " Ask maria.chen@contoso.example." : ""}` })),
        { item_id: "R99", text: "Made-up point with no source." },
      ],
    };
  }
  if (feature === "ask") {
    const question = content.slice(content.lastIndexOf("Question:"));
    // Test markers: an answer that claims to be found but cites nothing (grounding check), one with
    // contact details, and one with swearing (answer clean-up).
    // "__CONFLICT__" says two sources disagree. Answers cite the first two sources (the best ranked), so tests can
    // check ranking, filters and walls through what's cited.
    const conflict = question.includes("__CONFLICT__");
    if (question.includes("__UNGROUNDED__")) return { found: true, answer: "The cutover is definitely on Friday.", source_ids: ["S99"], conflict };
    if (question.includes("__CONTACT__")) return { found: true, answer: "Ask Maria at maria.chen@contoso.example or +1 (555) 010-2233 about the 48 stores [S1].", source_ids: ["S1"], conflict };
    if (question.includes("__SWEAR__")) return { found: true, answer: "The old runbook was shit, use the new one [S1].", source_ids: ["S1"], conflict };
    const ids = [...content.matchAll(/<source id="(S\d+)"/g)].map((m) => m[1]);
    return { found: ids.length > 0, answer: ids.length ? `Test answer from ${ids.join(", ")} [S1].` : "Not in the sources.", source_ids: ids.slice(0, 2), conflict };
  }
  if (feature === "extract") {
    return {
      summary: "Test summary of the meeting.",
      decisions: [{ text: "Test decision", made_by: "Priya Raman" }],
      // The report's due date is long past, so reminder tests always have an overdue item.
      action_items: [{ text: "Send the test report", owner: "Maria Chen", due: "Oct 21", due_date: "2020-10-21" }, { text: "Book the load test", owner: null, due: null, due_date: null }],
      open_questions: [{ text: "Who owns rollback?", answered: false, due_date: "2020-10-23" }],
      pending_decisions: [{ text: "Pick the cutover weekend", due_date: "2020-10-25" }],
      facts: [{ kind: "risk", text: "Test risk" }],
    };
  }
  if (feature === "assist") {
    // Understands a few test phrases: "create workspace <name>", "add <name> <email>", "which workspaces"
    // (lists the workspace names it was given), and two that act like a model breaking its rules: anything
    // about a new organization proposes a made-up "create_org" action, and "refresh map <id>" uses that id
    // as given. checkAction must drop both when they aren't allowed. Anything else gets a plain reply.
    const msg = content.match(/<message>([\s\S]*)<\/message>/)?.[1].trim() ?? "";
    const blank = { name: null, code: null, email: null, role: null, workspace_ids: [], guests: null, page: null };
    if (/\b(new|create|add|start)\b.*\b(organi[sz]ation|org)\b/i.test(msg)) return { reply: "Creating organization.", action: { ...blank, type: "create_org", name: "Rogue Org" } };
    const refresh = msg.match(/^refresh map (\S+)$/i);
    if (refresh) return { reply: "Here's what I'll do: refresh that map.", action: { ...blank, type: "refresh_map", workspace_ids: [refresh[1]] } };
    if (/^which workspaces/i.test(msg)) {
      const ctxJson = content.match(/<context>([\s\S]*?)<\/context>/)?.[1] ?? "{}";
      const names = (JSON.parse(ctxJson).workspaces ?? []).map((w: { name: string }) => w.name);
      return { reply: `Your workspaces: ${names.join(", ") || "none"}.`, action: null };
    }
    const ws = msg.match(/^create (?:a )?workspace (?:called |named )?(.+)$/i);
    if (ws) return { reply: `Here's what I'll do: create “${ws[1]}”. Press Confirm.`, action: { type: "create_workspace", name: ws[1], code: null, email: null, role: null, workspace_ids: [], guests: null, page: null } };
    // "add <name> <email> [as <role>] [to <workspace id>]"
    const person = msg.match(/^add (.+?) (\S+@\S+)(?: as (Org Admin|Team Lead|Billing Admin|Member|Viewer))?(?: to (\S+))?$/i);
    if (person) return { reply: `Here's what I'll do: add ${person[1]}. Press Confirm.`, action: { type: "add_person", name: person[1], code: null, email: person[2], role: person[3] ?? "Member", workspace_ids: person[4] ? [person[4]] : [], guests: null, page: null } };
    return { reply: "Test assistant reply.", action: null };
  }
  // Knowledge map: one "Out of date" gap citing the first document and the newest meeting or chat in the
  // inventory, and one "Conflicting information" gap citing a source that doesn't exist (reminders must drop it).
  const doc = content.match(/^- "([^"]+)" \(added/m)?.[1];
  const later = content.match(/^## "([^"]+)"/m)?.[1];
  const gaps = doc && later
    ? [
        { kind: "Out of date", text: `"${doc}" is older than what was said in "${later}".`, suggestion: "Update the document.", topic: "Test topic", sources: [doc, later] },
        { kind: "Conflicting information", text: "Two sources disagree about the go-live date.", suggestion: "Confirm the date.", topic: "Test topic", sources: ["Ghost document.pdf"] },
      ]
    : [];
  return { topics: [{ name: "Test topic", summary: "About the test", coverage: 150, key_facts: [], document_titles: [], meeting_titles: [] }], gaps };
}

// Common words skipped when the fake guard matches a question against a custom rule.
const RULE_FILLER = new Set(["never", "don't", "dont", "avoid", "discuss", "mention", "quote", "share", "about", "should", "always", "anything", "questions", "answer", "sidekick"]);

/**
 * Test-mode guardrail check: refuses on a few test phrases, honoring which switches are on (they are
 * listed in the content), so tests can check that switches really change what's refused.
 * Custom rules (listed as `<custom_rules>`) refuse a question containing any word of 5+ letters from the
 * rule other than common filler ("Never quote day rates" refuses questions mentioning "rates").
 * A proposed rule (`<proposed_rule>`, the save-time check) is judged "loosens" if it says relax, loosen
 * or lenient, "not_a_rule" if it contains __not_a_rule__, and "restricts" otherwise.
 */
function fakeGuard(content: string) {
  const proposed = content.match(/<proposed_rule>([\s\S]*)<\/proposed_rule>/)?.[1];
  if (proposed !== undefined) {
    if (/\b(relax\w*|loosen\w*|lenient)\b/i.test(proposed)) return { verdict: "loosens" };
    return { verdict: /__not_a_rule__/i.test(proposed) ? "not_a_rule" : "restricts" };
  }
  const q = (content.match(/<question>([\s\S]*)<\/question>/)?.[1] ?? "").toLowerCase();
  // The public help bot's check (`<mode>public</mode>`): the floor plus off-topic and financial advice.
  if (content.includes("<mode>public</mode>")) {
    const pub: [string, RegExp][] = [
      ["hate", /__hate__/],
      ["advice", /\b(lawsuit|sue|diagnos\w*)\b/],
      ["financial", /\b(invest\w*|stocks?|bitcoin|tax advice)\b/],
      ["judging_people", /\b(rank|rate)\b.*\b(people|consultants?|employees?)\b/],
      ["off_topic", /\b(recipe|poem|homework|weather|football|joke)\b/],
    ];
    const hit = pub.find(([, re]) => re.test(q));
    return hit ? { allowed: false, rule: hit[0], custom_rule: null } : { allowed: true, rule: "none", custom_rule: null };
  }
  const active = content.match(/<active_switches>(.*?)<\/active_switches>/)?.[1] ?? "";
  const tests: [string, RegExp, boolean][] = [
    ["hate", /__hate__/, true],
    ["other_data", /\bother (client|workspace)s?\b/, true],
    ["judging_people", /\b(rank|rate)\b.*\b(people|consultants?|employees?)\b/, active.includes("judging_people")],
    ["advice", /\b(lawsuit|sue|diagnos\w*)\b/, active.includes("advice")],
    ["small_talk", /\b(joke|weather|football)\b/, active.includes("small_talk")],
    ["competitors", /\bcompetitors?\b/, active.includes("competitors")],
  ];
  const hit = tests.find(([, re, on]) => on && re.test(q));
  if (hit) return { allowed: false, rule: hit[0], custom_rule: null };
  const rules = (content.match(/<custom_rules>\n([\s\S]*?)\n<\/custom_rules>/)?.[1] ?? "").split("\n").filter(Boolean);
  const qWords = new Set(q.split(/[^a-z']+/));
  for (const line of rules) {
    const [, n, text] = line.match(/^(\d+)\. (.*)$/) ?? [];
    const keys = (text ?? "").toLowerCase().split(/[^a-z']+/).filter((w) => w.length >= 5 && !RULE_FILLER.has(w));
    if (keys.some((k) => qWords.has(k))) return { allowed: false, rule: "custom", custom_rule: Number(n) };
  }
  return { allowed: true, rule: "none", custom_rule: null };
}

/**
 * Test-mode follow-up rewriting (lib/conversations.ts): a message starting with "and", "what about", "how
 * about" or "also" is a follow-up. Its topic replaces the matching words of the last question ("When is the
 * wave 2 cutover?" + "and wave 3?" → "When is the wave 3 cutover?"), or is added to it. Anything else stands
 * on its own.
 */
function fakeFollowUp(content: string) {
  const msg = (content.match(/<message>([\s\S]*?)<\/message>/)?.[1] ?? "").trim();
  const prev = [...content.matchAll(/<question>([\s\S]*?)<\/question>/g)].map((m) => m[1].trim()).at(-1) ?? "";
  const m = msg.match(/^(?:and|what about|how about|also)\s+(.+?)[?.!]*$/i);
  if (!m || !prev) return { standalone: msg, follow_up: false };
  const topic = m[1];
  const head = topic.split(/\s+/)[0].replace(/[^\w-]/g, "");
  const re = new RegExp(`\\b${head}\\s+\\S+?(?=[\\s?.!,]|$)`, "i");
  const standalone = head && re.test(prev) ? prev.replace(re, topic) : `${prev.replace(/[?.!]+$/, "")} ${topic}?`;
  return { standalone, follow_up: true };
}

/**
 * Test-mode help bot and support assistant. Cites the first two sources it was given (`<source id="K1"`);
 * none = "not found". Markers in the message: "__UNGROUNDED__" claims an answer citing a source that doesn't
 * exist (the grounding check must turn it into "I don't know"), "__SWEAR__" swears and "__CONTACT__" adds an
 * email (both cleaned on the way out). Support assistant only: "turn on tracking" proposes that fix for the
 * first chat in the context with tracking off, "__FIX_OTHER__" proposes it for a chat that isn't there (must be
 * dropped), "unlock <email>" proposes unlocking that person, and "which checks" lists the check names it got.
 * Drafting an article (`<resolved_ticket>`) returns a title and body built from the ticket's subject.
 */
function fakeSupport(feature: Feature, content: string) {
  const ticket = content.match(/<resolved_ticket>([\s\S]*?)<\/resolved_ticket>/)?.[1];
  if (ticket !== undefined) {
    const subject = ticket.match(/Subject: (.*)/)?.[1]?.trim() || "Support issue";
    return { title: `How to fix: ${subject}`, body: `If you see this problem (${subject}), here is what fixed it.\n\n1. Check the setting.\n2. Try again.`, tags: ["test"] };
  }
  const msg = (content.match(/<message>([\s\S]*?)<\/message>/)?.[1] ?? "").trim();
  const ids = [...content.matchAll(/<source id="(K\d+)"/g)].map((m) => m[1]);
  const base = { found: ids.length > 0, reply: ids.length ? `Test help answer from ${ids.slice(0, 2).join(", ")} [${ids[0]}].` : "I couldn't find that in the help articles.", source_ids: ids.slice(0, 2) };
  if (msg.includes("__UNGROUNDED__")) Object.assign(base, { found: true, reply: "Sidekick includes a free lifetime plan [K99].", source_ids: ["K99"] });
  if (msg.includes("__SWEAR__")) base.reply = `That setting is shit, use the other one${ids.length ? ` [${ids[0]}]` : ""}.`;
  if (msg.includes("__CONTACT__")) base.reply += " Write to maria.chen@contoso.example.";
  // The help bot's schema calls the text `answer`; the support assistant's `reply`.
  if (feature === "helpbot") return { found: base.found, answer: base.reply, source_ids: base.source_ids };
  if (msg.includes("__UNGROUNDED__")) return { ...base, uses_checks: false, fix: null };
  const ctxJson = content.match(/<checks>([\s\S]*?)<\/checks>/)?.[1] ?? "{}";
  const checks = JSON.parse(ctxJson) as { name: string; chats?: { id: string; track: boolean }[] }[];
  let fix: { type: string; target: string | null } | null = null;
  if (/turn on tracking/i.test(msg)) {
    const chat = checks.flatMap((c) => c.chats ?? []).find((c) => !c.track);
    fix = { type: "turn_on_tracking", target: chat?.id ?? null };
  }
  if (msg.includes("__FIX_OTHER__")) fix = { type: "turn_on_tracking", target: "19:not-this-orgs-chat@thread.v2" };
  const unlock = msg.match(/unlock (\S+@\S+)/i);
  if (unlock) fix = { type: "unlock_person", target: unlock[1] };
  if (/^which checks/i.test(msg)) return { found: true, reply: `Checked: ${checks.map((c) => c.name).join(", ")}.`, source_ids: [], uses_checks: true, fix: null };
  return { ...base, found: base.found || Boolean(fix), uses_checks: Boolean(fix), fix };
}

/** A fake "overloaded" failure (test mode only), retried like the real one. */
class FakeBusyError extends Error {
  constructor() {
    super("Fake overloaded (test)");
  }
}

/**
 * Claude stayed busy (rate limit or overloaded) after every retry: a plain message for the person, 503.
 * Still logged with a reference code, since it means answers were slow or missing.
 */
export class AiBusyError extends HttpError {
  constructor() {
    super(503, `${BRAND.name}'s AI is very busy right now. Try again in a minute.`);
  }
}

/** Extra attempts after the first for a busy or failing API (SIDEKICK_CLAUDE_RETRIES, default 3). */
const RETRIES = Math.max(0, Number(process.env.SIDEKICK_CLAUDE_RETRIES ?? 3));
// Backoff: 1 s, 2 s, 4 s … (capped at 20 s) with jitter; test mode waits milliseconds.
const BACKOFF_MS = FAKE_CLAUDE ? 5 : 1000;

/** True for failures worth retrying: rate limit, overloaded, server errors, timeouts and dropped connections. */
export function isRetryable(e: unknown) {
  if (e instanceof FakeBusyError) return true;
  if (e instanceof Anthropic.APIConnectionError) return true;
  return e instanceof Anthropic.APIError && [408, 429, 500, 502, 503, 504, 529].includes(e.status ?? 0);
}

/**
 * Runs `fn` (one attempt per call, `attempt` = 0, 1, …) and retries retryable failures with exponential
 * backoff and jitter, honouring the API's Retry-After header (up to 30 s). Gives up with `AiBusyError`;
 * other failures are thrown straight away.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (!isRetryable(e)) throw e;
      if (attempt >= RETRIES) throw Object.assign(new AiBusyError(), { cause: e });
      const after = e instanceof Anthropic.APIError ? Number(e.headers?.get?.("retry-after")) : NaN;
      const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : Math.min(BACKOFF_MS * 2 ** attempt, 20_000) * (0.5 + Math.random());
      spanAttrs({ retries: attempt + 1 });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

let client: Anthropic | null = null;
/**
 * The client for Sidekick's own Claude. Throws a friendly 503 if no key is configured yet. Retries are done
 * by `withRetry` (so the SDK's own are off). The hook for a second route: Claude in Sidekick's Azure AI
 * Foundry (e.g. `new AnthropicFoundry(...)` chosen by a setting) belongs here and only here.
 */
function aiClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, `AI answers aren't set up on this server yet. The ${BRAND.name} team needs to add the AI key (ANTHROPIC_API_KEY), then restart the app.`);
  }
  client ??= new Anthropic({ maxRetries: 0, timeout: 120_000 });
  return client;
}

/** True when Sidekick's own AI key is set (or test mode). Drives "AI answers: working" in the portal. */
export function claudeConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY) || FAKE_CLAUDE;
}

/** Dollar cost of one call, from its token usage and the model's prices (unknown models priced as Opus). Batch calls cost half. */
function costOf(model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }, batch = false) {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return ((u.input_tokens * p.in + cacheWrite * p.in * 1.25 + cacheRead * p.cacheRead + u.output_tokens * p.out) / 1_000_000) * (batch ? 0.5 : 1);
}

/** The system prompt as one cached block (see "Prompt caching" above). */
const cachedSystem = (system: string) => [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }];

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
const NO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** Writes one call's usage row (and adds its cost to the AI credit's cached figure). */
async function recordUsage(ctx: { orgId: string | null; workspaceId: string | null; userId?: string | null; payer?: Payer }, feature: string, model: string, usage: Usage, cost: number, latency: number, ok: number, error: string | null) {
  // Calls Sidekick pays for itself never count toward the organization's AI credit.
  if (!ctx.payer) addSpend(ctx.orgId, cost);
  await run(
    `INSERT INTO usage_events (org_id, workspace_id, user_id, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, ok, error, payer, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, ctx.workspaceId, ctx.userId === undefined ? traceUserId() : ctx.userId, feature, model,
    usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens, cost, latency, ok, error, ctx.payer ?? null, now(),
  );
}

/**
 * Who pays for a call that Sidekick pays for itself: "support" (the signed-in support assistant and support
 * article drafts) or "helpbot" (the public help bot, which has its own daily budget). Such calls skip the
 * AI credit check and are recorded with `usage_events.payer`, so they never count toward the organization's
 * AI credit (lib/credit.ts sums only rows without a payer).
 */
export type Payer = "support" | "helpbot";

/**
 * Whose work a call is: org and workspace (for metering; no org for the public help bot), the reader's role
 * (for restriction wording), `skipCredit` for work that must not be refused by the organization's AI credit
 * (see lib/credit.ts), and `payer` when Sidekick pays for it (implies `skipCredit`).
 */
export type Ctx = { orgId: string | null; workspaceId: string | null; role?: string | null; skipCredit?: boolean; payer?: Payer };

/**
 * Calls Claude and returns its answer, validated against a Zod schema.
 *
 * @param feature which feature is calling (picks the model, kill switch and usage bucket)
 * @param ctx     org and workspace the cost is charged to
 * @param opts.system    instructions for Claude (cached between calls)
 * @param opts.content   the material to work on, e.g. sources plus the question
 * @param opts.schema    the exact JSON shape Claude must return
 * @param opts.effort    how hard Claude thinks: "low" is fast and cheap, "high" is most thorough
 * @param opts.maxTokens upper limit on the reply length
 * @throws HttpError 503 if the feature is paused or no key is set; 422 if Claude declined or ran out of room;
 *   FeatureOffError("credit") if the feature pauses because the AI credit is used up; AiBusyError (503) if
 *   Claude stayed busy through every retry
 *
 * Server-side fallback ("default") re-runs a policy-declined request on Anthropic's recommended model.
 * Usage is recorded in `finally`, so failed calls are metered too (one row per call, whatever the retries).
 */
const SPAN_NAMES: Record<Feature, string> = {
  ask: "AI: write the answer", extract: "AI: write meeting notes", insights: "AI: build the knowledge map", assist: "AI: in-app assistant", guard: "AI: guardrail check",
  remind: "AI: word the reminders", support: "AI: support assistant", helpbot: "AI: public help bot", followup: "AI: rewrite the follow-up",
  watch: "AI: check a document against a newer decision",
};
export async function structured<S extends z.ZodType>(
  feature: Feature,
  ctx: Ctx,
  opts: { system: string; content: string; schema: S; effort?: "low" | "medium" | "high"; maxTokens?: number },
): Promise<z.infer<S>> {
  const model = await gateFor(feature, ctx, opts.content);
  let queuedMs = 0;
  try {
    return await AI_LIMITS.run(
      ctx.orgId ?? "sidekick",
      () => span("ai", SPAN_NAMES[feature], () => structuredCall(feature, ctx, opts, model), {
        model: FAKE_CLAUDE ? "fake-claude" : model, effort: opts.effort ?? "medium", queued_ms: queuedMs, ...(model !== MODELS[feature] ? { essentials: true } : {}),
      }),
      { priority: BACKGROUND_FEATURES.has(feature) ? 1 : 0, onWait: (ms) => (queuedMs = ms) },
    );
  } catch (e) {
    if (e instanceof LimiterBusyError) throw Object.assign(new AiBusyError(), { cause: e });
    throw e;
  }
}

/**
 * Turns for live Claude calls, fair between organizations (see "Fair turns between companies" above). One per app
 * copy, shared across module reloads in development.
 */
declare global {
  var __sidekickAiLimits: FairLimiter | undefined;
}
export const AI_LIMITS = (globalThis.__sidekickAiLimits ??= new FairLimiter({
  max: Math.max(1, Number(process.env.SIDEKICK_CLAUDE_CONCURRENCY || 24)),
  perKey: Math.max(1, Number(process.env.SIDEKICK_CLAUDE_ORG_CONCURRENCY || 6)),
  maxWaitMs: Math.max(1000, Number(process.env.SIDEKICK_CLAUDE_WAIT_MS || 45_000)),
}));
/** Features nobody is waiting on right now: they wait behind calls a person is waiting for. */
const BACKGROUND_FEATURES = new Set<Feature>(["watch", "remind"]);

/**
 * The checks before any Claude work, live or batched: the kill switches and per-client restrictions
 * (`assertEnabled`), then the AI credit (may pick a cheaper model or refuse an extra). Returns the model.
 * Checked before the step starts: a refusal is deliberate and must not show up as a failed Claude step.
 */
async function gateFor(feature: Feature, ctx: Ctx, content: string): Promise<string> {
  await assertEnabled(feature, ctx.orgId, ctx.role);
  const gate = await creditGate(feature, ctx.orgId, { size: content.length, skipCredit: ctx.skipCredit || Boolean(ctx.payer) });
  return gate.model ?? MODELS[feature];
}

/** The Claude call itself (wrapped in a trace span by `structured`), with retries. */
async function structuredCall<S extends z.ZodType>(
  feature: Feature,
  ctx: Ctx,
  opts: { system: string; content: string; schema: S; effort?: "low" | "medium" | "high"; maxTokens?: number },
  model: string,
): Promise<z.infer<S>> {
  if (FAKE_CLAUDE) return withRetry((attempt) => fakeClaude(feature, ctx, opts.content, model, attempt)) as Promise<z.infer<S>>;
  const started = Date.now();
  let ok = 0;
  let error: string | null = null;
  let usage = NO_USAGE;
  try {
    const response = await withRetry(() =>
      aiClient().beta.messages.parse({
        model,
        max_tokens: opts.maxTokens ?? 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: cachedSystem(opts.system),
        output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(opts.schema) },
        messages: [{ role: "user", content: opts.content }],
      }),
    );
    usage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    if (response.stop_reason === "refusal") {
      throw new HttpError(422, "Claude declined to process this content.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new HttpError(422, "The answer was too long to finish. Try a smaller file or a narrower question.");
    }
    if (!response.parsed_output) throw new HttpError(502, "Claude's response didn't match the expected format. Try again.");
    ok = 1;
    return response.parsed_output as z.infer<S>;
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 500) : "Unknown error";
    throw e;
  } finally {
    const cost = costOf(model, usage);
    spanAttrs({ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cached_tokens: usage.cache_read_input_tokens, cost_usd: Number(cost.toFixed(6)) });
    await recordUsage(ctx, feature, model, usage, cost, Date.now() - started, ok, error);
  }
}

/* ---------- Batch API: work nobody waits for, at half the price ---------- */

/**
 * What to do with a batched result. `schema` checks Claude's JSON; `finish` gets the parsed output (or null
 * plus the error when the request failed, expired or didn't match) and the `ref` given when queueing.
 * Handlers register by name at module load (e.g. "reminder" in lib/reminders.ts), so queued items only
 * store the name, never code.
 */
export type BatchHandler = { schema: z.ZodType; finish: (ref: string, output: unknown | null, error: string | null) => Promise<void> };
const handlers = new Map<string, BatchHandler>();
/** Registers a batch handler (see `BatchHandler`). */
export function registerBatchHandler(name: string, h: BatchHandler) {
  handlers.set(name, h);
}

/** Whether non-urgent work goes through the Batch API (`SIDEKICK_BATCH=off` makes everything live). */
export const batchEnabled = () => process.env.SIDEKICK_BATCH !== "off";

type BatchItem = { id: string; batch_id: string | null; org_id: string; workspace_id: string | null; feature: Feature; model: string; handler: string; ref: string; request_json: string | null; status: string; created_at: string };

/**
 * Queues one structured call for the next Message Batch instead of calling Claude now. The same checks
 * as a live call run first (kill switches, client restrictions, the AI credit), so a refusal is thrown
 * here. `runBatches` sends it and later hands the result to the named handler with `ref`.
 * The request (instructions and content) waits in `ai_batch_items` and is deleted once handled.
 */
export async function queueStructured(feature: Feature, ctx: Ctx, opts: { system: string; content: string; effort?: "low" | "medium" | "high"; maxTokens?: number }, job: { handler: string; ref: string }) {
  if (!handlers.has(job.handler)) throw new Error(`Unknown batch handler ${job.handler}`);
  const model = await gateFor(feature, ctx, opts.content);
  await run(
    "INSERT INTO ai_batch_items (id, batch_id, org_id, workspace_id, feature, model, handler, ref, request_json, status, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
    newId(), ctx.orgId, ctx.workspaceId, feature, model, job.handler, job.ref,
    JSON.stringify({ system: opts.system, content: opts.content, effort: opts.effort ?? "medium", maxTokens: opts.maxTokens ?? 4000 }), now(),
  );
}

/**
 * Sends every queued item as one Message Batch, then collects the batches that have ended and hands each
 * result to its handler. Called by the `reminders.daily` job every 5 minutes (a real batch usually ends within minutes;
 * results are picked up on a later run). Test mode answers a batch at once with the fake outputs.
 * Batched calls are metered at half price. Returns how many results were handled.
 */
export async function runBatches(): Promise<number> {
  return span("ai", "AI: batch requests", async () => {
    const queued = await all<BatchItem>("SELECT * FROM ai_batch_items WHERE status = 'queued' ORDER BY created_at LIMIT 1000");
    if (queued.length) {
      const batchId = FAKE_CLAUDE ? `fake_${newId()}` : await submitBatch(queued);
      for (const q of queued) await run("UPDATE ai_batch_items SET batch_id = ?, status = 'sent' WHERE id = ?", batchId, q.id);
    }
    const sent = await all<{ batch_id: string }>("SELECT DISTINCT batch_id FROM ai_batch_items WHERE status = 'sent'");
    let handled = 0;
    for (const { batch_id } of sent) handled += await collectBatch(batch_id);
    spanAttrs({ queued: queued.length, handled });
    return handled;
  });
}

/** Sends queued items to the Batch API; returns Anthropic's batch id. */
async function submitBatch(items: BatchItem[]): Promise<string> {
  const batch = await withRetry(() =>
    aiClient().beta.messages.batches.create({
      requests: items.map((it) => {
        const req = JSON.parse(it.request_json!) as { system: string; content: string; effort: "low" | "medium" | "high"; maxTokens: number };
        return {
          custom_id: it.id,
          params: {
            model: it.model,
            max_tokens: req.maxTokens,
            system: cachedSystem(req.system),
            output_config: { effort: req.effort, format: betaZodOutputFormat(handlers.get(it.handler)!.schema) },
            messages: [{ role: "user" as const, content: req.content }],
          },
        };
      }),
    }),
  );
  return batch.id;
}

/** Collects one batch if it has ended: parses each result, meters it at half price and calls its handler. */
async function collectBatch(batchId: string): Promise<number> {
  const items = await all<BatchItem>("SELECT * FROM ai_batch_items WHERE batch_id = ? AND status = 'sent'", batchId);
  const results = new Map<string, { output: unknown | null; error: string | null; usage: Usage }>();
  if (batchId.startsWith("fake_")) {
    for (const it of items) {
      const req = JSON.parse(it.request_json ?? "{}") as { content: string };
      try {
        results.set(it.id, { output: await fakeClaude(it.feature, { orgId: it.org_id, workspaceId: it.workspace_id }, req.content, it.model), error: null, usage: NO_USAGE });
      } catch (e) {
        results.set(it.id, { output: null, error: e instanceof Error ? e.message : "Failed", usage: NO_USAGE });
      }
    }
  } else {
    const batch = await withRetry(() => aiClient().beta.messages.batches.retrieve(batchId));
    if (batch.processing_status !== "ended") return 0;
    for await (const r of await aiClient().beta.messages.batches.results(batchId)) {
      if (r.result.type !== "succeeded") {
        results.set(r.custom_id, { output: null, error: `Batch request ${r.result.type}`, usage: NO_USAGE });
        continue;
      }
      const m = r.result.message;
      const usage: Usage = { input_tokens: m.usage.input_tokens, output_tokens: m.usage.output_tokens, cache_read_input_tokens: m.usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: m.usage.cache_creation_input_tokens ?? 0 };
      const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      let output: unknown = null;
      try {
        output = JSON.parse(text);
      } catch {}
      results.set(r.custom_id, { output, error: output === null ? (m.stop_reason === "refusal" ? "Claude declined to process this content." : "The response wasn't valid JSON.") : null, usage });
    }
  }
  let handled = 0;
  for (const it of items) {
    const res = results.get(it.id) ?? { output: null, error: "No result in the batch", usage: NO_USAGE };
    const h = handlers.get(it.handler);
    const parsed = res.output !== null && h ? h.schema.safeParse(res.output) : null;
    const output = parsed?.success ? parsed.data : null;
    const error = res.error ?? (parsed && !parsed.success ? "Claude's response didn't match the expected format." : null);
    // Fake batches were already metered by fakeClaude; real ones are metered here, at the batch price.
    if (!batchId.startsWith("fake_")) {
      await recordUsage({ orgId: it.org_id, workspaceId: it.workspace_id, userId: null }, it.feature, it.model, res.usage, costOf(it.model, res.usage, true), 0, output ? 1 : 0, error);
    }
    try {
      await h?.finish(it.ref, output, error);
    } catch (e) {
      console.error(`Batch handler ${it.handler} failed for ${it.ref}`, e);
    }
    await run("UPDATE ai_batch_items SET status = 'done', request_json = NULL WHERE id = ?", it.id);
    handled++;
  }
  // Old finished rows are kept a day for troubleshooting, then dropped.
  await run("DELETE FROM ai_batch_items WHERE status = 'done' AND created_at < ?", new Date(Date.now() - 86400_000).toISOString());
  return handled;
}
