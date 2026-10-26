/**
 * @file Microsoft sign-in (Entra ID, formerly Azure AD) for the client portal.
 *
 * Concepts
 * - **Entra ID** is Microsoft's sign-in service: the same work account people use for Outlook and Teams.
 *   Sidekick sends the browser to Microsoft, the person signs in there (with their company's password
 *   rules and MFA), and Microsoft sends them back with a one-time code.
 * - **Authorization code flow with PKCE**: Sidekick swaps that code for an **ID token**, a signed note from
 *   Microsoft saying who this is. PKCE (a random secret only this server knows) and `state` make sure a
 *   code can't be stolen or replayed; `nonce` ties the token to this exact sign-in.
 * - **Tenant**: each company has its own Microsoft tenant (its directory of people), identified by a tenant
 *   id (`tid`). A Sidekick organization is connected to exactly one tenant, by its Org Owner signing in
 *   with Microsoft from Settings (`mode: "link"`). Only people from that tenant can sign in to that org.
 * - **Object id (`oid`)**: a person's permanent id in their tenant. Sidekick stores it on their user row
 *   the first time they sign in. Teams messages carry the same id (`aadObjectId`), which is how a Teams
 *   message is matched to the right portal person and role (see lib/teams/bot.ts).
 * - **Who may sign in**: Microsoft proves who someone is; Sidekick still decides what they can do. A person
 *   must have been added on Users & access (by email) first. Their role and workspaces work as before.
 * - **Require Microsoft sign-in**: once connected, an Org Owner can turn passwords off for the whole org.
 *
 * Configuration (app/.env.local): uses the same Entra app as the Teams bot: `CLIENT_ID`, `CLIENT_SECRET`
 * and `TENANT_ID` (or `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` / `ENTRA_TENANT` to use a separate app).
 * - **Single tenant** (single-tenant mode, lib/tenants.ts: `TENANT_ID` or `ENTRA_TENANT` = one tenant id):
 *   Microsoft only signs in that tenant's people, and a token from any other tenant is refused here too.
 * - **Multi-tenant** (multi-tenant mode, or `ENTRA_TENANT` = `organizations`/`common`): people from any
 *   company's tenant can sign in. The Entra app must be set to "multiple organizations"; with
 *   `SIDEKICK_MULTI_TENANT=1` that's a separate app in `ENTRA_CLIENT_ID`/`ENTRA_CLIENT_SECRET`, while the bot
 *   keeps its single-tenant app (see docs/TEAMS-MULTITENANT.md). Each token is verified
 *   against its own tenant's issuer (`https://login.microsoftonline.com/<tid>/v2.0`), and the callback only
 *   lets someone into the Sidekick org tied to that exact tenant (lib/tenants.ts), so one company's token can
 *   never open another company's org.
 * The redirect address `<portal>/api/auth/microsoft/callback` must be added to the Entra app as a Web
 * redirect URI (the admin-consent round trip in lib/directory.ts comes back to the same address).
 * - **Owner Console** (`mode: "owner"`): the platform operator signs in to /owner with the same Entra app but
 *   through its own start and callback (`/api/owner/auth/microsoft/*`, a second Web redirect URI on the app),
 *   so the reply can only ever start an Owner Console session, never a portal one (lib/owner.ts decides who).
 *   `finishMicrosoftSignIn` refuses a saved sign-in whose mode doesn't belong to the callback using it.
 *
 * Tests point `ENTRA_LOGIN_BASE` at a fake Microsoft on localhost; that override is ignored in production.
 */
import "server-only";
import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { HttpError } from "./auth";
import { get, now, run } from "./db";
import { tenantMode } from "./tenants";
import { BRAND } from "./brand";

/** Microsoft's sign-in service. Overridable only outside production (for the fake Microsoft in tests). */
export const LOGIN_BASE =
  process.env.NODE_ENV !== "production" && process.env.ENTRA_LOGIN_BASE ? process.env.ENTRA_LOGIN_BASE.replace(/\/$/, "") : "https://login.microsoftonline.com";

/** The tenant id Microsoft uses for personal accounts (outlook.com, hotmail.com): never a company. */
const PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

const STATE_MINUTES = 10;
/** Browser cookie that ties the Microsoft round trip to the browser that started it (stops login CSRF). */
export const OIDC_COOKIE = "sk_oidc";

