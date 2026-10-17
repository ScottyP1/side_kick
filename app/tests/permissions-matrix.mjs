/**
 * The permission matrix: for every protected action, which roles may do it. This is the single list the
 * roles guide (docs/guide/roles-and-permissions.md) describes, and tests/api.test.mjs checks every row
 * against the running app for every role, so the guide and the code can't drift apart.
 *
 * Each row: `what` (plain words, as in the guide), the request (`method`, `url(s)` and an optional body,
 * or `form` for uploads), and `allow`, the roles that must get through the role check. Everyone else must
 * get 403. Requests are built to fail *after* the role check (missing fields, unknown ids), so allowed
 * roles get a 400/404 instead of changing anything, except the harmless reads. `skipAllowed` rows only
 * check that the other roles are refused (running them would disconnect or change real settings).
 *
 * Roles: owner = Org Owner, admin = Org Admin, billing = Billing Admin, member = Member, viewer = Viewer.
 * Billing Admins, Members and Viewers are in workspace A only; Org Owners and Org Admins see every workspace.
 */
export const EVERYONE = ["owner", "admin", "billing", "member", "viewer"];
const ADMINS = ["owner", "admin"];
const EDITORS = ["owner", "admin", "member"];
const NOPE = "00000000-0000-4000-8000-000000000000";

export const MATRIX = [
  // Everyone signed in
  { what: "See the home page numbers for their workspaces", method: "GET", url: () => "/api/overview", allow: EVERYONE },
  { what: "See own profile", method: "GET", url: () => "/api/me", allow: EVERYONE },
  { what: "List the workspaces they can see", method: "GET", url: () => "/api/workspaces", allow: EVERYONE },
  { what: "See live status on the home page (names: admins only)", method: "GET", url: () => "/api/activity?view=live", allow: EVERYONE },
  { what: "Use the home assistant", method: "POST", url: () => "/api/assistant", body: { message: "" }, allow: EVERYONE },
  { what: "See the guardrails in force", method: "GET", url: () => "/api/guardrails", allow: EVERYONE },
  { what: "See Microsoft sign-in status", method: "GET", url: () => "/api/auth/microsoft", allow: EVERYONE },
  // Inside a workspace they belong to (read)
  { what: "Read documents in their workspaces", method: "GET", url: (s) => `/api/docs?ws=${s.wsA}`, allow: EVERYONE },
  { what: "Read meetings in their workspaces", method: "GET", url: (s) => `/api/meetings?ws=${s.wsA}`, allow: EVERYONE },
  { what: "Read the knowledge map and gaps", method: "GET", url: (s) => `/api/memory?ws=${s.wsA}`, allow: EVERYONE },
  { what: "Ask Sidekick questions", method: "POST", url: (s) => "/api/ask", body: (s) => ({ ws: s.wsA, question: "" }), allow: EVERYONE },
  // Change workspace content
  { what: "Upload documents", method: "POST", url: () => "/api/docs", form: (s) => ({ ws: s.wsA }), allow: EDITORS },
  { what: "Change or delete a document", method: "DELETE", url: () => `/api/docs/${NOPE}`, allow: EDITORS },
  { what: "Import meetings", method: "POST", url: () => "/api/meetings", form: (s) => ({ ws: s.wsA }), allow: EDITORS },
  { what: "Reprocess or delete a meeting", method: "DELETE", url: () => `/api/meetings/${NOPE}`, allow: EDITORS },
  { what: "Update action items", method: "PATCH", url: () => `/api/action-items/${NOPE}`, body: { status: "Done" }, allow: EDITORS },
  { what: "Refresh the knowledge map", method: "POST", url: () => "/api/memory/refresh", body: { ws: NOPE }, allow: EDITORS },
  { what: "Resolve or dismiss knowledge gaps", method: "POST", url: () => "/api/gaps", body: {}, allow: EDITORS },
  // Money
  { what: "See Usage & billing (the whole company's AI spend)", method: "GET", url: () => "/api/usage", allow: ["owner", "admin", "billing"] },
  // Running the organization
  { what: "Create workspaces", method: "POST", url: () => "/api/workspaces", body: {}, allow: ADMINS },
  { what: "See people and roles", method: "GET", url: () => "/api/users", allow: ADMINS },
  { what: "Add people", method: "POST", url: () => "/api/users", body: {}, allow: ADMINS },
  { what: "Change or remove a person", method: "PATCH", url: () => `/api/users/${NOPE}`, body: {}, allow: ADMINS },
  { what: "Link Teams channels and chats", method: "POST", url: () => "/api/teams-links", body: { ws: NOPE }, allow: ADMINS },
  { what: "Change a Teams link (guests) or unlink it", method: "PATCH", url: () => "/api/teams-links", body: { id: NOPE }, allow: ADMINS },
  { what: "See the audit log", method: "GET", url: () => "/api/audit", allow: ADMINS },
  { what: "See Activity (traces and performance)", method: "GET", url: () => "/api/activity?view=overview", allow: ADMINS },
  { what: "Change branding (logo, brand color)", method: "PUT", url: () => "/api/settings", body: {}, allow: ADMINS, skipAllowed: true },
  { what: "Make a workspace's guardrails stricter", method: "PUT", url: () => "/api/guardrails/workspace", body: { ws: NOPE }, allow: ADMINS },
  { what: "See and write custom guardrail rules", method: "GET", url: () => "/api/guardrails/rules", allow: ADMINS },
  { what: "Use the guardrails Test it box", method: "POST", url: () => "/api/guardrails/test", body: {}, allow: ADMINS },
  // Org Owner only
  { what: "Turn organization guardrail switches on or off", method: "PUT", url: () => "/api/guardrails", body: {}, allow: ["owner"] },
  { what: "Connect Microsoft sign-in", method: "GET", url: () => "/api/auth/microsoft/start?mode=link", allow: ["owner"] },
  { what: "Require Microsoft sign-in for everyone", method: "PATCH", url: () => "/api/auth/microsoft", body: {}, allow: ["owner"], skipAllowed: true },
  { what: "Disconnect Microsoft sign-in", method: "DELETE", url: () => "/api/auth/microsoft", allow: ["owner"], skipAllowed: true },
];
