/**
 * @file Small helpers shared by every API route (`app/src/app/api/**`).
 *
 * Every route follows the same pattern:
 *   export const POST = handle(async (req) => {
 *     const user = await requireUser();               // who is asking (401 if nobody)
 *     const ws = await requireWorkspace(user, body.ws);      // may they use this workspace (404 if not)
 *     ...do the work, filtered by user.org_id and ws...
 *     return { ok: true };                             // becomes a JSON response
 *   });
 * Errors thrown as `HttpError` become `{ error: "message" }` with that status, which the UI shows as-is.
 */
import "server-only";
import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import { HttpError } from "./auth";
import { FeatureOffError } from "./owner";
import { asSystem, markRequestSystem, now, openRequestScope, run } from "./db";
import { failureReason, traceFailed, withTrace } from "./trace";
import { crossSiteRefusal } from "./security";
import { readOnlyRefusal } from "./billing";
import { runRequest } from "./request-scope";
import { BRAND } from "./brand";

/**
 * "/api/meetings/3f2a…" → "/api/meetings/:id", so the Activity page groups requests by operation. Every
 * segment after a collection name that is a value rather than a fixed route word becomes ":id": ids of any
 * shape (UUIDs, hex, made-up ones like "nope"), so a mistyped id doesn't become an operation of its own.
 */
export function routeName(req: unknown) {
  if (!(req instanceof Request)) return "request";
  return `${req.method} ${normalisePath(new URL(req.url).pathname)}`;
}

/**
 * The collections with a dynamic `[id]` segment (app/api/<collection>/[id]); the segment right after one of
 * them is always an id. Add a collection here when adding such a route.
 */
const ID_COLLECTIONS = new Set(["meetings", "items", "action-items", "docs", "users", "tenants", "workspaces", "rolloffs", "tickets", "attachments"]);

/** Fixed route words that sit where an id could (e.g. /api/meetings/auto), kept as they are. */
const FIXED_WORDS = new Set(["auto"]);

/** The path with dynamic segments replaced by ":id" (see `routeName`). */
export function normalisePath(pathname: string) {
  const parts = pathname.split("/");
  return parts
    .map((seg, i) => (seg && !FIXED_WORDS.has(seg) && (ID_COLLECTIONS.has(parts[i - 1]) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{16,}$/i.test(seg)) ? ":id" : seg))
    .join("/");
}