/**
 * The Entra app Sidekick signs in with. `tenant` is the sign-in authority: one tenant id (single-tenant) or
 * "organizations" (any work or school account; "common" is treated the same, personal accounts are refused).
 * `singleTenant` is that one tenant id, or null in multi-tenant mode.
 */
export const entraConfig = () => {
  // In multi-tenant mode TENANT_ID is only the bot's home tenant, never the sign-in authority.
  const raw = (process.env.ENTRA_TENANT || (tenantMode() === "multi" ? "" : process.env.TENANT_ID) || "").trim();
  const any = !raw || ["common", "organizations"].includes(raw.toLowerCase());
  return {
    clientId: process.env.ENTRA_CLIENT_ID || process.env.CLIENT_ID || "",
    clientSecret: process.env.ENTRA_CLIENT_SECRET || process.env.CLIENT_SECRET || "",
    tenant: any ? "organizations" : raw,
    singleTenant: any ? null : raw,
  };
};
const config = entraConfig;

/** True when Microsoft sign-in is set up (app id and secret are in .env.local; no tenant means any tenant). */
export function entraConfigured(): boolean {
  const c = config();
  return Boolean(c.clientId && c.clientSecret);
}

/**
 * The address Microsoft sends people back to. In production it's built from SIDEKICK_PUBLIC_URL (the
 * server may sit behind a proxy); in development, from the address the browser used (localhost or the
 * tunnel). Either way Microsoft only accepts it if it's registered on the Entra app.
 */
export function redirectUri(req: Request, flow: SignInMode = "signin"): string {
  const base = process.env.NODE_ENV === "production" && process.env.SIDEKICK_PUBLIC_URL ? process.env.SIDEKICK_PUBLIC_URL : new URL(req.url).origin;
  return `${base.replace(/\/$/, "")}${flow === "owner" ? OWNER_CALLBACK_PATH : "/api/auth/microsoft/callback"}`;
}

/** Where Microsoft sends the Owner Console sign-in back to (registered on the Entra app as a second redirect URI). */
export const OWNER_CALLBACK_PATH = "/api/owner/auth/microsoft/callback";

/**
 * What a Microsoft round trip is for: "signin" (portal sign-in), "link" (an Org Owner connecting the org's
 * tenant) or "owner" (the platform operator signing in to the Owner Console; lib/owner.ts).
 */
export type SignInMode = "signin" | "link" | "owner";

/** Only same-site paths like "/meetings" are allowed after sign-in, never another website. */
export const safeNext = (next: string | null | undefined) => (next && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : "/");

const b64url = (b: Buffer) => b.toString("base64url");

/**
 * Starts a Microsoft sign-in: saves a one-time state (with the PKCE verifier and nonce) and returns the
 * Microsoft address to send the browser to, plus the state for the browser cookie.
 *
 * @param mode   "signin" (anyone), "link" (an Org Owner connecting the org's tenant; `userId` is them) or
 *               "owner" (the Owner Console; Microsoft replies to `OWNER_CALLBACK_PATH` instead)
 * @param next   where to go afterwards (same-site path)
 */
