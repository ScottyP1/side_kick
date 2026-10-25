/**
 * @file The customer's Microsoft 365 directory (Microsoft Graph): admin approval, searching people, and
 * creating Sidekick accounts for them ("Import from Microsoft 365" on Users & access, and `@Sidekick add` in Teams).
 *
 * Concepts
 * - **Microsoft Graph** is Microsoft's API for a company's Microsoft 365 data. Sidekick only reads the people
 *   directory (names, work emails, job titles, account ids), nothing else.
 * - **Application permission `User.Read.All`**: Sidekick reads the directory as itself (an app token from the
 *   client-credentials flow, for the customer's tenant), not as the signed-in person. Chosen over the delegated
 *   permission because the same lookup is needed when nobody is signed in to the portal (someone typing
 *   `@Sidekick add @Maria` in Teams), and because it doesn't depend on the admin's own Microsoft session.
 *   Application permissions always need **admin consent**: a Microsoft admin of the customer's tenant approves
 *   Sidekick once for the whole organization ("Approve Sidekick for your organization").
 * - **Admin consent round trip**: an Org Owner/Admin presses the button → Sidekick sends the browser to
 *   Microsoft's admin-consent page for the org's own tenant → the Microsoft admin approves (or cancels) →
 *   Microsoft sends the browser back to `/api/auth/microsoft/callback` with `admin_consent=True`. The `state`
 *   (saved in `oidc_states` and in the browser cookie) ties the reply to the person who started it. The org
 *   must be connected to its tenant first (Settings → Microsoft sign-in), so the tenant is always a verified one.
 * - **Consent not given yet**: Microsoft refuses the app token, or Graph answers 401/403. Every call here turns
 *   that into one clear message (`ConsentNeededError`, `consent: "needed"` in the JSON) the page shows with the
 *   approve button, instead of a generic error.
 * - **Microsoft-sign-in users**: people created from the directory have no password at all
 *   (`password_hash = MICROSOFT_ONLY`, which never matches): they sign in with Microsoft only, and their
 *   Microsoft account id is saved right away, so Teams knows them too.
 *
 * Tests point `GRAPH_BASE` (and `ENTRA_LOGIN_BASE`) at a fake Microsoft on localhost; ignored in production.
 */
import "server-only";
import crypto from "node:crypto";
import { withErrorDetails } from "./api";
import { audit, HttpError, isAdmin, isLead, LEAD_ASSIGNABLE_ROLES, managedWorkspaceIds, requireUser, type Role, type User } from "./auth";
import { get, newId, now, run } from "./db";
import { entraConfig, entraConfigured, LOGIN_BASE, OIDC_COOKIE, redirectUri } from "./entra";
import { tenantOfOrg } from "./tenants";
import { assertFeature } from "./limits";
import { span } from "./trace";
import { BRAND } from "./brand";

/** Microsoft Graph. Overridable only outside production (for the fake Graph in tests). */
const GRAPH_BASE = process.env.NODE_ENV !== "production" && process.env.GRAPH_BASE ? process.env.GRAPH_BASE.replace(/\/$/, "") : "https://graph.microsoft.com";

/** Stored as the password of people who sign in with Microsoft only. Not a scrypt hash, so no password matches it. */
export const MICROSOFT_ONLY = "microsoft-only";

