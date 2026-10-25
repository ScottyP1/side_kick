/**
 * @file Sign-in, roles and workspace walls for the client portal.
 *
 * Concepts
 * - **Session**: after sign-in the browser gets an `sk_session` cookie holding a random token. The
 *   database stores only a hash of it, so a leaked database can't be used to sign in. Sessions last 7 days.
 * - **Roles** decide what a user may do inside their org:
 *   - Org Owner / Org Admin: everything, including users, workspaces, Teams links, settings and Usage &
 *     billing (only the Org Owner pays, changes the plan or cancels: `BILLING_ROLES` in lib/billing.ts).
 *   - Team Lead: a Member who also runs the people side of the workspaces they belong to (the ones they
 *     lead): adds people to those workspaces (as Member or Viewer), takes them off again, and links Teams
 *     chats to them. A Team Lead can't create workspaces or organizations, change roles, remove anyone
 *     from the organization, or see or touch any other workspace. Only Org Owners/Admins make Team Leads.
 *   - Member: works inside the workspaces they belong to (upload, import meetings, ask).
 *   - Viewer: read-only inside their workspaces.
 *   There used to be a Billing Admin role; it was retired in October 2026 (lib/db.ts `DATA_MIGRATIONS`
 *   turned everyone who had it into a Member and told the Org Owner).
 * - **Workspace walls**: a user only ever sees the workspaces they're a member of (admins see all in
 *   their org). Every API route that touches workspace data calls `requireWorkspace` first.
 * - **Audit log**: important actions are recorded with `await audit()` and shown on Security & audit.
 * - **Temporary password**: people added on Users & access get a one-time password (`must_change_password`).
 *   Until they pick their own, `requireUser` refuses every request except the few that opt in with
 *   `allowPendingPassword` (/api/me, the password change); signing out doesn't need a check. Microsoft sign-in clears it.
 * - **Sign-in limit**: password guessing is slowed down in lib/login-limit.ts.
 * - **Two-step sign-in**: people who add an authenticator app or a passkey (lib/mfa.ts) need it after
 *   their password before a session starts. New passwords follow lib/passwords.ts.
 * - **Required two-step sign-in** (`orgs.mfa_required`, the Org Owner's switch on Settings): everyone who
 *   signed in with a password and has no authenticator app or passkey yet is asked to set one up before
 *   anything else works (`needs_two_step`; `requireUser` refuses with `TWO_STEP_SETUP_REQUIRED` except for
 *   the routes that opt in with `allowPendingTwoStep`: /api/me, the password change and the two-step setup).
 *   Sessions started with Microsoft sign-in (`sessions.via = 'microsoft'`) are exempt: Microsoft runs its
 *   own checks.
 * - **Where you're signed in**: each session remembers when and from which browser and network address it
 *   started, and when it was last used, so people can see their sessions and sign the others out
 *   (`listSessions`, `endOtherSessions`). A password change signs out every other session.
 *
 * Production replaces passwords with Microsoft (Entra ID) sign-in; roles and walls stay the same.
 */
import "server-only";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { all, asSystem, get, newId, now, run, setScopeOrg, tx } from "./db";
import { HttpError } from "./http-error";
import { clientIp } from "./login-limit";
import { traceScope } from "./trace";
import { isWriteRequest } from "./request-scope";
import { BRAND } from "./brand";

export const SESSION_COOKIE = "sk_session";
const SESSION_DAYS = 7;

/** Every role a portal user can have, from most to least access. */
export const ROLES = ["Org Owner", "Org Admin", "Team Lead", "Member", "Viewer"] as const;
export type Role = (typeof ROLES)[number];

/** The signed-in portal user, as API routes see them. */
export type User = {
  id: string;
  org_id: string;
  name: string;
  email: string;
  role: Role;
  must_change_password: number;
  /** True when the org requires two-step sign-in, this session came from a password and the user has no factor yet. */
  needs_two_step?: boolean;
};

/** How a session was started: a password (plus any second step), or Microsoft sign-in (exempt from required two-step). */
export type SessionVia = "password" | "microsoft";

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

/**
 * A hash of a random password nobody knows. Sign-in checks an unknown email against it, so a wrong email
 * takes as long to refuse as a wrong password and the timing doesn't reveal which emails have accounts.
 */
