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
import { now, run } from "./db";
import { traceFailed, withTrace } from "./trace";

/** "/api/meetings/3f2a…" → "/api/meetings/:id", so the Activity page groups requests by operation. */
const routeName = (req: unknown) =>
  req instanceof Request ? `${req.method} ${new URL(req.url).pathname.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}|\/[0-9a-f]{16,}/gi, "/:id")}` : "request";

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
    await run(
      "INSERT INTO app_errors (ref, status, method, route, message, stack, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ref, status, r?.method ?? null, route, message.slice(0, 2000), e instanceof Error ? (e.stack ?? "").slice(0, 4000) : null, now(),
    );
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
  return `Something went wrong on our side. Try again; if it keeps happening, contact the Sidekick team. (Reference ${ref})`;
}

/**
 * Wraps a route handler so its return value becomes JSON and thrown errors become clean JSON errors the
 * UI can show. Nothing fails silently:
 * - `HttpError`s (expected problems: not signed in, not allowed, invalid input) return their message.
 * - Claude API errors (bad key, rate limit, outage) become plain-language messages with a reference code.
 * - Anything unexpected returns a 500 with a generic message and a reference code; the full details go to
 *   the error log (`logAppError`), never to the browser, so internal details can't leak.
 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) =>
    withTrace({ name: routeName(args[0]), channel: "portal" }, async () => {
    try {
      const out = await fn(...args);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      // Next.js signals things like "this route needs the request (cookies)" by throwing; let those through.
      unstable_rethrow(e);
      const fail = async (status: number, error: string) => {
        const ref = newRef();
        await logAppError(ref, status, args[0], e);
        traceFailed(status, error, ref);
        return NextResponse.json({ error: `${error} (Reference ${ref})`, ref }, { status });
      };
      if (e instanceof HttpError) {
        // 5xx HttpErrors (e.g. Claude declined, Azure down) are still problems worth a reference code.
        if (e.status >= 500 && !/paused/i.test(e.message)) return fail(e.status, e.message);
        traceFailed(e.status, e.message);
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      if (e instanceof Anthropic.AuthenticationError) return fail(502, "Claude rejected the API key. The Sidekick team needs to update it.");
      if (e instanceof Anthropic.RateLimitError) return fail(429, "Claude is busy right now (rate limit). Wait a minute and try again.");
      if (e instanceof Anthropic.APIError) return fail(502, `Claude couldn't answer right now (${e.status ?? "network"}). Try again in a minute.`);
      return fail(500, "Something went wrong on our side. Try again; if it keeps happening, contact the Sidekick team.");
    }
    });
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