/** What each permission Sidekick asks for lets it do, in plain words (shown next to the approve button). */
export const PERMISSIONS_EXPLAINED = [
  { name: "Sign in and read user profile (User.Read, delegated)", what: `Lets people sign in to ${BRAND.name} with their work account. ${BRAND.name} sees their name, email and account id.` },
  { name: "Read all users' full profiles (User.Read.All, application)", what: `Lets ${BRAND.name} search your directory when an admin imports people or someone types @${BRAND.name} add in Teams. ${BRAND.name} reads names, work emails, job titles and account ids only, and never changes anything in Microsoft 365.` },
  { name: "Manage its own installation in chats and teams (TeamsAppInstallation.ReadWriteSelfForChat.All and ReadWriteSelfForTeam.All, application)", what: `Lets ${BRAND.name} remove itself from a chat or team: when someone other than a Team Lead or admin adds it, when nobody assigns a chat to a group within 7 days, or when you press Remove ${BRAND.name} from this chat. It can only add or remove ${BRAND.name}, never other apps.` },
  { name: "Read all meeting transcripts and online meetings (OnlineMeetingTranscript.Read.All and OnlineMeetings.Read.All, application)", what: `Only used when an admin turns on automatic notes on the Meetings page. When a Teams meeting ends, ${BRAND.name} reads its subject, times and invitees to find the right group, and its transcript to write the notes. Meetings that aren't any group's are skipped and nothing about them is kept. ${BRAND.name} never joins a call, and never starts a recording unless an admin turns on the option below.` },
  { name: "Read all call transcripts (CallTranscripts.Read.All, application)", what: `Only used with automatic notes. Lets ${BRAND.name} read the transcript of a Teams call started with Meet now (for example in a group chat), which Microsoft keeps apart from scheduled meetings. ${BRAND.name} reads which chat the call came from and who spoke, to find the right group; calls that aren't any group's are skipped and nothing about them is kept. Organizations that approved ${BRAND.name} before October 2026 approve once more to add it.` },
  { name: "Read and change online meetings, and read calendars (OnlineMeetings.ReadWrite.All and Calendars.ReadBasic.All, application)", what: `Only used when an admin also turns on "Group meetings record and transcribe by themselves" on the Meetings page (off by default). ${BRAND.name} reads the times, subject, invitees and Teams link of meetings that a group's people organize in the next 7 days (never the invitation text) and turns on Record and transcribe automatically for meetings that are clearly one group's. It changes nothing else, and never meetings with people from outside your organization. Teams then also saves a video recording, as when the organizer picks that option.` },
  { name: `Sign in to the ${BRAND.name} tab in Teams (access_as_user, delegated)`, what: `Lets the ${BRAND.name} tab in Teams sign people in with their work account, without a password.` },
  { name: "Teams chat and channel messages (resource-specific, per chat)", what: `Not part of this approval: granted per chat or team when ${BRAND.name} is added there. ${BRAND.name} reads a chat's messages only once it's assigned to a group.` },
] as const;

/** Thrown when the organization's Microsoft admin hasn't approved Sidekick (yet). The JSON says `consent: "needed"`. */
export class ConsentNeededError extends HttpError {
  constructor(message = `${BRAND.name} isn't approved for your Microsoft 365 organization yet. A Microsoft admin of your organization needs to approve it once (Users & access → Approve ${BRAND.name} for your organization).`) {
    super(409, message);
    withErrorDetails(this, { consent: "needed" });
  }
}

/* ------------------------------------------------------------------ */
/* App token for one tenant (client credentials)                       */
/* ------------------------------------------------------------------ */

const tokens = new Map<string, { token: string; expires: number }>();

/**
 * An app-only Graph token for this tenant, cached until a minute before it expires.
 * @throws ConsentNeededError if Microsoft refuses because Sidekick isn't approved in that tenant
 */
