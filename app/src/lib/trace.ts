/**
 * @file Tracing: a timeline of what Sidekick did for each request, shown on the client's Activity page.
 *
 * Concepts (the same ones Dynatrace, Application Insights and OpenTelemetry use)
 * - **Trace**: one unit of work from start to finish, e.g. "a question asked in Teams" or "POST /api/docs".
 *   It has a channel (portal, Teams, system), who did it, how long it took and whether it failed.
 * - **Span**: one step inside a trace, e.g. "search the workspace" or "Claude: answer". Spans nest
 *   (a parent span contains its children), and each records when it started (relative to the trace),
 *   how long it took, and a few non-sensitive attributes (engine, result count, model, tokens, cost).
 * - **Database time**: queries aren't logged one by one (a page can run dozens); the trace instead
 *   counts them and adds up their time, like an APM tool's "database calls" summary.
 *
 * Privacy: spans hold timings, counts, model names and costs, never document text or answers. Traces
 * are saved only once they belong to an organization, are visible only to that org's admins, and are
 * deleted after 30 days.
 *
 * Usage: `withTrace(...)` starts a trace around a request (done by `handle()` in api.ts and by the
 * Teams bot); `span(...)` wraps a step inside it; `traceScope(...)` fills in org/workspace/actor as
 * soon as they're known. Outside a trace, `span` just runs the function, so library code can always use it.
 * The shape matches OpenTelemetry, so these can later also be exported to Azure Application Insights.
 */
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

export type SpanKind = "request" | "search" | "ai" | "embed" | "teams" | "index" | "file" | "guard" | "remind" | "auth";
export type Channel = "portal" | "teams" | "system";
type Attrs = Record<string, string | number | boolean | null>;

type SpanRecord = {
  id: string;
  parentId: string | null;
  kind: SpanKind;
  name: string;
  start: number; // ms since trace start
  duration: number;
  status: "ok" | "error";
  error?: string;
  attrs: Attrs;
};

type TraceState = {
  id: string;
  name: string;
  channel: Channel;
  startedAt: number;
  orgId: string | null;
  workspaceId: string | null;
  actor: string | null;
  /** The signed-in person's user id (null for system work and Teams guests); usage rows record it. */
  userId: string | null;
  spans: SpanRecord[];
  dbQueries: number;
  dbMs: number;
  status: "ok" | "error";
  httpStatus: number | null;
  error: string | null;
  ref: string | null;
};

type Ctx = { trace: TraceState; spanId: string | null };
declare global {
  var __sidekickTraceStore: AsyncLocalStorage<Ctx> | undefined;
}
// One shared store per process: after a code reload in development, old and new copies of this module
// must see the same "current trace", or steps recorded by one copy would be lost.
const store = (globalThis.__sidekickTraceStore ??= new AsyncLocalStorage<Ctx>());
const newId = () => crypto.randomBytes(8).toString("hex");
const RETENTION_DAYS = 30;

/** Fills in who and where, as soon as it's known (after sign-in, after the workspace check). */
export function traceScope(scope: { orgId?: string | null; workspaceId?: string | null; actor?: string | null; userId?: string | null }) {
  const t = store.getStore()?.trace;
  if (!t) return;
  if (scope.orgId !== undefined && scope.orgId) t.orgId = scope.orgId;
  if (scope.workspaceId !== undefined && scope.workspaceId) t.workspaceId = scope.workspaceId;
  if (scope.actor !== undefined && scope.actor) t.actor = scope.actor;
  if (scope.userId !== undefined && scope.userId) t.userId = scope.userId;
}

/** The user id of the person this work is for (set by `traceScope`), or null. Used to tie AI usage to a person. */
export function traceUserId(): string | null {
  return store.getStore()?.trace.userId ?? null;
}

/**
 * Marks the trace as failed with an HTTP status and (optionally) the reference code the person saw.
 * - `opts.refusal`: a deliberate "no" with a 5xx status (a feature paused or turned off by the Sidekick team);
 *   recorded like a 4xx refusal, not counted as a failure of Sidekick.
 * - `opts.reason`: why it failed, for the trace's first step (e.g. "TypeError: x.trim is not a function"),
 *   when the message shown to the person is the generic one. Never document text: see `failureReason`.
 */
export function traceFailed(httpStatus: number, error: string, ref?: string, opts: { refusal?: boolean; reason?: string } = {}) {
  const refusal = opts.refusal ?? false;
  const t = store.getStore()?.trace;
  if (!t) return;
  // 4xx = refused (not allowed, not found, bad input): recorded, but not counted as a failure of Sidekick.
  if (httpStatus >= 500 && !refusal) t.status = "error";
  t.httpStatus = httpStatus;
  t.error = error.slice(0, 300);
  t.ref = ref ?? null;
  // The root step carries the reason too, so a failed trace's timeline says why (message only, no data).
  const root = t.spans[0];
  if (root && httpStatus >= 500 && !refusal) root.error = (opts.reason ? `${error} · ${opts.reason}` : error).slice(0, 300);
}