/** A short code (like "K7Q2-9XM4") that links what the person saw to the full error in the error log. */
const newRef = () => {
  const c = Array.from(crypto.randomBytes(8), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};

/**
 * Records an unexpected server error under its reference code: always in the server log, and in the
 * `app_errors` table when the database is reachable (the Owner Console lists them). Never throws, so a
 * broken database can't hide the original problem.
 */
async function logAppError(ref: string, status: number, req: unknown, e: unknown) {
  const r = req instanceof Request ? req : null;
  const route = r ? new URL(r.url).pathname : "";
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[error ${ref}] ${r?.method ?? ""} ${route} → ${status}:`, e);
  try {
    // The error log is the Sidekick team's (no org), written whatever the request's scope was.
    await asSystem("error log", () => run(
      "INSERT INTO app_errors (ref, status, method, route, message, stack, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ref, status, r?.method ?? null, route, message.slice(0, 2000), e instanceof Error ? (e.stack ?? "").slice(0, 4000) : null, now(),
    ));
  } catch (logErr) {
    console.error(`[error ${ref}] could not be saved to app_errors`, logErr);
  }
}

/**
 * For routes that answer with a redirect instead of JSON (Microsoft sign-in): turns an error into a
 * message safe to show, recording unexpected ones under a reference code like `handle()` does.
 */
export async function errorMessageFor(req: Request, e: unknown): Promise<string> {
  unstable_rethrow(e);
  if (e instanceof HttpError) {
    if (e.status < 500) {
      traceFailed(e.status, e.message);
      return e.message;
    }
    const ref = newRef();
    await logAppError(ref, e.status, req, e);
    traceFailed(e.status, e.message, ref);
    return `${e.message} (Reference ${ref})`;
  }
  const ref = newRef();
  await logAppError(ref, 500, req, e);
  traceFailed(500, "Sign-in failed unexpectedly", ref);
  return `Something went wrong on our side. Try again; if it keeps happening, contact the ${BRAND.name} team. (Reference ${ref})`;
}

const DETAILS = Symbol("sidekick.errorDetails");

/**
 * Attaches extra, safe-to-show fields to an error before re-throwing it, and `handle()` adds them to the
 * JSON error body. Used where the page needs to know something about a failure, e.g. the id of a meeting
 * that was saved even though writing its notes failed (so the page can open it with **Try again**).
 * Only ids and other non-sensitive values: they go to the browser.
 */
export function withErrorDetails<E>(e: E, details: Record<string, ErrorDetail>): E {
  if (e && typeof e === "object") (e as Record<symbol, unknown>)[DETAILS] = details;
  return e;
}
const detailsOf = (e: unknown) => ((e && typeof e === "object" && (e as Record<symbol, unknown>)[DETAILS]) || {}) as Record<string, ErrorDetail>;
/** A value `withErrorDetails` may attach: plain JSON (ids, numbers, small objects such as upgrade options). */
export type ErrorDetail = string | number | boolean | null | ErrorDetail[] | { [k: string]: ErrorDetail };

/**
 * Wraps a route handler so its return value becomes JSON and thrown errors become clean JSON errors the
 * UI can show. Changes coming from another website are refused first (`crossSiteRefusal`, 403). Nothing fails silently:
 * - `HttpError`s (expected problems: not signed in, not allowed, invalid input) return their message.
 * - Claude API errors (bad key, rate limit, outage) become plain-language messages with a reference code.
 * - Anything unexpected returns a 500 with a generic message and a reference code; the full details go to
 *   the error log (`logAppError`), never to the browser, so internal details can't leak.
 * - Before the route runs, a change (anything but GET) from an organization whose plan has lapsed is
 *   refused with 402 and the reason (`readOnlyRefusal` in lib/billing.ts), so read-only holds for every route.
 * - The route runs inside `runRequest` (lib/request-scope.ts), so `requireWorkspace` can keep groups that
 *   are ending read-only for every route that changes something.
 * - Everything runs in a database org scope (`openRequestScope`, lib/db.ts): it starts with no org, and
 *   `requireUser` fills in the person's org, so Postgres row-level security hides every other org's rows.
 *   Routes that work before anyone is signed in and must look across orgs (sign-in, sign-up, Microsoft sign-in,
 *   the public help bot, Microsoft Graph notifications) pass `opts.system`, a short reason naming them.
 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<unknown>, opts: { system?: string } = {}) {
  return async (...args: A) =>
    openRequestScope(() => withTrace({ name: routeName(args[0]), channel: "portal" }, async () => {
    if (opts.system) markRequestSystem(opts.system);
    try {
      // Changes from another website first (CSRF), then a read-only (unpaid/ended) plan.
      const crossSite = args[0] instanceof Request ? crossSiteRefusal(args[0]) : null;
      if (crossSite) throw new HttpError(403, crossSite);
      const readOnly = args[0] instanceof Request ? await readOnlyRefusal(args[0]) : null;
      if (readOnly) throw new HttpError(402, readOnly);
      const out = await runRequest(args[0], () => fn(...args));
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      // Next.js signals things like "this route needs the request (cookies)" by throwing; let those through.
      unstable_rethrow(e);
      const fail = async (status: number, error: string) => {
        const ref = newRef();
        await logAppError(ref, status, args[0], e);
        // An HttpError's message is already the reason; anything else gets its type and message on the step.
        traceFailed(status, error, ref, e instanceof HttpError ? {} : { reason: failureReason(e) });
        return NextResponse.json({ ...detailsOf(e), error: `${error} (Reference ${ref})`, ref }, { status });
      };
      if (e instanceof FeatureOffError) {
        // Paused or turned off on purpose: a refusal, not an app error (no reference code, no App errors row).
        traceFailed(e.status, e.message, undefined, { refusal: true });
        return NextResponse.json({ ...detailsOf(e), error: e.message, kind: e.reason }, { status: e.status });
      }
      if (e instanceof HttpError) {
        // 5xx HttpErrors (e.g. Claude declined, Azure down) are still problems worth a reference code.
        if (e.status >= 500) return fail(e.status, e.message);
        traceFailed(e.status, e.message);
        return NextResponse.json({ ...detailsOf(e), error: e.message }, { status: e.status });
      }
      if (e instanceof Anthropic.AuthenticationError) return fail(502, `Claude rejected the API key. The ${BRAND.name} team needs to update it.`);
      if (e instanceof Anthropic.RateLimitError) return fail(429, "Claude is busy right now (rate limit). Wait a minute and try again.");
      if (e instanceof Anthropic.APIError) return fail(502, `Claude couldn't answer right now (${e.status ?? "network"}). Try again in a minute.`);
      return fail(500, `Something went wrong on our side. Try again; if it keeps happening, contact the ${BRAND.name} team.`);
    }
    }));
}

/** Parses the request body as JSON, or throws 400 with a readable message. */
export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "The request body isn't valid JSON.");
  }
}

/** Checks a required text field: must be a non-empty string under `max` characters. Returns it trimmed. */
export function requireText(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${label} is required.`);
  if (value.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters).`);
  return value.trim();
}
