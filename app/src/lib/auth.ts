import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { all, get, newId, now, run } from "./db";

export const SESSION_COOKIE = "sk_session";
const SESSION_DAYS = 7;

export const ROLES = ["Org Owner", "Org Admin", "Billing Admin", "Member", "Viewer"] as const;
export type Role = (typeof ROLES)[number];

export type User = {
  id: string;
  org_id: string;
  name: string;
  email: string;
  role: Role;
  must_change_password: number;
};

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(keyHex, "hex");
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export async function startSession(userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", sha256(token), userId, expires.toISOString());
  run("UPDATE users SET last_active = ? WHERE id = ?", now(), userId);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  jar.delete(SESSION_COOKIE);
}

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = get<User & { expires_at: string }>(
    `SELECT u.id, u.org_id, u.name, u.email, u.role, u.must_change_password, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!row || new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, org_id: row.org_id, name: row.name, email: row.email, role: row.role, must_change_password: row.must_change_password };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requireUser(roles?: readonly Role[]): Promise<User> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in to continue.");
  if (roles && !roles.includes(user.role)) throw new HttpError(403, "Your role doesn't allow this. Ask an Org Admin.");
  return user;
}

export const isAdmin = (u: User) => u.role === "Org Owner" || u.role === "Org Admin";
export const canEdit = (u: User) => u.role !== "Viewer" && u.role !== "Billing Admin";

// Workspace walls: admins see every workspace in their org; everyone else only the ones they belong to.
export function workspaceIdsFor(user: User): string[] {
  if (isAdmin(user)) return all<{ id: string }>("SELECT id FROM workspaces WHERE org_id = ?", user.org_id).map((r) => r.id);
  return all<{ workspace_id: string }>(
    `SELECT wm.workspace_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ? AND w.org_id = ?`,
    user.id,
    user.org_id,
  ).map((r) => r.workspace_id);
}

export function requireWorkspace(user: User, workspaceId: string | null | undefined): string {
  if (!workspaceId || !workspaceIdsFor(user).includes(workspaceId)) {
    throw new HttpError(404, "Workspace not found, or you're not a member of it.");
  }
  return workspaceId;
}

export function audit(user: Pick<User, "org_id" | "name"> | null, action: string, kind: string, workspaceId: string | null = null) {
  run(
    "INSERT INTO audit_log (org_id, actor, action, kind, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    user?.org_id ?? null,
    user?.name ?? "System",
    action,
    kind,
    workspaceId,
    now(),
  );
}

export function auditAsSidekick(orgId: string, action: string, kind: string, workspaceId: string | null = null) {
  audit({ org_id: orgId, name: "Sidekick" }, action, kind, workspaceId);
}

export function createUser(orgId: string, name: string, email: string, role: Role, password: string, mustChange: boolean) {
  const id = newId();
  run(
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
