/**
 * GET/POST /api/owner/auth/mfa/:action: two-step sign-in for Owner Console owners (authenticator app,
 * passkeys, backup codes, and the second step at sign-in). See lib/mfa-routes.ts for the actions.
 */
import { mfaRoutes } from "@/lib/mfa-routes";

const routes = mfaRoutes("owner");
export const GET = routes.GET;
export const POST = routes.POST;
