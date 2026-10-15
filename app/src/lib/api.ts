import "server-only";
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "./auth";

// Wraps a route handler so thrown HttpErrors become clean JSON errors the UI can show.
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      const out = await fn(...args);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
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

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "The request body isn't valid JSON.");
  }
}

export function requireText(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${label} is required.`);
  if (value.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters).`);
  return value.trim();
}
