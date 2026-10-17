/**
 * @file Sign-in, roles and workspace walls for the client portal.
 *
 * Concepts
 * - **Session**: after sign-in the browser gets an `sk_session` cookie holding a random token. The
 *   database stores only a hash of it, so a leaked database can't be used to sign in. Sessions last 7 days.
 * - **Roles** decide what a user may do inside their org:
 *   - Org Owner / Org Admin: everything, including users, workspaces, Teams links and settings.
 *   - Billing Admin: usage and billing, but can't change content.
 *   - Member: works inside the workspaces they belong to (upload, import meetings, ask).
 *   - Viewer: read-only inside their workspaces.
 * - **Workspace walls**: a user only ever sees the workspaces they're a member of (admins see all in
 *   their org). Every API route that touches workspace data calls `requireWorkspace` first.
 * - **Audit log**: important actions are recorded with `await audit()` and shown on Security & audit.
 *
 * Production replaces passwords with Microsoft (Entra ID) sign-in; roles and walls stay the same.
 */
import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { all, get, newId, now, run } from "./db";
import { traceScope } from "./trace";

export const SESSION_COOKIE = "sk_session";
const SESSION_DAYS = 7;

/** Every role a portal user can have, from most to least access. */
export const ROLES = ["Org Owner", "Org Admin", "Billing Admin", "Member", "Viewer"] as const;
export type Role = (typeof ROLES)[number];

/** The signed-in portal user, as API routes see them. */
export type User = {
  id: string;
  org_id: string;
  name: string;
  email: string;
  role: Role;
  must_change_password: number;
};

/**
 * Hashes a password with scrypt (slow on purpose, so guessing is expensive) and a random salt.
 * Stored as `scrypt$<salt hex>$<key hex>`.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Checks a password against a stored hash, using a constant-time comparison to avoid timing leaks. */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(keyHex, "hex");
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Signs a user in: creates a session row and sets the `sk_session` cookie (httpOnly, 7 days). */
export async function startSession(userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", sha256(token), userId, expires.toISOString());
  await run("UPDATE users SET last_active = ? WHERE id = ?", now(), userId);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
}

/** Signs the current browser out: deletes its session row and clears the cookie. */
export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  jar.delete(SESSION_COOKIE);
}

/**
 * Returns the signed-in user for this request, or null if there is no valid session.
 * Throws 403 if the user's organization has been paused from the Owner Console.
 */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = await get<User & { expires_at: string; org_status: string }>(
    `SELECT u.id, u.org_id, u.name, u.email, u.role, u.must_change_password, s.expires_at, o.status AS org_status
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN orgs o ON o.id = u.org_id WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!row || new Date(row.expires_at) < new Date()) return null;
  if (row.org_status === "Suspended") throw new HttpError(403, "This organization's Sidekick access is paused. Contact the Sidekick team.");
  return { id: row.id, org_id: row.org_id, name: row.name, email: row.email, role: row.role, must_change_password: row.must_change_password };
}

/**
 * An error with an HTTP status and a message that is safe to show the user. API routes wrapped in
 * `handle()` (api.ts) turn it into a JSON `{ error }` response with that status.
 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Returns the signed-in user or throws 401. Pass `roles` to also require one of those roles (403 otherwise).
 * The first line of almost every API route.
 */
export async function requireUser(roles?: readonly Role[]): Promise<User> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in to continue.");
  traceScope({ orgId: user.org_id, actor: user.name, userId: user.id });
  if (roles && !roles.includes(user.role)) throw new HttpError(403, "Your role doesn't allow this. Ask an Org Admin.");
  return user;
}

/** Org Owners and Org Admins can manage users, workspaces, Teams links and settings. */
export const isAdmin = (u: User) => u.role === "Org Owner" || u.role === "Org Admin";
/** Everyone except Viewers and Billing Admins can change workspace content. */
export const canEdit = (u: User) => u.role !== "Viewer" && u.role !== "Billing Admin";

// Workspace walls: admins see every workspace in their org; everyone else only the ones they belong to.
export async function workspaceIdsFor(user: User): Promise<string[]> {
  if (isAdmin(user)) return (await all<{ id: string }>("SELECT id FROM workspaces WHERE org_id = ?", user.org_id)).map((r) => r.id);
  return (await all<{ workspace_id: string }>(
    `SELECT wm.workspace_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ? AND w.org_id = ?`,
    user.id,
    user.org_id,
  )).map((r) => r.workspace_id);
}

/**
 * The workspace wall. Returns the workspace id if this user may use it; otherwise throws 404 (not 403,
 * so people can't tell whether a workspace they don't belong to exists). Call it before any query that
 * reads or writes workspace data, and use the returned id in that query.
 */
export async function requireWorkspace(user: User, workspaceId: string | null | undefined): Promise<string> {
  if (!workspaceId || !(await workspaceIdsFor(user)).includes(workspaceId)) {
    throw new HttpError(404, "Workspace not found, or you're not a member of it.");
  }
  traceScope({ workspaceId });
  return workspaceId;
}

/**
 * Records an action in the audit log. `kind` groups entries (Access, Data, Agent action, Policy change).
 * Pass `user = null` for system actions; use `auditAsSidekick` for things Sidekick did on its own.
 */
export async function audit(user: Pick<User, "org_id" | "name"> | null, action: string, kind: string, workspaceId: string | null = null) {
  await run(
    "INSERT INTO audit_log (org_id, actor, action, kind, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    user?.org_id ?? null,
    user?.name ?? "System",
    action,
    kind,
    workspaceId,
    now(),
  );
}

/** Records an action Sidekick took by itself (e.g. writing meeting notes), shown with "Sidekick" as the actor. */
export async function auditAsSidekick(orgId: string, action: string, kind: string, workspaceId: string | null = null) {
  await audit({ org_id: orgId, name: "Sidekick" }, action, kind, workspaceId);
}

/**
 * Creates a portal user. With `mustChange` the user has to pick a new password at first sign-in
 * (used when an admin creates the account with a one-time password).
 */
export async function createUser(orgId: string, name: string, email: string, role: Role, password: string, mustChange: boolean) {
  const id = newId();
  await run(
    "INSERT INTO users (id, org_id, name, email, role, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    orgId,
    name,
    email.toLowerCase(),
    role,
    hashPassword(password),
    mustChange ? 1 : 0,
    now(),
  );
  return id;
}
