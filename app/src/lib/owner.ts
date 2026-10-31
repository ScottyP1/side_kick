/**
 * @file The Owner Console's sign-in and the platform-wide kill switches.
 *
 * Concepts
 * - **Owner (platform operator)**: the person running Sidekick as a service, not a client user. Owners see
 *   every client organization's usage and health, but sign in separately with their own `sk_owner` cookie,
 *   so a client account can never reach the console (and an owner session can't act inside a client org).
 * - **Sign in with Microsoft** (the normal way in): the operator signs in with their Microsoft account. Only the
 *   accounts listed in `SIDEKICK_OWNER_MS_ACCOUNTS` get in, each named by tenant id + object id (`tid:oid`,
 *   comma-separated), read from the verified ID token, never by email (an email can be renamed or reused; the
 *   pair can't). Any other account gets the same plain refusal and an operator-log entry. The first sign-in links
 *   the account to the owner row with the same email, or creates one (no setup code needed). Microsoft's own
 *   rules (security defaults: MFA for admins) do the strong check; when the ID token lists how they signed in
 *   (`amr`) it must include MFA (`ownerMfaEvidence`). If the owner registered a passkey, it's asked for too.
 * - **Other ways to sign in** (fallback for recovery and localhost): email + password, and the one-time setup
 *   below for the very first account.
 * - **First owner from localhost**: the very first password account can only be created on the machine
 *   running Sidekick (or with the one-time setup code), so nobody on the internet can claim the console.
 * - **Kill switches (flags)**: owners can pause a feature (answering, meeting notes, knowledge map,
 *   uploads) for every client at once, e.g. during an incident or a cost spike. Code checks them with
 *   `assertEnabled` before doing that work.
 * - **Per-organization switches** (`org_flags`): the same features can also be turned off for one client
 *   only (a restriction set on that client's page in the Owner Console). A feature runs only when both
 *   the platform-wide switch and that organization's switch are on.
 * - **Platform-only switches**: `signup` (self-service sign-up at /signup) is a switch for the whole platform
 *   that has no per-client meaning, so it's marked `platformOnly` and left out of the per-client list.
 * - **Defaults**: an untouched switch is on, except `signup`, which is **off** until someone opens it (it
 *   lets strangers create organizations that use real Claude credit). Its default comes from
 *   `SIDEKICK_SIGNUP_OPEN=true` (to open it with a deploy); the operator's switch, once flipped, always wins.
 * - **Billing**: a client whose plan has lapsed (lib/plans.ts `accessFor`) is refused new AI work by
 *   `assertEnabled` too, as a restriction, so the portal, Teams and reminders all stop the same way.
 * - **Operator log**: owner actions are recorded in `platform_log`, separate from each client's audit log.
 * - **Temporary password**: `npm run reset-password -- --owner <email>` (scripts/reset-password.mjs, run by
 *   whoever has the database) gives an owner a one-time password (`must_change_password`). Until they pick
 *   their own, `requireOwner` refuses everything except the password change.
 * - **Strict cookie after Microsoft sign-in**: `sk_owner` is `sameSite: "strict"`, so a browser doesn't send it on a
 *   navigation whose redirect chain started on another site. Microsoft's reply starts at login.microsoftonline.com,
 *   so a plain 302 from the callback to /owner arrived without the new cookie and bounced to /owner/login once.
 *   The callback therefore answers with a tiny page on our own site (`sameSiteHandoff`) that then opens /owner: that
 *   second navigation starts on Sidekick, so the strict cookie goes with it. The cookie itself stays strict.
 * - **Sign-in limit**: owner sign-in uses the same failure limit as the portal (lib/login-limit.ts), counted
 *   under `owner:<email>` so it never mixes with a portal account of the same email.
 */
import "server-only";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { get, markRequestSystem, newId, now, run } from "./db";
import { DUMMY_HASH, hashPassword, HttpError, verifyPassword } from "./auth";
import { orgAccess } from "./billing";
import { entraConfigured, type MicrosoftIdentity } from "./entra";
import { setupRefusal } from "./security";
import { BRAND } from "./brand";

// Owner sessions are shorter than client sessions (12 hours) because the console sees every client.
export const OWNER_COOKIE = "sk_owner";
const SESSION_HOURS = 12;

