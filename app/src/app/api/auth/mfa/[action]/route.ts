/**
 * GET/POST /api/auth/mfa/:action: two-step sign-in for portal users (authenticator app, passkeys, backup
 * codes, and the second step at sign-in). Everyone manages only their own; see lib/mfa-routes.ts for the actions.
 */
import { mfaRoutes } from "@/lib/mfa-routes";

const routes = mfaRoutes("user");
export const GET = routes.GET;
export const POST = routes.POST;