export async function startMicrosoftSignIn(req: Request, mode: SignInMode, opts: { userId?: string; next?: string | null; loginHint?: string | null } = {}) {
  if (!entraConfigured()) throw new HttpError(503, `Microsoft sign-in isn't set up on this ${BRAND.name} yet. Sign in with your email and password.`);
  const c = config();
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const nonce = b64url(crypto.randomBytes(16));
  await run("DELETE FROM oidc_states WHERE expires_at < ?", now());
  await run(
    "INSERT INTO oidc_states (state, verifier, nonce, mode, user_id, next_path, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    state, verifier, nonce, mode, opts.userId ?? null, safeNext(opts.next), new Date(Date.now() + STATE_MINUTES * 60_000).toISOString(),
  );
  const url = new URL(`${LOGIN_BASE}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: c.clientId,
    response_type: "code",
    redirect_uri: redirectUri(req, mode),
    response_mode: "query",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    prompt: "select_account",
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  }).toString();
  return { url: url.toString(), state };
}

/**
 * Who Microsoft says signed in. `amr` (sign-in ID tokens only) lists how they proved it, e.g. ["pwd", "mfa"],
 * or null when Microsoft didn't say (v2.0 ID tokens usually leave it out; see lib/owner.ts `ownerMfaEvidence`).
 */
export type MicrosoftIdentity = { tenantId: string; objectId: string; email: string; name: string; amr?: string[] | null };

/** One saved sign-in attempt (see `startMicrosoftSignIn`). */
type SavedState = { state: string; verifier: string; nonce: string; mode: SignInMode; user_id: string | null; next_path: string | null };

// Microsoft's signing keys per tenant, fetched and cached by jose (refreshed when Microsoft rotates them).
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const keysFor = (tid: string) => {
  let k = jwks.get(tid);
  if (!k) jwks.set(tid, (k = createRemoteJWKSet(new URL(`${LOGIN_BASE}/${tid}/discovery/v2.0/keys`))));
  return k;
};

/**
 * Finishes a Microsoft sign-in: checks the state against the browser cookie, swaps the code for an ID
 * token and verifies it (signature, issuer = the person's tenant, audience = our app, expiry, nonce).
 * The saved state is used up, so the same reply can't be used twice.
 *
 * @param flow "portal" (the portal callback: modes signin and link) or "owner" (the Owner Console callback: mode
 *   owner only). A sign-in started for one is refused by the other, so a portal round trip can never open the
 *   Owner Console and the other way round.
 * @throws HttpError 400 with a plain message if anything doesn't check out
 */
export async function finishMicrosoftSignIn(req: Request, cookieState: string | undefined, flow: "portal" | "owner" = "portal"): Promise<{ who: MicrosoftIdentity; saved: SavedState }> {
  const q = new URL(req.url).searchParams;
  if (q.get("error")) {
    // The person cancelled, or their company blocked the app (e.g. admin consent needed).
    // Only Microsoft's error code is shown, never the description text: anyone can make a link to this
    // address, so free text here could put their words on Sidekick's page (security review L4). The full
    // description goes to the server log for whoever investigates.
    if (q.get("error") !== "access_denied") console.error("Microsoft sign-in error", q.get("error"), (q.get("error_description") ?? "").split("\n")[0].slice(0, 300));
    const code = (q.get("error_description") ?? "").match(/AADSTS\d{3,8}/)?.[0] ?? (q.get("error") ?? "").replace(/[^a-z_]/gi, "").slice(0, 40);
    throw new HttpError(400, q.get("error") === "access_denied" ? "Microsoft sign-in was cancelled." : `Microsoft didn't sign you in${code ? ` (${code})` : ""}. Try again; if it keeps happening, your IT team may need to approve ${BRAND.name} for your organization.`);
  }
  const state = q.get("state") ?? "";
  const code = q.get("code") ?? "";
  if (!state || !code || !cookieState || cookieState !== state) throw new HttpError(400, "That sign-in link expired or was opened in a different browser. Try again.");
  const saved = await get<SavedState & { expires_at: string }>("SELECT * FROM oidc_states WHERE state = ?", state);
  await run("DELETE FROM oidc_states WHERE state = ?", state);
  if (!saved || saved.expires_at < now()) throw new HttpError(400, "That sign-in took too long. Try again.");
  if ((saved.mode === "owner") !== (flow === "owner")) throw new HttpError(400, "That sign-in link doesn't belong here. Start again from the sign-in page.");

  const c = config();
  const tokenRes = await fetch(`${LOGIN_BASE}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(req, saved.mode),
      code_verifier: saved.verifier,
      scope: "openid profile email",
    }),
  }).catch(() => null);
  const body = (await tokenRes?.json().catch(() => null)) as { id_token?: string; error?: string; error_description?: string } | null;
  if (!tokenRes?.ok || !body?.id_token) {
    console.error("Microsoft token exchange failed", tokenRes?.status, body?.error, body?.error_description?.split("\n")[0]);
    throw new HttpError(502, "Microsoft didn't confirm the sign-in. Try again; if it keeps happening, the app's secret may have expired.");
  }

  // The tenant is read from the token first, then the token is verified with that tenant's keys and issuer.
  const unverified = JSON.parse(Buffer.from(body.id_token.split(".")[1] ?? "", "base64url").toString() || "{}") as JWTPayload & { tid?: string };
  const tid = String(unverified.tid ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(tid)) throw new HttpError(400, "Microsoft's reply didn't say which organization you belong to.");
  let claims: JWTPayload & Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(body.id_token, keysFor(tid), { issuer: `${LOGIN_BASE}/${tid}/v2.0`, audience: c.clientId, clockTolerance: 60 }));
  } catch (e) {
    console.error("Microsoft ID token rejected", e);
    throw new HttpError(400, "Microsoft's sign-in reply couldn't be verified. Try again.");
  }
  if (claims.nonce !== saved.nonce) throw new HttpError(400, "That sign-in reply doesn't match this browser. Try again.");
  if (tid === PERSONAL_TENANT) throw new HttpError(403, "Personal Microsoft accounts can't sign in. Use your work account.");
  // Single-tenant: Microsoft shouldn't issue anyone else a token for this app, but never rely on that alone.
  if (c.singleTenant && tid.toLowerCase() !== c.singleTenant.toLowerCase()) throw new HttpError(403, `Your Microsoft organization can't sign in to this ${BRAND.name}.`);
  const email = String(claims.email ?? claims.preferred_username ?? "").trim().toLowerCase();
  const oid = String(claims.oid ?? "");
  if (!oid) throw new HttpError(400, "Microsoft's reply didn't include your account id.");
  const amr = Array.isArray(claims.amr) ? claims.amr.map((m) => String(m).toLowerCase()) : null;
  return { who: { tenantId: tid, objectId: oid, email, name: String(claims.name ?? email), amr }, saved };
}

/**
 * The audiences a Teams single-sign-on token may be issued for: the Entra app's id and its Application ID URI
 * `api://<public host>/<app id>` (what the Teams manifest's `webApplicationInfo.resource` says). Empty when
 * Microsoft sign-in isn't set up.
 */
export function teamsSsoAudiences(): string[] {
  const { clientId } = config();
  if (!clientId) return [];
  const hosts = [process.env.SIDEKICK_PUBLIC_URL, process.env.SIDEKICK_TEAMS_SSO_URL].filter((u): u is string => Boolean(u)).map((u) => {
    try {
      return new URL(u).host;
    } catch {
      return "";
    }
  });
  return [clientId, ...hosts.filter(Boolean).map((h) => `api://${h}/${clientId}`)];
}

/**
 * Verifies a Teams single-sign-on token (the access token Teams gives a Sidekick tab with
 * `authentication.getAuthToken()`): signature with the person's tenant keys, issuer = that tenant (v2 tokens),
 * audience = our app (`teamsSsoAudiences`), not expired, and the `access_as_user` scope. Personal Microsoft
 * accounts are refused, and in single-tenant mode only the one tenant passes. Returns who it is.
 *
 * @throws HttpError 401 with a plain message when anything doesn't check out
 */
export async function verifyTeamsSsoToken(token: string): Promise<MicrosoftIdentity> {
  const fail = (why: string) => new HttpError(401, `Teams didn't sign you in to ${BRAND.name} (${why}). Close the tab and open it again.`);
  const audiences = teamsSsoAudiences();
  if (!audiences.length) throw new HttpError(503, `Microsoft sign-in isn't set up on this ${BRAND.name} yet.`);
  if (!token || token.length > 8000 || token.split(".").length !== 3) throw fail("no token");
  let unverified: JWTPayload & { tid?: string };
  try {
    unverified = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString() || "{}");
  } catch {
    throw fail("unreadable token");
  }
  const tid = String(unverified.tid ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(tid)) throw fail("no organization");
  let claims: JWTPayload & Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(token, keysFor(tid), { issuer: `${LOGIN_BASE}/${tid}/v2.0`, audience: audiences, clockTolerance: 60 }));
  } catch (e) {
    console.error("Teams SSO token rejected", e instanceof Error ? e.message : e);
    throw fail("token not accepted");
  }
  if (!String(claims.scp ?? "").split(" ").includes("access_as_user")) throw fail("wrong permission");
  if (tid === PERSONAL_TENANT) throw new HttpError(403, `Personal Microsoft accounts can't use ${BRAND.name}. Use your work account.`);
  const single = config().singleTenant;
  if (single && tid.toLowerCase() !== single.toLowerCase()) throw new HttpError(403, `Your Microsoft organization can't use this ${BRAND.name}.`);
  const oid = String(claims.oid ?? "");
  if (!oid) throw fail("no account id");
  const email = String(claims.preferred_username ?? claims.upn ?? claims.email ?? "").trim().toLowerCase();
  return { tenantId: tid, objectId: oid, email, name: String(claims.name ?? email) };
}