export const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
/** How often a session's "last used" time is written (not on every request, to save database writes). */
const LAST_SEEN_EVERY_MS = 5 * 60_000;

/**
 * Signs a user in: creates a session row (with when, the browser and the network address) and sets the
 * `sk_session` cookie (httpOnly, 7 days). Callers must have checked the password and any second step.
 * `via` records how the person signed in (the Microsoft sign-in callback passes "microsoft"), which decides
 * whether the organization's "Require two-step sign-in" applies to this session.
 * Also drops expired session rows (anyone's), so the table doesn't grow forever.
 */
export async function startSession(userId: string, via: SessionVia = "password") {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  const userAgent = ((await headers()).get("user-agent") ?? "").slice(0, 300);
  await run("DELETE FROM sessions WHERE expires_at < ?", new Date().toISOString());
  await run(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen, user_agent, ip, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    sha256(token), userId, expires.toISOString(), now(), now(), userAgent || null, (await clientIp()) || null, via,
  );
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
 * Ends every other session of this user (other browsers and devices), keeping the one making this request.
 * Called after a password change, so a stolen session cookie stops working when the password is changed.
 * @returns how many sessions were ended
 */
export async function endOtherSessions(userId: string): Promise<number> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  return (await run("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", userId, sha256(token))).changes;
}

/**
 * Returns the signed-in user for this request, or null if there is no valid session.
 * Throws 403 if the user's organization has been paused from the Owner Console. Sets `needs_two_step` when
 * the organization requires two-step sign-in and this password session's user hasn't set one up.
 */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  // Finding whose session this is comes before anyone's org is known: system work (lib/db.ts asSystem).
  const user = await asSystem("session lookup", () => userForToken(token));
  // From here on this request's queries only reach this org's rows (Postgres row-level security, lib/db.ts).
  if (user) setScopeOrg(user.org_id);
  return user;
}

/** The user behind a session token (see `currentUser`); runs as system work. */
async function userForToken(token: string): Promise<User | null> {
  const row = await get<User & { expires_at: string; org_status: string; last_seen: string | null; mfa_required: number; via: string | null }>(
    `SELECT u.id, u.org_id, u.name, u.email, u.role, u.must_change_password, s.expires_at, s.last_seen, s.via, o.status AS org_status, o.mfa_required
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN orgs o ON o.id = u.org_id WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!row || new Date(row.expires_at) < new Date()) return null;
  if (!row.last_seen || Date.now() - new Date(row.last_seen).getTime() > LAST_SEEN_EVERY_MS) {
    await run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", now(), sha256(token));
  }
  if (row.org_status === "Suspended") throw new HttpError(403, `This organization's ${BRAND.name} access is paused. Contact the ${BRAND.name} team.`);
  const needsTwoStep = Number(row.mfa_required) === 1 && row.via !== "microsoft"
    && !(await get("SELECT id FROM mfa_factors WHERE account_kind = 'user' AND account_id = ? AND enabled = 1 LIMIT 1", row.id));
  return { id: row.id, org_id: row.org_id, name: row.name, email: row.email, role: row.role, must_change_password: row.must_change_password, needs_two_step: needsTwoStep };
}

/** One place someone is signed in, as shown on Settings. `id` is a short public handle, never the token. */
export type SessionInfo = { id: string; current: boolean; started: string | null; lastUsed: string | null; device: string; ip: string | null };

/** "Chrome on Mac"-style name for a browser's user-agent text (best effort; "Unknown browser" otherwise). */
export function describeDevice(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /node|undici/i.test(ua) ? "Script" : "";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  if (!browser && !os) return "Unknown browser";
  return [browser || "Browser", os && `on ${os}`].filter(Boolean).join(" ");
}

/** Everywhere this user is signed in (unexpired sessions), newest use first, marking this browser's. */
export async function listSessions(user: Pick<User, "id">): Promise<SessionInfo[]> {
  const mine = (await cookies()).get(SESSION_COOKIE)?.value;
  const rows = await all<{ token_hash: string; created_at: string | null; last_seen: string | null; user_agent: string | null; ip: string | null; expires_at: string }>(
    "SELECT token_hash, created_at, last_seen, user_agent, ip, expires_at FROM sessions WHERE user_id = ? AND expires_at > ?",
    user.id,
    now(),
  );
  return rows
    .map((r) => ({ id: r.token_hash.slice(0, 16), current: Boolean(mine) && r.token_hash === sha256(mine!), started: r.created_at, lastUsed: r.last_seen, device: describeDevice(r.user_agent), ip: r.ip }))
    .sort((a, b) => Number(b.current) - Number(a.current) || String(b.lastUsed ?? "").localeCompare(String(a.lastUsed ?? "")));
}

/** Ends one of this user's sessions by its public id (from `listSessions`). Returns false if there's no such session. */
export async function endSessionById(userId: string, id: string): Promise<boolean> {
  const rows = await all<{ token_hash: string }>("SELECT token_hash FROM sessions WHERE user_id = ?", userId);
  const hit = id.length === 16 ? rows.find((r) => r.token_hash.startsWith(id)) : undefined;
  if (!hit) return false;
  await run("DELETE FROM sessions WHERE token_hash = ?", hit.token_hash);
  return true;
}

export { HttpError } from "./http-error";

/**
 * Returns the signed-in user or throws 401. Pass `roles` to also require one of those roles (403 otherwise).
 * The first line of almost every API route. Until a temporary password is changed (403
 * `PASSWORD_CHANGE_REQUIRED`) or a required second step is set up (403 `TWO_STEP_SETUP_REQUIRED`), only the
 * routes that opt in with `allowPendingPassword` / `allowPendingTwoStep` work.
 */
export async function requireUser(roles?: readonly Role[], opts: { allowPendingPassword?: boolean; allowPendingTwoStep?: boolean } = {}): Promise<User> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in to continue.");
  traceScope({ orgId: user.org_id, actor: user.name, userId: user.id });
  // A temporary password must be changed before anything else (only /api/me and the password change pass this).
  if (user.must_change_password && !opts.allowPendingPassword) throw new HttpError(403, PASSWORD_CHANGE_REQUIRED);
  // The organization requires two-step sign-in and this person hasn't set it up yet (see the file header).
  if (user.needs_two_step && !opts.allowPendingTwoStep) throw new HttpError(403, TWO_STEP_SETUP_REQUIRED);
  if (roles && !roles.includes(user.role)) throw new HttpError(403, onlyRolesMessage(roles));
  return user;
}

