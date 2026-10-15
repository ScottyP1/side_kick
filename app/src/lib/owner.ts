import "server-only";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { get, newId, now, run } from "./db";
import { hashPassword, HttpError, verifyPassword } from "./auth";

// Owner Console auth: platform operators sign in separately from client users,
// with their own cookie, so a client account can never reach the console.
export const OWNER_COOKIE = "sk_owner";
const SESSION_HOURS = 12;

export type Owner = { id: string; name: string; email: string };

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function ownerExists() {
  return Boolean(get("SELECT id FROM platform_admins LIMIT 1"));
}

// First owner can only be created from the machine running Sidekick (localhost).
export async function assertLocalRequest() {
  const host = (await headers()).get("host") ?? "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    throw new HttpError(403, "The first owner account can only be created on the machine running Sidekick (localhost).");
  }
}

export function createOwner(name: string, email: string, password: string) {
  const id = newId();
  run("INSERT INTO platform_admins (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", id, name, email.toLowerCase(), hashPassword(password), now());
  return id;
}

export function checkOwnerPassword(email: string, password: string): Owner | null {
  const row = get<Owner & { password_hash: string }>("SELECT id, name, email, password_hash FROM platform_admins WHERE email = ?", email.trim().toLowerCase());
  return row && verifyPassword(password, row.password_hash) ? { id: row.id, name: row.name, email: row.email } : null;
}

export async function startOwnerSession(ownerId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
  run("INSERT INTO owner_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)", sha256(token), ownerId, expires.toISOString());
  run("UPDATE platform_admins SET last_active = ? WHERE id = ?", now(), ownerId);
  (await cookies()).set(OWNER_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", expires });
}

export async function endOwnerSession() {
  const jar = await cookies();
  const token = jar.get(OWNER_COOKIE)?.value;
  if (token) run("DELETE FROM owner_sessions WHERE token_hash = ?", sha256(token));
  jar.delete(OWNER_COOKIE);
}

export async function requireOwner(): Promise<Owner> {
  const token = (await cookies()).get(OWNER_COOKIE)?.value;
  const row = token
    ? get<Owner & { expires_at: string }>(
        "SELECT a.id, a.name, a.email, s.expires_at FROM owner_sessions s JOIN platform_admins a ON a.id = s.admin_id WHERE s.token_hash = ?",
        sha256(token),
      )
    : undefined;
  if (!row || new Date(row.expires_at) < new Date()) throw new HttpError(401, "Sign in to the Owner Console.");
  return { id: row.id, name: row.name, email: row.email };
}

export function platformLog(actor: string, action: string) {
  run("INSERT INTO platform_log (actor, action, created_at) VALUES (?, ?, ?)", actor, action, now());
}

/* ---------- Kill switches ---------- */
export const FLAGS = {
  ask: { label: "Answering questions", help: "Ask Sidekick in every workspace" },
  extract: { label: "Meeting notes", help: "Processing imported transcripts" },
  insights: { label: "Knowledge map", help: "Topics, coverage and gap detection" },
  uploads: { label: "Document uploads", help: "New files from any client" },
} as const;
export type FlagKey = keyof typeof FLAGS;

export function flagEnabled(key: FlagKey): boolean {
  const row = get<{ enabled: number }>("SELECT enabled FROM platform_flags WHERE key = ?", key);
  return row ? row.enabled === 1 : true;
}

export function assertEnabled(key: FlagKey) {
  if (!flagEnabled(key)) throw new HttpError(503, `${FLAGS[key].label} is paused by the Sidekick team. Try again later.`);
}
