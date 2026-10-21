/**
 * @file Self-service sign-up: a company creates its own Sidekick organization at /signup.
 *
 * Concepts
 * - **What sign-up creates**: the organization, its Org Owner (the person signing up, with the password
 *   they chose), and a subscription on the chosen plan in its free trial (lib/billing.ts `startTrial`), all
 *   in one transaction. The route then signs them in and sends them to checkout.
 * - **Switch**: self-service sign-up is **off by default** (a fresh install or deploy refuses it), so
 *   strangers can't create organizations that use real Claude credit until the Sidekick team decides to.
 *   Open it in the Owner Console (Releases & switches → "Self-service sign-up", key `signup` in
 *   lib/owner.ts) or with `SIDEKICK_SIGNUP_OPEN=true` on the deploy; the Owner Console switch, once
 *   flipped, wins over the env var. Closed = only the Sidekick team adds clients.
 * - **Sign-up limit**: like the sign-in limit (lib/login-limit.ts), stored in the database so it holds
 *   across app copies: at most `SIGNUP_LIMIT` attempts (successful or not) per IP address per
 *   `SIGNUP_WINDOW_MINUTES`. Stops one machine creating many organizations or probing which emails exist.
 * - **One account per email**: emails are unique across every organization (as everywhere in Sidekick),
 *   so an email that already has an account anywhere is refused.
 * - **Sign up with Microsoft (later)**: pass `microsoft` with the tenant id and the person's object id
 *   from a verified Microsoft sign-in (lib/entra.ts). The organization is then tied to that tenant
 *   (`orgs.entra_tenant_id`) and the Org Owner to their Microsoft account (`users.entra_oid`), and no
 *   password is needed (a random one is stored, never shown). The Microsoft route itself isn't built here.
 */
import "server-only";
import crypto from "node:crypto";
import { requireText } from "./api";
import { audit, createOrgWithOwner, HttpError } from "./auth";
import { requirePlan, startTrial } from "./billing";
import { get, newId, now, run, tx } from "./db";
import { flagEnabled, platformLog } from "./owner";
import { assertGoodPassword } from "./passwords";
import { planById } from "./plans";
import { span, traceScope } from "./trace";

/** Sign-up attempts allowed per IP address within the window. */
export const SIGNUP_LIMIT = 5;
/** How long attempts count. */
export const SIGNUP_WINDOW_MINUTES = 60;

/** Shown when sign-up isn't open (the default) or was switched off in the Owner Console. */
export const SIGNUP_CLOSED = "Self-service sign-up isn't open yet. Contact the Sidekick team (see Support) to get an organization set up.";

/** What the sign-up form sends. */
export type SignUpInput = {
  org?: unknown;
  name?: unknown;
  email?: unknown;
  password?: unknown;
  plan?: unknown;
  /** From a verified Microsoft sign-in (later). */
  microsoft?: { tenantId: string; oid: string };
};

/** Whether self-service sign-up is open (the Owner Console switch). */
export const signupOpen = () => flagEnabled("signup");

/**
 * Creates the organization, its Org Owner and the trial subscription. Throws HttpError: 403 when sign-up is
 * closed, 429 after too many attempts from this address, 400 for missing or invalid fields, 409 when the
 * email already has an account (or the Microsoft tenant already has an organization). Returns the new ids;
 * the caller signs the person in.
 */
export async function signUp(input: SignUpInput, ip: string): Promise<{ orgId: string; userId: string; plan: string }> {
  if (!(await signupOpen())) throw new HttpError(403, SIGNUP_CLOSED);
  await run("DELETE FROM signup_attempts WHERE created_at < ?", new Date(Date.now() - 86400_000).toISOString());
  const since = new Date(Date.now() - SIGNUP_WINDOW_MINUTES * 60_000).toISOString();
  if (ip) {
    const n = Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM signup_attempts WHERE ip = ? AND created_at > ?", ip, since))?.n ?? 0);
    if (n >= SIGNUP_LIMIT) throw new HttpError(429, `Too many sign-up attempts from your network. Wait an hour and try again, or contact the Sidekick team.`);
  }
  await run("INSERT INTO signup_attempts (id, ip, created_at) VALUES (?, ?, ?)", newId(), ip || null, now());

  const org = requireText(input.org, "Organization name", 120);
  const name = requireText(input.name, "Your name", 120);
  const email = requireText(input.email, "Work email", 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  const plan = requirePlan(input.plan);
  const ms = input.microsoft;
  let password: string;
  if (ms) password = crypto.randomBytes(24).toString("base64url");
  else {
    password = requireText(input.password, "Password", 200);
    await assertGoodPassword(password, { email });
  }
  if (await get("SELECT id FROM users WHERE email = ?", email)) throw new HttpError(409, "An account with that email already exists. Sign in instead, or use another email.");
  if (ms && (await get("SELECT id FROM orgs WHERE entra_tenant_id = ?", ms.tenantId))) throw new HttpError(409, "Your Microsoft organization already uses Sidekick. Ask its Org Owner to add you.");

  return span("billing", "Sign up", async () => {
    const ids = await tx(async () => {
      const created = await createOrgWithOwner(org, { name, email, password }, { entraTenantId: ms?.tenantId, entraOid: ms?.oid });
      await startTrial(created.orgId, plan, name);
      return created;
    });
    traceScope({ orgId: ids.orgId, actor: name, userId: ids.userId });
    await audit({ org_id: ids.orgId, name }, `Signed up: created organization “${org}” on the ${planById(plan)!.name} plan (free trial)`, "Access");
    await platformLog("Self-service sign-up", `New organization ${org} (${email}) on the ${planById(plan)!.name} plan`);
    return { ...ids, plan };
  }, { plan });
}