/**
 * The refusal for someone whose role isn't in `roles`, naming who can do it, e.g. "Only the Org Owner can do
 * this." or "Only Org Owners and Org Admins can do this. Ask one of them."
 */
export function onlyRolesMessage(roles: readonly Role[]): string {
  if (roles.length === 1 && roles[0] === "Org Owner") return "Only the Org Owner can do this. Ask them if you need it.";
  const names = roles.map((r) => `${r}s`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `Only ${list} can do this. Ask one of them if you need it.`;
}

/** The refusal while someone still has a temporary password; the portal shows the change-password screen instead. */
export const PASSWORD_CHANGE_REQUIRED = `Change your temporary password first. Then you can use ${BRAND.name}.`;

/** The refusal while the org requires two-step sign-in and it isn't set up; the portal shows the setup screen instead. */
export const TWO_STEP_SETUP_REQUIRED = `Your organization requires two-step sign-in. Set up an authenticator app or a passkey first. Then you can use ${BRAND.name}.`;

/**
 * The user behind this browser's session, or null, without the paused-organization check. Only for
 * signing out, which must work even when the organization is paused.
 */
export async function sessionUser(): Promise<Pick<User, "org_id" | "name"> | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return (await asSystem("session lookup", () => get<{ org_id: string; name: string }>("SELECT u.org_id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", sha256(token)))) ?? null;
}

/** Org Owners and Org Admins can manage users, workspaces, Teams links and settings. */
export const isAdmin = (u: User) => u.role === "Org Owner" || u.role === "Org Admin";
/** Team Leads manage people and Teams links, but only in the workspaces they belong to (see `requireManage`). */
export const isLead = (u: User) => u.role === "Team Lead";
/** Roles a Team Lead may give people they add to their workspaces. */
export const LEAD_ASSIGNABLE_ROLES: readonly Role[] = ["Member", "Viewer"];
/** Everyone except Viewers can change workspace content. */
export const canEdit = (u: User) => u.role !== "Viewer";

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
 * True if `user` may see this one workspace: the same rule as `workspaceIdsFor` (admins: any workspace of their
 * org; everyone else: the ones they belong to), checked with one indexed lookup instead of listing every workspace
 * (a big organization has over a thousand; docs/SCALE.md).
 */