/** A signed-in platform operator. `must_change_password` is 1 while they still have a temporary password. */
export type Owner = { id: string; name: string; email: string; must_change_password: number };

/** The refusal while an owner still has a temporary password; the sign-in page shows the change step instead. */
export const OWNER_PASSWORD_CHANGE_REQUIRED = "Change your temporary password first. Then you can use the Owner Console.";


const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** True once the first owner account exists (setup is then closed). */
export async function ownerExists() {
  return Boolean(await get("SELECT id FROM platform_admins LIMIT 1"));
}

/**
 * Throws 403 unless a one-time setup may go ahead (see `setupRefusal`). Used by the first owner account
 * (/api/owner/auth/setup) and first-run setup of the first organization (/api/auth/setup).
 *
 * @param sentCode the `setupCode` from the request body
 * @param message what to tell someone who tried from elsewhere than localhost (no setup code configured)
 */
export async function assertSetupAllowed(sentCode: unknown, message = `The first owner account can only be created on the machine running ${BRAND.name} (localhost).`) {
  const refusal = setupRefusal({
    production: process.env.NODE_ENV === "production",
    code: process.env.SIDEKICK_SETUP_CODE ?? "",
    sent: sentCode,
    host: (await headers()).get("host") ?? "",
    message,
  });
  if (refusal) throw new HttpError(403, refusal);
}

/** Whether setup needs a code (so the setup pages show the "Setup code" field). */
export const setupNeedsCode = () => Boolean(process.env.SIDEKICK_SETUP_CODE) || process.env.NODE_ENV === "production";

/** Creates an owner account (password stored as an scrypt hash). */
export async function createOwner(name: string, email: string, password: string) {
  const id = newId();
  await run("INSERT INTO platform_admins (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", id, name, email.toLowerCase(), hashPassword(password), now());
  return id;
}

/**
 * Returns the owner if the email and password match, otherwise null. `exists` says whether the email
 * belongs to an owner at all (for the operator log; never shown to the caller). An unknown email is checked
 * against a dummy hash so both answers take the same time.
 */
export async function checkOwnerPassword(email: string, password: string): Promise<{ owner: Owner | null; exists: boolean }> {
  const row = await get<Owner & { password_hash: string }>(
    "SELECT id, name, email, password_hash, must_change_password FROM platform_admins WHERE email = ?",
    email.trim().toLowerCase(),
  );
  const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  return {
    owner: row && ok ? { id: row.id, name: row.name, email: row.email, must_change_password: Number(row.must_change_password) } : null,
    exists: Boolean(row),
  };
}

/* ---------- Sign in with Microsoft ---------- */
/** The cookie carrying an Owner Console Microsoft round trip's state (separate from the portal's `sk_oidc`). */
export const OWNER_OIDC_COOKIE = "sk_owner_oidc";

/** The one refusal for any Microsoft account that isn't an allowed operator (says nothing about who is). */
export const OWNER_MS_REFUSED = "This Microsoft account can't sign in to the Owner Console.";

/** One Microsoft account allowed into the Owner Console: tenant id + object id, lower case. */
export type OwnerMicrosoftAccount = { tid: string; oid: string };

/**
 * The Microsoft accounts allowed into the Owner Console, from `SIDEKICK_OWNER_MS_ACCOUNTS` ("tid:oid,tid:oid").
 * Entries that aren't two ids separated by ":" are skipped (and said so in the server log), never guessed at.
 */
