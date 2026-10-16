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
 * - **Operator log**: owner actions are recorded in `platform_log`, separate from each client's audit log.
 */
import "server-only";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { get, newId, now, run } from "./db";
import { hashPassword, HttpError, verifyPassword } from "./auth";

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

/** Throws 403 unless the request was made to localhost: the first owner can only be created on this machine. */
export async function assertLocalRequest() {
  const host = (await headers()).get("host") ?? "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    throw new HttpError(403, "The first owner account can only be created on the machine running Sidekick (localhost).");
  }
}

/** Creates an owner account (password stored as an scrypt hash). */
export async function createOwner(name: string, email: string, password: string) {
  const id = newId();
  await run("INSERT INTO platform_admins (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", id, name, email.toLowerCase(), hashPassword(password), now());
  return id;
}

/** Returns the owner if the email and password match, otherwise null. */
export async function checkOwnerPassword(email: string, password: string): Promise<Owner | null> {
  const row = await get<Owner & { password_hash: string }>("SELECT id, name, email, password_hash FROM platform_admins WHERE email = ?", email.trim().toLowerCase());
  return row && verifyPassword(password, row.password_hash) ? { id: row.id, name: row.name, email: row.email } : null;
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
  uploads: { label: "Document uploads", help: "New files from any client" },
} as const;
export type FlagKey = keyof typeof FLAGS;

/** Whether a feature is on. A switch nobody has touched yet counts as on. */
export async function flagEnabled(key: FlagKey): Promise<boolean> {
  const row = await get<{ enabled: number }>("SELECT enabled FROM platform_flags WHERE key = ?", key);
  return row ? row.enabled === 1 : true;
}

/** Throws a friendly 503 if the owner has paused this feature. Call it before starting that work. */
export async function assertEnabled(key: FlagKey) {
  if (!(await flagEnabled(key))) throw new HttpError(503, `${FLAGS[key].label} is paused by the Sidekick team. Try again later.`);
}