async function graphToken(tenantId: string): Promise<string> {
  const cached = tokens.get(tenantId);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const c = entraConfig();
  const res = await fetch(`${LOGIN_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
  }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | null;
  if (!res) throw new HttpError(502, "Couldn't reach Microsoft. Try again in a minute.");
  if (!res.ok || !body?.access_token) {
    // invalid_client = the app's secret is wrong or expired: that's ours to fix, not the customer's.
    if (body?.error === "invalid_client") throw new HttpError(502, `Microsoft refused ${BRAND.name}'s app credentials (the secret may have expired). The ${BRAND.name} team needs to renew it.`);
    // Anything else (unauthorized_client, invalid_grant, AADSTS7000229/65001/700016) means the app isn't set up
    // or approved in that tenant.
    throw new ConsentNeededError();
  }
  tokens.set(tenantId, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

/**
 * Microsoft Graph said "too many requests" (429) or "busy" (503) and asked to wait longer than we wait in place.
 * `retryAfterMs` is its Retry-After; the job queue never retries sooner than that (lib/jobs.ts).
 */
export class GraphThrottledError extends HttpError {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(503, `Microsoft Graph is busy and asked ${BRAND.name} to wait ${Math.ceil(retryAfterMs / 1000)} seconds. It will try again by itself.`);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Waits this short a Retry-After in place (and tries again, at most twice) instead of failing the job. */
const WAIT_IN_PLACE_MS = 5_000;

/** Graph's Retry-After header (seconds, or an HTTP date) in milliseconds; 30 s when it's missing or unreadable. */
export function retryAfterMs(header: string | null, at = Date.now()): number {
  if (!header) return 30_000;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const when = Date.parse(header);
  return Number.isNaN(when) ? 30_000 : Math.max(0, when - at);
}

/**
 * One call to Microsoft Graph for this tenant with Sidekick's app token. 401/403 become `ConsentNeededError`
 * (with `deniedMessage` when given, or the `deniedCodes` message matching Graph's `innerError.code`, for refusals
 * that need a different fix than approving a permission, like a tenant switch that is off), 404 returns null, 429/503 wait up to 5 s in place (twice at most) and
 * otherwise throw `GraphThrottledError` with Graph's Retry-After, other failures 502. Returns the JSON body (null
 * when empty), or the body as text with `raw` (a transcript download). `body` is sent as JSON (POST/PATCH).
 * Used here for the directory, by lib/teams/install.ts to remove Sidekick from a chat or team, and by
 * lib/meetings-graph.ts for meeting transcripts and change-notification subscriptions.
 */
export async function graphCall<T>(
  tenantId: string,
  method: "GET" | "DELETE" | "POST" | "PATCH",
  path: string,
  opts: { headers?: Record<string, string>; deniedMessage?: string; deniedCodes?: Record<string, string>; body?: unknown; raw?: boolean } = {},
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const token = await graphToken(tenantId);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.headers ?? {}) };
    const res = await fetch(`${GRAPH_BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }).catch(() => null);
    if (!res) throw new HttpError(502, "Couldn't reach Microsoft Graph. Try again in a minute.");
    if (res.status === 401 || res.status === 403) {
      tokens.delete(tenantId);
      const code = opts.deniedCodes ? await graphErrorCode(res) : null;
      throw new ConsentNeededError((code && opts.deniedCodes?.[code]) || opts.deniedMessage);
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status === 503) {
      const wait = retryAfterMs(res.headers.get("retry-after"));
      if (wait <= WAIT_IN_PLACE_MS && attempt < 2) {
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new GraphThrottledError(wait);
    }
    if (!res.ok) throw new HttpError(502, `Microsoft Graph answered ${res.status}. Try again in a minute.`);
    const text = await res.text();
    if (opts.raw) return text as T;
    return (text ? JSON.parse(text) : null) as T | null;
  }
}

/** Graph's most specific error code from a failed response (`innerError.code`, else `error.code`), or null. */
async function graphErrorCode(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown; innerError?: { code?: unknown } } } | null;
  const code = body?.error?.innerError?.code ?? body?.error?.code;
  return typeof code === "string" ? code : null;
}

const graphGet = <T>(tenantId: string, path: string, headers: Record<string, string> = {}) =>
  graphCall<T>(tenantId, "GET", path, {
    headers,
    deniedMessage: `${BRAND.name} is connected to your Microsoft 365 organization but can't read its directory yet. A Microsoft admin needs to approve the “Read all users' full profiles” permission (Users & access → Approve ${BRAND.name} for your organization).`,
  });

/* ------------------------------------------------------------------ */
/* Directory people                                                    */
/* ------------------------------------------------------------------ */

/**
 * A person in the customer's Microsoft 365 directory, as Sidekick uses them. `email` is their mail (or their
 * sign-in name when they have no mailbox); `upn` is their Microsoft sign-in name (userPrincipalName).
 */
export type DirectoryPerson = { id: string; name: string; email: string; upn: string; jobTitle: string | null; guest: boolean };

type GraphUser = { id: string; displayName?: string; mail?: string | null; userPrincipalName?: string; jobTitle?: string | null; userType?: string; accountEnabled?: boolean };
const SELECT = "id,displayName,mail,userPrincipalName,jobTitle,userType,accountEnabled";
const toPerson = (u: GraphUser): DirectoryPerson => ({
  id: u.id,
  name: u.displayName || u.mail || u.userPrincipalName || "Unnamed",
  email: (u.mail || u.userPrincipalName || "").toLowerCase(),
  upn: (u.userPrincipalName || "").toLowerCase(),
  jobTitle: u.jobTitle ?? null,
  guest: u.userType === "Guest",
});

/**
 * Searches the tenant's directory by name or email (up to 25 enabled people). Guests from other companies are
 * left out: they belong to their own organization. Traced as a step (counts only, no names).
 * @throws ConsentNeededError until a Microsoft admin approved Sidekick
 */
export async function searchDirectory(tenantId: string, query: string): Promise<DirectoryPerson[]> {
  const q = query.replace(/["\\]/g, "").trim().slice(0, 80);
  return span("microsoft", "Search the Microsoft 365 directory", async () => {
    const path = q
      ? `/v1.0/users?$search=${encodeURIComponent(`"displayName:${q}" OR "mail:${q}" OR "userPrincipalName:${q}"`)}&$select=${SELECT}&$top=25&$count=true`
      : `/v1.0/users?$select=${SELECT}&$top=25&$orderby=displayName&$count=true`;
    // $search and $count need this header in Graph's "advanced queries".
    const out = await graphGet<{ value: GraphUser[] }>(tenantId, path, { ConsistencyLevel: "eventual" });
    return (out?.value ?? []).filter((u) => u.accountEnabled !== false && u.userType !== "Guest").map(toPerson);
  }, { query: q ? "text" : "all" });
}

/** One person from the tenant's directory by their Microsoft account id, or null if they aren't in it. */
export async function directoryPerson(tenantId: string, objectId: string): Promise<DirectoryPerson | null> {
  if (!/^[0-9a-f-]{36}$/i.test(objectId)) return null;
  const u = await graphGet<GraphUser>(tenantId, `/v1.0/users/${objectId}?$select=${SELECT}`);
  return u && u.accountEnabled !== false ? toPerson(u) : null;
}

/* ------------------------------------------------------------------ */
/* Creating Sidekick people from Microsoft 365                         */
/* ------------------------------------------------------------------ */

/** An existing Sidekick person found for a Microsoft account. */
type Found = { id: string; org_id: string; name: string; email: string; role: Role; entra_oid: string | null };

/**
 * Finds the Sidekick person for a Microsoft account in this org (by account id, then by email), or creates
 * them as a Microsoft-sign-in user with `role`. Their account id is saved so Teams and Microsoft sign-in
 * recognise them. Returns `created: false` for someone already there.
 * @throws HttpError 409 if the email already belongs to someone in another Sidekick organization
 */
export async function findOrCreateMicrosoftUser(orgId: string, p: { objectId: string; name: string; email: string }, role: Role): Promise<{ user: Found; created: boolean }> {
  const byOid = await get<Found>("SELECT id, org_id, name, email, role, entra_oid FROM users WHERE org_id = ? AND entra_oid = ?", orgId, p.objectId);
  if (byOid) return { user: byOid, created: false };
  const email = p.email.toLowerCase();
  const byEmail = email ? await get<Found>("SELECT id, org_id, name, email, role, entra_oid FROM users WHERE lower(email) = ?", email) : undefined;
  if (byEmail && byEmail.org_id !== orgId) throw new HttpError(409, `${email} already has a ${BRAND.name} account in another organization.`);
  if (byEmail) {
    if (byEmail.entra_oid && byEmail.entra_oid !== p.objectId) throw new HttpError(409, `${email} is already linked to a different Microsoft account.`);
    await run("UPDATE users SET entra_oid = ? WHERE id = ?", p.objectId, byEmail.id);
    return { user: { ...byEmail, entra_oid: p.objectId }, created: false };
  }
  if (!email) throw new HttpError(400, `${p.name} has no email address in Microsoft 365, so ${BRAND.name} can't add them.`);
  const id = newId();
  await run(
    "INSERT INTO users (id, org_id, name, email, role, password_hash, must_change_password, created_at, entra_oid) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
    id, orgId, p.name.slice(0, 120), email, role, MICROSOFT_ONLY, now(), p.objectId,
  );
  return { user: { id, org_id: orgId, name: p.name.slice(0, 120), email, role, entra_oid: p.objectId }, created: true };
}

/** Result of importing people from the directory: who was added, and who wasn't and why. */
export type ImportResult = { added: { id: string; name: string; email: string; created: boolean }[]; skipped: { name: string; reason: string }[] };

/**
 * Imports people from the org's Microsoft 365 directory (Users & access → Import from Microsoft 365).
 * Same rules as adding someone by hand (POST /api/users): Org Owners/Admins any role but Org Owner and any
 * workspaces; a Team Lead only Member/Viewer and only into workspaces they lead (at least one). Each person is
 * looked up again in Graph by id, so names and emails come from Microsoft, never from the browser. People who
 * are already in Sidekick are just added to the chosen workspaces (a Team Lead only for Members/Viewers).
 * Importing as Team Lead needs a plan with Team Leads (Team and up; 402 `kind: "limit"`). Audited per person.
 */
export async function importPeople(actor: User, objectIds: string[], role: Role, workspaceIds: string[]): Promise<ImportResult> {
  if (role === "Org Owner") throw new HttpError(400, "Nobody can be added as Org Owner. Pick another role.");
  const allowed = new Set(await managedWorkspaceIds(actor));
  const workspaces = workspaceIds.filter((w) => allowed.has(w));
  if (isLead(actor)) {
    if (!LEAD_ASSIGNABLE_ROLES.includes(role)) throw new HttpError(403, "Team Leads can add people as Member or Viewer. Ask an Org Admin for other roles.");
    if (!workspaces.length) throw new HttpError(400, "Pick at least one of your workspaces for these people.");
  }
  if (role === "Team Lead") await assertFeature(actor.org_id, "teamLeads");
  const ids = [...new Set(objectIds)].slice(0, 50);
  if (!ids.length) throw new HttpError(400, "Pick at least one person to import.");
  const tenant = await requireDirectoryTenant(actor);
  const out: ImportResult = { added: [], skipped: [] };
  await span("microsoft", "Import people from Microsoft 365", async () => {
    for (const oid of ids) {
      const p = await directoryPerson(tenant, oid);
      if (!p) {
        out.skipped.push({ name: oid, reason: "Not found in your Microsoft 365 directory." });
        continue;
      }
      if (p.guest) {
        out.skipped.push({ name: p.name, reason: "A guest from another organization." });
        continue;
      }
      try {
        const { user, created } = await findOrCreateMicrosoftUser(actor.org_id, { objectId: p.id, name: p.name, email: p.email }, role);
        if (!created && isLead(actor) && !LEAD_ASSIGNABLE_ROLES.includes(user.role)) {
          out.skipped.push({ name: p.name, reason: `Already in ${BRAND.name} as ${user.role}; ask an Org Admin.` });
          continue;
        }
        for (const ws of workspaces) await run("INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", ws, user.id);
        await audit(actor, created ? `Imported ${user.name} (${user.email}) from Microsoft 365 as ${role}` : `Added ${user.name} (${user.email}) to ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"} from Microsoft 365`, "Access");
        out.added.push({ id: user.id, name: user.name, email: user.email, created });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        out.skipped.push({ name: p.name, reason: e.message });
      }
    }
  }, { people: ids.length });
  return out;
}

/**
 * The tenant whose directory this person may search: their org's connected tenant, with Microsoft set up.
 * Only Org Owners/Admins and Team Leads. @throws HttpError with a plain reason otherwise
 */
export async function requireDirectoryTenant(user: User): Promise<string> {
  if (!isAdmin(user) && !isLead(user)) throw new HttpError(403, "Only Org Owners, Org Admins and Team Leads can import people.");
  if (!entraConfigured()) throw new HttpError(503, `Microsoft isn't set up on this ${BRAND.name} yet.`);
  const tenant = await tenantOfOrg(user.org_id);
  if (!tenant) throw new HttpError(400, "Connect your organization to Microsoft first: the Org Owner does it on Settings → Microsoft sign-in.");
  return tenant;
}

/* ------------------------------------------------------------------ */
/* Admin consent round trip                                            */
/* ------------------------------------------------------------------ */

const STATE_MINUTES = 15;

/**
 * Starts "Approve Sidekick for your organization" (Org Owners and Org Admins): saves a one-time state and
 * returns Microsoft's admin-consent address for the org's own tenant, plus the state for the browser cookie.
 * Whoever approves on Microsoft's page must be a Microsoft admin of that tenant (Global Administrator,
 * Privileged Role Administrator or Cloud Application Administrator).
 */
export async function startAdminConsent(req: Request): Promise<{ url: string; state: string }> {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const tenant = await requireDirectoryTenant(user);
  const state = crypto.randomBytes(24).toString("base64url");
  await run("DELETE FROM oidc_states WHERE expires_at < ?", now());
  await run(
    "INSERT INTO oidc_states (state, verifier, nonce, mode, user_id, next_path, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    state, "-", "-", "consent", user.id, "/users", new Date(Date.now() + STATE_MINUTES * 60_000).toISOString(),
  );
  const url = new URL(`${LOGIN_BASE}/${encodeURIComponent(tenant)}/v2.0/adminconsent`);
  url.search = new URLSearchParams({ client_id: entraConfig().clientId, scope: "https://graph.microsoft.com/.default", redirect_uri: redirectUri(req), state }).toString();
  return { url: url.toString(), state };
}

/** True if this callback request is the reply to an admin-consent round trip (its state was saved with mode "consent"). */
export async function isConsentReply(req: Request): Promise<boolean> {
  const state = new URL(req.url).searchParams.get("state");
  if (!state) return false;
  return (await get<{ mode: string }>("SELECT mode FROM oidc_states WHERE state = ?", state))?.mode === "consent";
}

/**
 * Finishes the admin-consent round trip: checks the state against the browser cookie, that the person who
 * started it is still an Org Owner/Admin, and that Microsoft says the approval was for the org's own tenant;
 * then records it on the org (`graph_consent_at`) and in the audit log. The state is used up.
 * @throws HttpError 400/403 with a plain reason (cancelled, wrong tenant, expired, other browser)
 */
export async function finishAdminConsent(req: Request, cookieState: string | undefined): Promise<void> {
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  const saved = await get<{ user_id: string | null; expires_at: string }>("SELECT user_id, expires_at FROM oidc_states WHERE state = ? AND mode = 'consent'", state);
  await run("DELETE FROM oidc_states WHERE state = ?", state);
  if (!saved || !cookieState || cookieState !== state) throw new HttpError(400, "That approval link expired or was opened in a different browser. Try again.");
  if (saved.expires_at < now()) throw new HttpError(400, "That approval took too long. Try again.");
  if (q.get("error")) {
    const desc = (q.get("error_description") ?? "").split("\n")[0].replace(/^AADSTS\d+:\s*/, "").slice(0, 300);
    throw new HttpError(400, q.get("error") === "access_denied" ? "Approval was cancelled, or the account used isn't a Microsoft admin of your organization." : `Microsoft didn't approve ${BRAND.name}: ${desc || q.get("error")}`);
  }
  const user = saved.user_id ? await get<User>("SELECT id, org_id, name, email, role, must_change_password FROM users WHERE id = ?", saved.user_id) : undefined;
  if (!user || !isAdmin(user)) throw new HttpError(403, `Only Org Owners and Org Admins can approve ${BRAND.name} for the organization.`);
  const tenant = await tenantOfOrg(user.org_id);
  if (!tenant || (q.get("tenant") ?? "").toLowerCase() !== tenant.toLowerCase()) {
    throw new HttpError(403, `That approval was for a different Microsoft organization than the one connected to ${BRAND.name}.`);
  }
  if (q.get("admin_consent")?.toLowerCase() !== "true") throw new HttpError(400, "Microsoft didn't confirm the approval. Try again.");
  tokens.delete(tenant);
  await run("UPDATE orgs SET graph_consent_at = ? WHERE id = ?", now(), user.org_id);
  await audit(user, `Approved ${BRAND.name} for the organization's Microsoft 365 (directory read permission)`, "Policy change");
}

export { OIDC_COOKIE };