export function ownerMicrosoftAccounts(): OwnerMicrosoftAccount[] {
  const out: OwnerMicrosoftAccount[] = [];
  for (const entry of (process.env.SIDEKICK_OWNER_MS_ACCOUNTS ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const [tid, oid, extra] = entry.toLowerCase().split(":").map((x) => x.trim());
    if (!tid || !oid || extra !== undefined || !/^[0-9a-f-]{36}$/.test(tid)) {
      console.error("SIDEKICK_OWNER_MS_ACCOUNTS: skipped an entry that isn't tenantId:objectId");
      continue;
    }
    out.push({ tid, oid });
  }
  return out;
}

/** True when the Owner Console offers "Sign in with Microsoft": the Entra app is set up and at least one account is listed. */
export const ownerMicrosoftEnabled = () => entraConfigured() && ownerMicrosoftAccounts().length > 0;

/** Whether this verified Microsoft identity is one of the allowed operator accounts (exact tenant and object id). */
export function ownerMicrosoftAllowed(who: Pick<MicrosoftIdentity, "tenantId" | "objectId">): boolean {
  const tid = who.tenantId.toLowerCase();
  const oid = who.objectId.toLowerCase();
  return ownerMicrosoftAccounts().some((a) => a.tid === tid && a.oid === oid);
}

/** The `amr` values that mean Microsoft checked more than a password (MFA, Windows Hello, passkey/FIDO key). */
const MFA_METHODS = ["mfa", "ngcmfa", "mngcmfa", "fido"];

/**
 * What the ID token says about MFA: "mfa" (it lists a strong method), "none" (it lists methods, but only weak
 * ones such as a password: refused) or "unknown" (no `amr` at all; Microsoft's v2.0 ID tokens usually leave it
 * out, and then the tenant's own rules are relied on: security defaults require MFA for every admin sign-in).
 */
export function ownerMfaEvidence(amr: string[] | null | undefined): "mfa" | "none" | "unknown" {
  if (!amr || !amr.length) return "unknown";
  return amr.some((m) => MFA_METHODS.includes(m.toLowerCase())) ? "mfa" : "none";
}

/**
 * The owner row for an allowed Microsoft account (call `ownerMicrosoftAllowed` first): the row already linked to
 * this tid + oid; else the unlinked row with the same email, which is linked now; else a new row with the name
 * and email from the token (so no setup code is needed). A new row gets a random password nobody knows: the
 * password way in stays closed until `npm run reset-password -- --owner <email>`. A pending temporary password
 * is retired the same way, since Microsoft now proves who this is.
 */
export async function ownerForMicrosoft(who: MicrosoftIdentity): Promise<{ owner: Owner; created: boolean; linked: boolean }> {
  const cols = "id, name, email, must_change_password";
  const tid = who.tenantId.toLowerCase();
  const oid = who.objectId.toLowerCase();
  let row = await get<Owner>(`SELECT ${cols} FROM platform_admins WHERE entra_tid = ? AND entra_oid = ?`, tid, oid);
  let created = false;
  let linked = false;
  const email = (who.email || `${oid}@${tid}`).toLowerCase().slice(0, 200);
  if (!row) {
    row = await get<Owner>(`SELECT ${cols} FROM platform_admins WHERE email = ? AND entra_oid IS NULL`, email);
    if (row) {
      await run("UPDATE platform_admins SET entra_tid = ?, entra_oid = ? WHERE id = ?", tid, oid, row.id);
      linked = true;
    }
  }
  if (!row) {
    if (await get("SELECT id FROM platform_admins WHERE email = ?", email)) {
      // The email belongs to an owner already linked to a different Microsoft account: never merge the two.
      throw new HttpError(409, "This Microsoft account can't be linked to an owner account automatically. See RUNBOOKS: Owner Console sign-in.");
    }
    const id = newId();
    const name = (who.name || email).slice(0, 120);
    await run(
      "INSERT INTO platform_admins (id, name, email, password_hash, created_at, entra_tid, entra_oid) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, name, email, hashPassword(crypto.randomBytes(32).toString("base64url")), now(), tid, oid,
    );
    row = { id, name, email, must_change_password: 0 };
    created = true;
  }
  if (Number(row.must_change_password)) {
    await run("UPDATE platform_admins SET password_hash = ?, must_change_password = 0 WHERE id = ?", hashPassword(crypto.randomBytes(32).toString("base64url")), row.id);
  }
  return { owner: { ...row, must_change_password: 0 }, created, linked };
}

/** Signs an owner in: session row + `sk_owner` cookie (httpOnly, sameSite strict, 12 hours). */
export async function startOwnerSession(ownerId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await run("INSERT INTO owner_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)", sha256(token), ownerId, expires.toISOString());
  await run("UPDATE platform_admins SET last_active = ? WHERE id = ?", now(), ownerId);
  (await cookies()).set(OWNER_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", expires });
}

/**
 * The answer to a sign-in that came back from another site (Microsoft): a tiny page on our own site that opens
 * `path` straight away (script, with a meta refresh and a plain link as fallbacks). Use it instead of a redirect
 * when the next page needs a `sameSite: "strict"` cookie just set (`sk_owner`): a redirect chain that began on
 * login.microsoftonline.com counts as cross-site, so the browser would leave the strict cookie off; this second
 * navigation starts on Sidekick and carries it. `path` must be one of our own fixed paths (starts with one "/");
 * anything else falls back to /owner. Not cached, never framed, no referrer. Called by the Owner Console's Microsoft
 * callback only.
 */
export function sameSiteHandoff(path: string): Response {
  const target = /^\/(?!\/)[\w\-/?=&.]*$/.test(path) ? path : "/owner";
  const attr = target.replace(/&/g, "&amp;");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
    `<meta http-equiv="refresh" content="0;url=${attr}"><title>Signing you in…</title></head>` +
    `<body><p>Signing you in… <a href="${attr}">Continue</a></p><script>location.replace(${JSON.stringify(target)})</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-sidekick-handoff": target },
  });
}

/** Signs the owner out on this browser. */
export async function endOwnerSession() {
  const jar = await cookies();
  const token = jar.get(OWNER_COOKIE)?.value;
  if (token) await run("DELETE FROM owner_sessions WHERE token_hash = ?", sha256(token));
  jar.delete(OWNER_COOKIE);
}

/**
 * Returns the signed-in owner or throws 401. First line of every `/api/owner/*` route. While the owner still
 * has a temporary password it throws 403, except for the password change (`allowPendingPassword`).
 */
export async function requireOwner(opts: { allowPendingPassword?: boolean } = {}): Promise<Owner> {
  const token = (await cookies()).get(OWNER_COOKIE)?.value;
  const row = token
    ? await get<Owner & { expires_at: string }>(
        "SELECT a.id, a.name, a.email, a.must_change_password, s.expires_at FROM owner_sessions s JOIN platform_admins a ON a.id = s.admin_id WHERE s.token_hash = ?",
        sha256(token),
      )
    : undefined;
  if (!row || new Date(row.expires_at) < new Date()) throw new HttpError(401, "Sign in to the Owner Console.");
  const owner = { id: row.id, name: row.name, email: row.email, must_change_password: Number(row.must_change_password) };
  if (owner.must_change_password && !opts.allowPendingPassword) throw new HttpError(403, OWNER_PASSWORD_CHANGE_REQUIRED);
  // The Owner Console looks across every organization by design: the rest of this request is system work
  // (lib/db.ts markRequestSystem), named here once instead of in each of its routes.
  markRequestSystem("Owner Console");
  return owner;
}

/** Records an owner action in the operator log (shown on Releases & switches). */
export async function platformLog(actor: string, action: string) {
  await run("INSERT INTO platform_log (actor, action, created_at) VALUES (?, ?, ?)", actor, action, now());
}

/* ---------- Kill switches ---------- */
/** Every feature an owner can pause, with the label and help text shown in the Owner Console. */
export const FLAGS = {
  ask: { label: "Answering questions", help: `Ask ${BRAND.name} in every workspace` },
  extract: { label: "Meeting notes", help: "Processing imported transcripts" },
  insights: { label: "Knowledge map", help: "Topics, coverage and gap detection" },
  assist: { label: "In-app assistant", help: "The chat box on the home page" },
  guard: { label: "Guardrail check", help: `Checks every question first. Pausing it also pauses answers: ${BRAND.name} never answers unchecked` },
  uploads: { label: "Document uploads", help: "New files from any client" },
  remind: { label: "Reminders in Teams", help: "Daily and after-meeting reminder cards posted to Teams chats" },
  support: { label: "Support assistant", help: "The signed-in Help chat that checks a customer's setup and opens tickets. Paused: people can still contact support with the form" },
  helpbot: { label: "Public help bot", help: "“Ask about Sidekick” on the website. Paused: visitors see the FAQ and the contact form instead", platformOnly: true },
  watch: { label: "Watchers' AI checks", help: "The background checks' AI step, e.g. whether a newer decision makes a document out of date. Paused: the other checks keep running; nothing new is judged by AI" },
  followup: { label: "Follow-up questions", help: "Rewrites a follow-up (“and wave 3?”) into a full question in the assistants, Ask and Teams answers. Paused: every message is treated as a new question", platformOnly: true },
  live: { label: "Live in meetings", help: `${BRAND.name} joining Teams meetings live (Enterprise). Paused: no new meetings are joined and running ones leave` },
  signup: { label: "Self-service sign-up", help: "New companies creating an organization at /signup (test-mode payment). Off by default: only you add clients", platformOnly: true },
} as const;
export type FlagKey = keyof typeof FLAGS;
/** True for switches that only exist platform-wide (no per-client restriction), e.g. `signup`. */
export const isPlatformOnly = (key: FlagKey) => "platformOnly" in FLAGS[key];

/**
 * Whether a switch is on when nobody has flipped it yet: on for every feature, except self-service sign-up,
 * which is off unless the deploy sets `SIDEKICK_SIGNUP_OPEN=true`.
 */
export function flagDefault(key: FlagKey): boolean {
  if (key === "signup") return process.env.SIDEKICK_SIGNUP_OPEN === "true";
  return true;
}

/** Whether a feature is on: the operator's switch if it was ever flipped, otherwise `flagDefault`. */
export async function flagEnabled(key: FlagKey): Promise<boolean> {
  const row = await get<{ enabled: number }>("SELECT enabled FROM platform_flags WHERE key = ?", key);
  return row ? row.enabled === 1 : flagDefault(key);
}

/** Whether a feature is on for one organization (its own switch only). Untouched counts as on. */
export async function orgFlagEnabled(orgId: string, key: FlagKey): Promise<boolean> {
  const row = await get<{ enabled: number }>("SELECT enabled FROM org_flags WHERE org_id = ? AND flag_key = ?", orgId, key);
  return row ? row.enabled === 1 : true;
}

/** Every switch for one organization: its own setting plus whether the platform-wide one is on. */
export async function orgFlags(orgId: string) {
  return Promise.all((Object.keys(FLAGS) as FlagKey[]).filter((key) => !isPlatformOnly(key)).map(async (key) => ({
    key, ...FLAGS[key], enabled: await orgFlagEnabled(orgId, key), platformEnabled: await flagEnabled(key),
  })));
}

/**
 * A feature someone deliberately turned off: `paused` (a kill switch, for every client, temporary),
 * `restricted` (turned off for one organization on its Owner Console page), or `credit` (an extra paused
 * because the organization used this month's AI credit, lib/credit.ts). It's a refusal, not a fault:
 * `handle()` answers with status 503 and `{ error, kind }`, doesn't log it under App errors and doesn't count
 * it as a failed request or a Claude error; the portal shows it as a notice (components/ui.tsx).
 */
export class FeatureOffError extends HttpError {
  constructor(public reason: "paused" | "restricted" | "credit", message: string) {
    super(503, message);
  }
}

/**
 * Throws `FeatureOffError` if the owner has paused this feature for everyone or (with `orgId`) turned it off
 * for that organization, or that organization's plan has lapsed (read-only, see lib/billing.ts). Call it
 * before starting that work; pass the org whenever the work belongs to one.
 *
 * @param role the reader's role, when known, so the restriction says what *they* can do: an Org Owner is told
 *   to contact the Sidekick team, everyone else to ask their Org Owner. Without it (Teams, background work)
 *   the message just says what happened.
 */
export async function assertEnabled(key: FlagKey, orgId?: string | null, role?: string | null) {
  if (!(await flagEnabled(key))) throw new FeatureOffError("paused", `${FLAGS[key].label} is paused by the ${BRAND.name} team. Try again later.`);
  if (orgId && !(await orgFlagEnabled(orgId, key))) {
    throw new FeatureOffError("restricted", restrictedMessage(FLAGS[key].label, role));
  }
  if (orgId) {
    const access = await orgAccess(orgId);
    if (access.mode === "read_only") throw new FeatureOffError("restricted", access.reason!);
  }
}

/** The wording for a feature turned off for one organization, fitted to who reads it. */
export function restrictedMessage(label: string, role?: string | null) {
  const base = `${label} is turned off for your organization by the ${BRAND.name} team.`;
  if (!role) return base;
  return role === "Org Owner"
    ? `${base} To have it turned back on, contact the ${BRAND.name} team.`
    : `${base} Your Org Owner can ask the ${BRAND.name} team to turn it back on.`;
}