export async function canSeeWorkspace(user: User, workspaceId: string): Promise<boolean> {
  if (isAdmin(user)) return Boolean(await get("SELECT id FROM workspaces WHERE id = ? AND org_id = ?", workspaceId, user.org_id));
  return Boolean(await get(
    `SELECT wm.workspace_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ? AND wm.workspace_id = ? AND w.org_id = ?`,
    user.id, workspaceId, user.org_id,
  ));
}

/**
 * The workspace wall. Returns the workspace id if this user may use it; otherwise throws 404 (not 403,
 * so people can't tell whether a workspace they don't belong to exists). Call it before any query that
 * reads or writes workspace data, and use the returned id in that query.
 *
 * A group that is **ending** (scheduled for deletion, lib/rolloff.ts) is read-only: during a request that
 * changes something (`isWriteRequest`) it's refused with 409 and the deletion date. The roll-off routes
 * themselves (cancel, delete now) pass `allowEnding`.
 */
export async function requireWorkspace(user: User, workspaceId: string | null | undefined, opts: { allowEnding?: boolean } = {}): Promise<string> {
  if (!workspaceId || !(await canSeeWorkspace(user, workspaceId))) {
    throw new HttpError(404, "Workspace not found, or you're not a member of it.");
  }
  traceScope({ workspaceId });
  if (!opts.allowEnding && isWriteRequest()) {
    const ending = await get<{ delete_on: string }>(
      "SELECT delete_on FROM rolloffs WHERE org_id = ? AND workspace_id = ? AND scope = 'group' AND status IN ('scheduled', 'running')", user.org_id, workspaceId,
    );
    if (ending) {
      const when = new Date(ending.delete_on).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
      throw new HttpError(409, `This group is ending: it's read-only and everything in it will be deleted on ${when}. An Org Owner or Org Admin can download it or cancel the ending on the group's Settings tab.`);
    }
  }
  return workspaceId;
}

/**
 * The workspaces whose people and Teams links this user may manage: every workspace in the org for Org
 * Owners/Admins, the ones they belong to for a Team Lead, none for anyone else.
 */
export async function managedWorkspaceIds(user: User): Promise<string[]> {
  return isAdmin(user) || isLead(user) ? workspaceIdsFor(user) : [];
}

/**
 * Like `requireWorkspace`, plus the person must be allowed to manage that workspace's people and Teams
 * links (an Org Owner/Admin, or a Team Lead of it). Throws 403 for any other role, then 404 for a workspace
 * they can't see. Returns the workspace id.
 */
export async function requireManage(user: User, workspaceId: string | null | undefined): Promise<string> {
  // The role is checked first, so other roles always get a plain 403 whatever workspace they name.
  if (!isAdmin(user) && !isLead(user)) throw new HttpError(403, "Only Org Owners, Org Admins and the workspace's Team Lead can do this.");
  return requireWorkspace(user, workspaceId);
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
  await audit({ org_id: orgId, name: BRAND.name }, action, kind, workspaceId);
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

/**
 * Creates a new organization and its Org Owner together (both or neither). Used by self-service sign-up
 * (lib/signup.ts); first-run Setup and the Owner Console still create theirs inline. `entraTenantId` ties
 * the organization to a Microsoft tenant from the start, for a later "Sign up with Microsoft" (the tenant
 * id must be unique: the database refuses a second organization for the same tenant). Returns both ids.
 */
export async function createOrgWithOwner(
  orgName: string,
  owner: { name: string; email: string; password: string },
  opts: { entraTenantId?: string | null; entraOid?: string | null } = {},
): Promise<{ orgId: string; userId: string }> {
  const orgId = newId();
  return tx(async () => {
    await run("INSERT INTO orgs (id, name, created_at, entra_tenant_id) VALUES (?, ?, ?, ?)", orgId, orgName, now(), opts.entraTenantId ?? null);
    const userId = await createUser(orgId, owner.name, owner.email, "Org Owner", owner.password, false);
    if (opts.entraOid) await run("UPDATE users SET entra_oid = ? WHERE id = ?", opts.entraOid, userId);
    return { orgId, userId };
  });
}
