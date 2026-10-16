/**
 * @file The only place Sidekick talks to Claude (Anthropic's AI model).
 *
 * Concepts
 * - **Feature**: each kind of AI work has a name (`ask`, `extract`, `insights`, `assist`) so it can use its own
 *   model, be metered separately on the Usage page, and be paused with a kill switch in the Owner Console.
 * - **Structured output**: instead of free text, Claude must reply with JSON matching a Zod schema, so the
 *   app can save answers, decisions and action items without guessing at their shape.
 * - **Tokens and cost**: Claude bills per token (roughly ¾ of a word). Every call is logged to
 *   `usage_events` with tokens, USD cost, latency and any error, whether it succeeded or not.
 * - **Prompt caching**: repeated instructions are cached by Anthropic, so follow-up calls cost less.
 * - **Server-side fallback**: if a model declines a request on policy grounds, Anthropic retries it on
 *   their recommended fallback model automatically.
 *
 * The key comes from `ANTHROPIC_API_KEY` in app/.env.local. Production swaps this client for Claude hosted
 * on Azure (AnthropicFoundry) without changing callers.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { HttpError } from "./auth";
import { now, run } from "./db";
import { assertEnabled } from "./owner";
import { span, spanAttrs } from "./trace";

// One place to choose models. Defaults to Claude Opus 5.5 everywhere; override per feature in .env.local
// (e.g. SIDEKICK_MODEL_ASK=claude-sonnet-5-5) to trade quality for cost. In step 2 this client is swapped
// for AnthropicFoundry (Claude hosted on Azure) with no other code changes.
export const MODELS = {
  extract: process.env.SIDEKICK_MODEL_EXTRACT || process.env.SIDEKICK_MODEL || "claude-opus-5-5",
  ask: process.env.SIDEKICK_MODEL_ASK || process.env.SIDEKICK_MODEL || "claude-opus-5-5",
  insights: process.env.SIDEKICK_MODEL_INSIGHTS || process.env.SIDEKICK_MODEL || "claude-opus-5-5",
  assist: process.env.SIDEKICK_MODEL_ASSIST || process.env.SIDEKICK_MODEL || "claude-opus-5-5",
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

/**
 * Canned, schema-shaped outputs for test mode. A content containing "__FAIL__" makes the call fail, so
 * tests can check that failures are reported (e.g. a meeting marked Failed with a reason).
 */
async function fakeClaude(feature: Feature, ctx: Ctx, content: string): Promise<unknown> {
  await run(
    `INSERT INTO usage_events (org_id, workspace_id, feature, model, input_tokens, output_tokens, cost_usd, latency_ms, ok, error, created_at)
     VALUES (?, ?, ?, 'fake-claude', 0, 0, 0, 0, ?, ?, ?)`,
    ctx.orgId, ctx.workspaceId, feature, content.includes("__FAIL__") ? 0 : 1, content.includes("__FAIL__") ? "Fake failure" : null, now(),
  );
  if (content.includes("__FAIL__")) throw new HttpError(502, "Claude API error (test): fake failure for testing.");
  if (feature === "ask") {
    const ids = [...content.matchAll(/<source id="(S\d+)"/g)].map((m) => m[1]);
    return { found: ids.length > 0, answer: ids.length ? `Test answer from ${ids.join(", ")} [S1].` : "Not in the sources.", source_ids: ids.slice(0, 2) };
  }
  if (feature === "extract") {
    return {
      summary: "Test summary of the meeting.",
      decisions: [{ text: "Test decision", made_by: "Priya Raman" }],
      action_items: [{ text: "Send the test report", owner: "Maria Chen", due: "Oct 21" }, { text: "Book the load test", owner: null, due: null }],
      open_questions: [{ text: "Who owns rollback?", answered: false }],
      facts: [{ kind: "risk", text: "Test risk" }],
    };
  }
  if (feature === "assist") {
    // Understands two test phrases: "create workspace <name>" and "add <name> <email>"; anything else gets a plain reply.
    const msg = content.match(/<message>([\s\S]*)<\/message>/)?.[1].trim() ?? "";
    const ws = msg.match(/^create (?:a )?workspace (?:called |named )?(.+)$/i);
    if (ws) return { reply: `Here's what I'll do: create “${ws[1]}”. Press Confirm.`, action: { type: "create_workspace", name: ws[1], code: null, email: null, role: null, workspace_ids: [], guests: null, page: null } };
    const person = msg.match(/^add (.+?) (\S+@\S+)$/i);
    if (person) return { reply: `Here's what I'll do: add ${person[1]}. Press Confirm.`, action: { type: "add_person", name: person[1], code: null, email: person[2], role: "Member", workspace_ids: [], guests: null, page: null } };
    return { reply: "Test assistant reply.", action: null };
  }
  return { topics: [{ name: "Test topic", summary: "About the test", coverage: 150, key_facts: [], document_titles: [], meeting_titles: [] }], gaps: [] };
}

