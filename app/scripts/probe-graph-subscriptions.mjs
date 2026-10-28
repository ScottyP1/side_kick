/**
 * @file Probe: why Microsoft Graph refuses Sidekick's meeting-transcript subscriptions (job `meetings.subscription`,
 * lib/meetings-graph.ts `ensureSubscription`; docs/RUNBOOKS.md → Automatic meeting notes). Run it as Sidekick's own
 * app (app-only token, like the live server) and paste the output. It prints Graph's error code and message, never
 * a token, secret or client state.
 *
 * What it does, in order:
 * 1. Lists the app's Graph subscriptions in the tenant (`GET /v1.0/subscriptions`): id, resource, expiry, where they
 *    point. Shows duplicates and leftovers. Read-only.
 * 2. Checks Sidekick's own notification addresses the way Graph does before it accepts a subscription: a POST to
 *    `{base}/api/graph/notifications?validationToken=…` and `/api/graph/lifecycle?validationToken=…` must answer
 *    200, text/plain, with the token echoed, within 10 seconds and without a redirect (Graph doesn't follow them).
 *    These two calls go to Sidekick, not Microsoft, and change nothing.
 * 3. Only with `--create`: the closest thing to a dry run Graph has. For each transcript resource it makes the same
 *    subscription request the live job makes, but lasting 45 minutes (Graph's shortest), and deletes it again at once.
 *    Graph's refusal (if any) is the answer to "why 400". Without `--create` nothing is written to Graph.
 *
 * Usage (secrets only from the environment, never on the command line or in chat; app/.env.local has them):
 *   node --env-file=app/.env.local app/scripts/probe-graph-subscriptions.mjs --tenant <tenant id> \
 *     --base https://<live site address> [--create]
 * Needs ENTRA_CLIENT_ID (or CLIENT_ID) and ENTRA_CLIENT_SECRET (or CLIENT_SECRET). `--base` is the live
 * SIDEKICK_PUBLIC_URL (no trailing slash). Exit code 0 even when Graph refuses: the refusals are the result.
 */
import crypto from "node:crypto";

const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : [])).filter(Boolean)[0];
const tenant = opt("tenant");
const base = (opt("base") ?? "").replace(/\/+$/, "");
const create = args.includes("--create");
const clientId = process.env.ENTRA_CLIENT_ID || process.env.CLIENT_ID;
const clientSecret = process.env.ENTRA_CLIENT_SECRET || process.env.CLIENT_SECRET;
if (!tenant || !base || !clientId || !clientSecret) {
  console.error("Usage: node --env-file=app/.env.local app/scripts/probe-graph-subscriptions.mjs --tenant <id> --base https://<site> [--create]\n(needs ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET in the environment)");
  process.exit(2);
}
const GRAPH = "https://graph.microsoft.com/v1.0";
const RESOURCES = ["communications/onlineMeetings/getAllTranscripts", "communications/adhocCalls/getAllTranscripts"];

/** Graph's error as one safe line: code, inner code, message (token-like runs hidden). */
const why = (b) =>
  [b?.error?.code, b?.error?.innerError?.code, String(b?.error?.message ?? "").replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[hidden]").slice(0, 300)]
    .filter(Boolean)
    .join(" | ");

/** An app-only Graph token for the tenant (never printed; only the permission names it carries). */
async function token() {
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
  });
  const b = await r.json();
  if (!b.access_token) throw new Error(`No token: ${b.error} ${String(b.error_description ?? "").split("\n")[0]}`);
  const claims = JSON.parse(Buffer.from(b.access_token.split(".")[1], "base64url").toString());
  console.log(`Token roles: ${(claims.roles ?? []).sort().join(", ") || "(none)"}\n`);
  return b.access_token;
}

/** One Graph call: { status, body }. */
async function graph(tok, method, path, body) {
  const r = await fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: r.status, body: json };
}

/** Step 2: Graph's validation handshake against one of Sidekick's addresses. */
async function handshake(path) {
  const value = `probe-${crypto.randomBytes(8).toString("hex")}`;
  const started = Date.now();
  try {
    const r = await fetch(`${base}${path}?validationToken=${value}`, { method: "POST", headers: { "Content-Type": "text/plain" }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    const ms = Date.now() - started;
    const ok = r.status === 200 && text === value && (r.headers.get("content-type") ?? "").startsWith("text/plain");
    console.log(`  ${path}: ${r.status} in ${ms} ms, ${r.headers.get("content-type") ?? "no content type"}${r.headers.get("location") ? `, redirects to ${r.headers.get("location")}` : ""} → ${ok ? "OK" : "FAILS Graph's check"}`);
  } catch (e) {
    console.log(`  ${path}: no answer within 10 s (${e instanceof Error ? e.message : e}) → FAILS Graph's check`);
  }
}

const tok = await token();

console.log("1. Subscriptions this app has in the tenant:");
const list = await graph(tok, "GET", "/subscriptions");
if (list.status !== 200) console.log(`  ${list.status} ${why(list.body)}`);
else if (!list.body.value?.length) console.log("  (none)");
else {
  for (const s of list.body.value) {
    const left = Math.round((new Date(s.expirationDateTime).getTime() - Date.now()) / 60_000);
    console.log(`  - ${s.id} ${s.resource} expires ${s.expirationDateTime} (${left} min left) → ${s.notificationUrl} | lifecycle ${s.lifecycleNotificationUrl ?? "(none)"}`);
  }
  for (const r of RESOURCES) {
    const n = list.body.value.filter((s) => s.resource === r).length;
    if (n > 1) console.log(`  ! ${n} subscriptions on ${r} (Sidekick keeps one)`);
  }
}

console.log(`\n2. Graph's validation handshake against ${base}:`);
await handshake("/api/graph/notifications");
await handshake("/api/graph/lifecycle");

if (!create) {
  console.log("\n3. Skipped (add --create to make and delete one short test subscription per resource).");
} else {
  console.log("\n3. Test subscriptions (45 minutes, deleted straight away):");
  for (const resource of RESOURCES) {
    const made = await graph(tok, "POST", "/subscriptions", {
      changeType: "created",
      notificationUrl: `${base}/api/graph/notifications`,
      lifecycleNotificationUrl: `${base}/api/graph/lifecycle`,
      resource,
      expirationDateTime: new Date(Date.now() + 45 * 60_000).toISOString(),
      clientState: crypto.randomBytes(32).toString("base64url"),
      latestSupportedTlsVersion: "v1_2",
    });
    if (made.status !== 201) {
      console.log(`  ${resource}: ${made.status} ${why(made.body)}`);
      continue;
    }
    const gone = await graph(tok, "DELETE", `/subscriptions/${encodeURIComponent(made.body.id)}`);
    console.log(`  ${resource}: 201 created, then deleted (${gone.status})`);
  }
}