/**
 * A short, data-free reason for an unexpected error: its type and message, with anything quoted (which could
 * be a piece of a document or a value someone typed) replaced by "…", cut to 160 characters.
 */
export function failureReason(e: unknown): string {
  const name = e instanceof Error ? e.name : typeof e;
  const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0].replace(/(["'`“”‘’]).*?\1/g, "“…”");
  return `${name}: ${msg}`.slice(0, 160);
}

/** Adds non-sensitive attributes to the current span (or the trace's root span). */
export function spanAttrs(attrs: Attrs) {
  const s = store.getStore();
  if (!s) return;
  const span = s.trace.spans.find((x) => x.id === s.spanId);
  if (span) Object.assign(span.attrs, attrs);
}

/** Counts one database query and its time against the current trace (called by db.ts). */
export function countDbQuery(ms: number) {
  const t = store.getStore()?.trace;
  if (!t) return;
  t.dbQueries++;
  t.dbMs += ms;
}

/**
 * Runs `fn` as one step of the current trace. Records its timing, success or failure, and `attrs`.
 * Errors are recorded and re-thrown unchanged. Without an active trace it simply runs `fn`.
 */
export async function span<T>(kind: SpanKind, name: string, fn: () => Promise<T>, attrs: Attrs = {}): Promise<T> {
  const s = store.getStore();
  if (!s) return fn();
  const rec: SpanRecord = { id: newId(), parentId: s.spanId, kind, name, start: Date.now() - s.trace.startedAt, duration: 0, status: "ok", attrs: { ...attrs } };
  s.trace.spans.push(rec);
  const t0 = Date.now();
  try {
    return await store.run({ trace: s.trace, spanId: rec.id }, fn);
  } catch (e) {
    rec.status = "error";
    rec.error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    throw e;
  } finally {
    rec.duration = Date.now() - t0;
  }
}

/**
 * Runs `fn` inside a new trace (or as a span, if a trace is already active) and saves the trace when it
 * finishes, whether it succeeded or failed. Saving never throws: tracing must not break the request.
 */
export async function withTrace<T>(
  root: { name: string; channel: Channel; kind?: SpanKind; orgId?: string | null; workspaceId?: string | null; actor?: string | null; detached?: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  // `detached`: always a new trace, for work that runs after the response was sent (Next.js after()).
  if (store.getStore() && !root.detached) return span(root.kind ?? "request", root.name, fn);
  const t: TraceState = {
    id: newId(), name: root.name, channel: root.channel, startedAt: Date.now(), orgId: root.orgId ?? null, workspaceId: root.workspaceId ?? null,
    actor: root.actor ?? null, userId: null, spans: [], dbQueries: 0, dbMs: 0, status: "ok", httpStatus: null, error: null, ref: null,
  };
  const rootSpan: SpanRecord = { id: newId(), parentId: null, kind: root.kind ?? "request", name: root.name, start: 0, duration: 0, status: "ok", attrs: {} };
  t.spans.push(rootSpan);
  try {
    return await store.run({ trace: t, spanId: rootSpan.id }, fn);
  } catch (e) {
    if (t.status === "ok") traceFailed(500, "Failed unexpectedly", undefined, { reason: failureReason(e) });
    throw e;
  } finally {
    rootSpan.duration = Date.now() - t.startedAt;
    rootSpan.status = t.status;
    rootSpan.attrs.db_queries = t.dbQueries;
    rootSpan.attrs.db_ms = Math.round(t.dbMs);
    void saveTrace(t);
  }
}

/** Writes a finished trace and its spans (only traces that belong to an org), and prunes old ones. */
async function saveTrace(t: TraceState) {
  if (!t.orgId) return;
  try {
    const { run } = await import("./db"); // lazy: db.ts imports this file for countDbQuery
    const duration = t.spans[0]?.duration ?? 0;
    await run(
      `INSERT INTO traces (id, org_id, workspace_id, channel, name, actor, status, http_status, error, ref, duration_ms, span_count, db_queries, db_ms, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id, t.orgId, t.workspaceId, t.channel, t.name, t.actor, t.status, t.httpStatus, t.error, t.ref, duration, t.spans.length, t.dbQueries, Math.round(t.dbMs), new Date(t.startedAt).toISOString(),
    );
    for (const s of t.spans) {
      await run(
        "INSERT INTO trace_spans (trace_id, span_id, parent_id, kind, name, start_ms, duration_ms, status, error, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        t.id, s.id, s.parentId, s.kind, s.name, s.start, s.duration, s.status, s.error ?? null, JSON.stringify(s.attrs),
      );
    }
    if (Math.random() < 0.02) {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
      await run("DELETE FROM trace_spans WHERE trace_id IN (SELECT id FROM traces WHERE started_at < ?)", cutoff);
      await run("DELETE FROM traces WHERE started_at < ?", cutoff);
    }
  } catch (e) {
    console.error("Couldn't save trace", e);
  }
}
