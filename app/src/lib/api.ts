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
import { HttpError } from "./auth";

/**
 * Wraps a route handler so its return value becomes JSON and thrown errors become clean JSON errors the
 * UI can show. Claude API errors (bad key, rate limit, outage) are translated into plain-language messages;
 * anything unexpected is logged on the server and returned as a 500.
 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      const out = await fn(...args);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      // Next.js signals things like "this route needs the request (cookies)" by throwing; let those through.
      unstable_rethrow(e);
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof Anthropic.AuthenticationError) {
        return NextResponse.json({ error: "Claude rejected the API key. Check ANTHROPIC_API_KEY in app/.env.local, then restart the app." }, { status: 502 });
      }
      if (e instanceof Anthropic.RateLimitError) {
        return NextResponse.json({ error: "Claude is rate-limiting this API key. Wait a minute and try again." }, { status: 429 });
      }
      if (e instanceof Anthropic.APIError) {
        return NextResponse.json({ error: `Claude API error (${e.status ?? "network"}): ${e.message}` }, { status: 502 });
      }
      console.error(e);
      return NextResponse.json({ error: e instanceof Error ? e.message : "Something went wrong." }, { status: 500 });
    }
  };
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
