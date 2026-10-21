/**
 * @file The Owner Console's sign-in and the platform-wide kill switches.
 *
 * Concepts
 * - **Owner (platform operator)**: the person running Sidekick as a service, not a client user. Owners see
 *   every client organization's usage and health, but sign in separately with their own `sk_owner` cookie,
 *   so a client account can never reach the console (and an owner session can't act inside a client org).
 * - **First owner from localhost**: the very first owner account can only be created on the machine
 *   running Sidekick, so nobody on the internet can claim the console on a fresh install.
 * - **Kill switches (flags)**: owners can pause a feature (answering, meeting notes, knowledge map,
 *   uploads) for every client at once, e.g. during an incident or a cost spike. Code checks them with
 *   `assertEnabled` before doing that work.
 * - **Per-organization switches** (`org_flags`): the same features can also be turned off for one client
 *   only (a restriction set on that client's page in the Owner Console). A feature runs only when both
 *   the platform-wide switch and that organization's switch are on.
 * - **Operator log**: owner actions are recorded in `platform_log`, separate from each client's audit log.
 */
import "server-only";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { get, newId, now, run } from "./db";
import { DUMMY_HASH, hashPassword, HttpError, verifyPassword } from "./auth";
import { setupRefusal } from "./security";

// Owner sessions are shorter than client sessions (12 hours) because the console sees every client.
export const OWNER_COOKIE = "sk_owner";
const SESSION_HOURS = 12;

/** A signed-in platform operator. */
export type Owner = { id: string; name: string; email: string };

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
export async function assertSetupAllowed(sentCode: unknown, message = "The first owner account can only be created on the machine running Sidekick (localhost).") {
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
  const row = await get<Owner & { password_hash: string }>("SELECT id, name, email, password_hash FROM platform_admins WHERE email = ?", email.trim().toLowerCase());
  const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  return { owner: row && ok ? { id: row.id, name: row.name, email: row.email } : null, exists: Boolean(row) };
}

/** Signs an owner in: session row + `sk_owner` cookie (httpOnly, sameSite strict, 12 hours). */
export async function startOwnerSession(ownerId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await run("INSERT INTO owner_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)", sha256(token), ownerId, expires.toISOString());
  await run("UPDATE platform_admins SET last_active = ? WHERE id = ?", now(), ownerId);
  (await cookies()).set(OWNER_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", expires });
}

/** Signs the owner out on this browser. */
export async function endOwnerSession() {
  const jar = await cookies();
  const token = jar.get(OWNER_COOKIE)?.value;
  if (token) await run("DELETE FROM owner_sessions WHERE token_hash = ?", sha256(token));
  jar.delete(OWNER_COOKIE);
}

/** Returns the signed-in owner or throws 401. First line of every `/api/owner/*` route. */
export async function requireOwner(): Promise<Owner> {
  const token = (await cookies()).get(OWNER_COOKIE)?.value;
  const row = token
    ? await get<Owner & { expires_at: string }>(
        "SELECT a.id, a.name, a.email, s.expires_at FROM owner_sessions s JOIN platform_admins a ON a.id = s.admin_id WHERE s.token_hash = ?",
        sha256(token),
      )
    : undefined;
  if (!row || new Date(row.expires_at) < new Date()) throw new HttpError(401, "Sign in to the Owner Console.");
  return { id: row.id, name: row.name, email: row.email };
}

/** Records an owner action in the operator log (shown on Releases & switches). */
export async function platformLog(actor: string, action: string) {
  await run("INSERT INTO platform_log (actor, action, created_at) VALUES (?, ?, ?)", actor, action, now());
}

/* ---------- Kill switches ---------- */
/** Every feature an owner can pause, with the label and help text shown in the Owner Console. */
export const FLAGS = {
  ask: { label: "Answering questions", help: "Ask Sidekick in every workspace" },
  extract: { label: "Meeting notes", help: "Processing imported transcripts" },
  insights: { label: "Knowledge map", help: "Topics, coverage and gap detection" },
  assist: { label: "In-app assistant", help: "The chat box on the home page" },
  guard: { label: "Guardrail check", help: "Checks every question first. Pausing it also pauses answers: Sidekick never answers unchecked" },
  uploads: { label: "Document uploads", help: "New files from any client" },
  remind: { label: "Reminders in Teams", help: "Daily and after-meeting reminder cards posted to Teams chats" },
} as const;
export type FlagKey = keyof typeof FLAGS;

/** Whether a feature is on. A switch nobody has touched yet counts as on. */
export async function flagEnabled(key: FlagKey): Promise<boolean> {
  const row = await get<{ enabled: number }>("SELECT enabled FROM platform_flags WHERE key = ?", key);
  return row ? row.enabled === 1 : true;
}

/** Whether a feature is on for one organization (its own switch only). Untouched counts as on. */
export async function orgFlagEnabled(orgId: string, key: FlagKey): Promise<boolean> {
  const row = await get<{ enabled: number }>("SELECT enabled FROM org_flags WHERE org_id = ? AND flag_key = ?", orgId, key);
  return row ? row.enabled === 1 : true;
}

/** Every switch for one organization: its own setting plus whether the platform-wide one is on. */
export async function orgFlags(orgId: string) {
  return Promise.all((Object.keys(FLAGS) as FlagKey[]).map(async (key) => ({
    key, ...FLAGS[key], enabled: await orgFlagEnabled(orgId, key), platformEnabled: await flagEnabled(key),
  })));
}

/**
 * A feature someone deliberately turned off: `paused` (a kill switch, for every client, temporary) or
 * `restricted` (turned off for one organization on its Owner Console page). It's a refusal, not a fault:
 * `handle()` answers with status 503 and `{ error, kind }`, doesn't log it under App errors and doesn't count
 * it as a failed request or a Claude error; the portal shows it as a notice (components/ui.tsx).
 */
export class FeatureOffError extends HttpError {
  constructor(public reason: "paused" | "restricted", message: string) {
    super(503, message);
  }
}

/**
 * Throws `FeatureOffError` if the owner has paused this feature for everyone or (with `orgId`) turned it off
 * for that organization. Call it before starting that work; pass the org whenever the work belongs to one.
 *
 * @param role the reader's role, when known, so the restriction says what *they* can do: an Org Owner is told
 *   to contact the Sidekick team, everyone else to ask their Org Owner. Without it (Teams, background work)
 *   the message just says what happened.
 */
export async function assertEnabled(key: FlagKey, orgId?: string | null, role?: string | null) {
  if (!(await flagEnabled(key))) throw new FeatureOffError("paused", `${FLAGS[key].label} is paused by the Sidekick team. Try again later.`);
  if (orgId && !(await orgFlagEnabled(orgId, key))) {
    throw new FeatureOffError("restricted", restrictedMessage(FLAGS[key].label, role));
  }
}

/** The wording for a feature turned off for one organization, fitted to who reads it. */
export function restrictedMessage(label: string, role?: string | null) {
  const base = `${label} is turned off for your organization by the Sidekick team.`;
  if (!role) return base;
  return role === "Org Owner"
    ? `${base} To have it turned back on, contact the Sidekick team.`
    : `${base} Your Org Owner can ask the Sidekick team to turn it back on.`;
}