let client: Anthropic | null = null;
/** The shared Anthropic client. Throws a friendly 503 if no API key is configured yet. */
function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, "Claude isn't connected yet. Add your key as ANTHROPIC_API_KEY in app/.env.local, then restart the app.");
  }
  client ??= new Anthropic();
  return client;
}

/** True when an API key is set. Drives the "Claude connected" badge in the portal header. */
export function claudeConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Dollar cost of one call, from its token usage and the model's prices (unknown models priced as Opus). */
function costOf(model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return (u.input_tokens * p.in + cacheWrite * p.in * 1.25 + cacheRead * p.cacheRead + u.output_tokens * p.out) / 1_000_000;
}

/** Who the call is for, so its cost lands on the right org and workspace in usage reports. */
type Ctx = { orgId: string; workspaceId: string | null };

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
 * @throws HttpError 503 if the feature is paused or no key is set; 422 if Claude declined or ran out of room
 *
 * Server-side fallback ("default") re-runs a policy-declined request on Anthropic's recommended model.
 * Usage is recorded in `finally`, so failed calls are metered too.
 */
const SPAN_NAMES: Record<Feature, string> = { ask: "Claude: write the answer", extract: "Claude: write meeting notes", insights: "Claude: build the knowledge map", assist: "Claude: in-app assistant" };
export async function structured<S extends z.ZodType>(
  feature: Feature,
  ctx: Ctx,
  opts: { system: string; content: string; schema: S; effort?: "low" | "medium" | "high"; maxTokens?: number },
): Promise<z.infer<S>> {
  return span("ai", SPAN_NAMES[feature], () => structuredCall(feature, ctx, opts), { model: FAKE_CLAUDE ? "fake-claude" : MODELS[feature], effort: opts.effort ?? "medium" });
}

/** The Claude call itself (wrapped in a trace span by `structured`). */
async function structuredCall<S extends z.ZodType>(
  feature: Feature,
  ctx: Ctx,
  opts: { system: string; content: string; schema: S; effort?: "low" | "medium" | "high"; maxTokens?: number },
): Promise<z.infer<S>> {
  await assertEnabled(feature);
  if (FAKE_CLAUDE) return fakeClaude(feature, ctx, opts.content) as z.infer<S>;
  const model = MODELS[feature];
  const started = Date.now();
  let ok = 0;
  let error: string | null = null;
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  try {
    const response = await anthropic().beta.messages.parse({
      model,
      max_tokens: opts.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: opts.system,
      output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(opts.schema) },
      messages: [{ role: "user", content: opts.content }],
    });
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
    spanAttrs({ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cached_tokens: usage.cache_read_input_tokens, cost_usd: Number(costOf(model, usage).toFixed(6)) });
    await run(
      `INSERT INTO usage_events (org_id, workspace_id, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, ok, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.orgId,
      ctx.workspaceId,
      feature,
      model,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_input_tokens,
      usage.cache_creation_input_tokens,
      costOf(model, usage),
      Date.now() - started,
      ok,
      error,
      now(),
    );
  }
}
