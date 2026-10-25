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
 * Roles: owner = Org Owner, admin = Org Admin, lead = Team Lead, member = Member, viewer = Viewer (the Billing
 * Admin role was retired in October 2026). Team Leads, Members and Viewers are in workspace A only; Org Owners and
 * Org Admins see every workspace.
 */
export const EVERYONE = ["owner", "admin", "lead", "member", "viewer"];
const ADMINS = ["owner", "admin"];
const MANAGERS = ["owner", "admin", "lead"];
const EDITORS = ["owner", "admin", "lead", "member"];
const NOPE = "00000000-0000-4000-8000-000000000000";

export const MATRIX = [
  // Everyone signed in
  { what: "See the home page numbers for their workspaces", method: "GET", url: () => "/api/overview", allow: EVERYONE },
  { what: "See own profile", method: "GET", url: () => "/api/me", allow: EVERYONE },
  { what: "List the workspaces they can see", method: "GET", url: () => "/api/workspaces", allow: EVERYONE },
  { what: "See live status on the home page (names: admins only)", method: "GET", url: () => "/api/activity?view=live", allow: EVERYONE },
  { what: "Use the home assistant", method: "POST", url: () => "/api/assistant", body: { message: "" }, allow: EVERYONE },
  { what: "See the rules Sidekick follows (Help & support)", method: "GET", url: (s) => `/api/rules?ws=${s.wsA}`, allow: EVERYONE },
  { what: "Open Guardrails (switches, custom rules and their text, how often rules fired)", method: "GET", url: () => "/api/guardrails", allow: ADMINS },
  { what: "See Microsoft sign-in status", method: "GET", url: () => "/api/auth/microsoft", allow: EVERYONE },
  // Inside a workspace they belong to (read)
  { what: "Read documents in their workspaces", method: "GET", url: (s) => `/api/docs?ws=${s.wsA}`, allow: EVERYONE },
  { what: "Read meetings in their workspaces", method: "GET", url: (s) => `/api/meetings?ws=${s.wsA}`, allow: EVERYONE },
  { what: "Read the knowledge map and gaps", method: "GET", url: (s) => `/api/memory?ws=${s.wsA}`, allow: EVERYONE },
  { what: "Ask Sidekick questions", method: "POST", url: (s) => "/api/ask", body: (s) => ({ ws: s.wsA, question: "" }), allow: EVERYONE },
  { what: "Rate answers 👍/👎", method: "POST", url: () => "/api/feedback", body: (s) => ({ ws: s.wsA, questionId: NOPE, vote: "up" }), allow: EVERYONE },
  { what: "See the firm library", method: "GET", url: () => "/api/firm", allow: EVERYONE },
  { what: "See which tools feed their group (its page's Sources line)", method: "GET", url: (s) => `/api/workspaces/${s.wsA}/sources`, allow: EVERYONE },
  { what: "Open Connectors: which tool types are allowed, their groups' connections and linked projects", method: "GET", url: () => "/api/connectors", allow: MANAGERS },
  { what: "See a group's last 30 days (Team Leads: their own groups)", method: "GET", url: (s) => `/api/workspaces/${s.wsA}/usage`, allow: MANAGERS },
  { what: "See Needs attention for their groups", method: "GET", url: () => "/api/findings", allow: EVERYONE },
  // Change workspace content
  { what: "Upload documents", method: "POST", url: () => "/api/docs", form: (s) => ({ ws: s.wsA }), allow: EDITORS },
  { what: "Change or delete a document", method: "DELETE", url: () => `/api/docs/${NOPE}`, allow: EDITORS },
  { what: "Keep or move a held document (may be another client's)", method: "POST", url: () => `/api/docs/${NOPE}`, body: { action: "keep" }, allow: EDITORS },
  { what: "Confirm a flagged document belongs in its group", method: "POST", url: () => `/api/docs/${NOPE}`, body: { action: "review" }, allow: MANAGERS },
  { what: "Add a past or outside meeting", method: "POST", url: () => "/api/meetings", form: (s) => ({ ws: s.wsA }), allow: EDITORS },
  { what: "Save a meeting item to knowledge", method: "PATCH", url: () => `/api/items/${NOPE}`, body: { saved: true }, allow: EDITORS },
  { what: "See the automatic-notes panel", method: "GET", url: () => "/api/meetings/auto", allow: EVERYONE },
  { what: "Pick the group for a Teams meeting several groups were in", method: "POST", url: () => "/api/meetings/auto", body: { action: "assign", id: NOPE, ws: NOPE }, allow: MANAGERS },
  { what: "Reprocess or delete a meeting", method: "DELETE", url: () => `/api/meetings/${NOPE}`, allow: EDITORS },
  { what: "Update action items", method: "PATCH", url: () => `/api/action-items/${NOPE}`, body: { status: "Done" }, allow: EDITORS },
  { what: "Refresh the knowledge map", method: "POST", url: () => "/api/memory/refresh", body: { ws: NOPE }, allow: EDITORS },
  { what: "Resolve or dismiss knowledge gaps", method: "POST", url: () => "/api/gaps", body: {}, allow: EDITORS },
  { what: "Snooze a Needs attention item", method: "POST", url: () => "/api/findings", body: { id: NOPE, action: "snooze" }, allow: MANAGERS },
  // Money
  { what: "See Usage & billing (the whole company's AI spend)", method: "GET", url: () => "/api/usage", allow: ADMINS },
  { what: "See the plan and subscription", method: "GET", url: () => "/api/billing", allow: ADMINS },
  { what: "Export usage per group (CSV, for chargeback)", method: "GET", url: () => "/api/usage/export?months=1", allow: ADMINS },
  { what: "Pay, change the plan or extra groups, or cancel it", method: "POST", url: () => "/api/billing", body: { action: "nope" }, allow: ["owner"] },
  // Running the organization
  { what: "Create workspaces", method: "POST", url: () => "/api/workspaces", body: {}, allow: ADMINS },
  { what: "Rename a workspace or change its engagement code", method: "PATCH", url: () => `/api/workspaces/${NOPE}`, body: {}, allow: ADMINS },
  { what: "Delete a workspace and everything in it", method: "DELETE", url: () => `/api/workspaces/${NOPE}`, allow: ADMINS },
  { what: "End a group (roll-off)", method: "POST", url: () => `/api/workspaces/${NOPE}/rolloff`, body: {}, allow: ADMINS },
  { what: "Cancel a group's ending", method: "DELETE", url: () => `/api/workspaces/${NOPE}/rolloff`, allow: ADMINS },
  { what: "Export a group (zip)", method: "GET", url: () => `/api/workspaces/${NOPE}/export`, allow: ADMINS },
  { what: "Export the whole organization's data (zip)", method: "GET", url: () => "/api/export", allow: ADMINS },
  { what: "See roll-offs and deletion certificates", method: "GET", url: () => "/api/rolloffs", allow: ADMINS },
  { what: "Add to the firm library", method: "POST", url: () => "/api/firm", form: () => ({}), allow: ADMINS },
  { what: "Turn automatic notes after Teams meetings on or off", method: "PUT", url: () => "/api/meetings/auto", body: {}, allow: ADMINS },
  { what: "Look for new Teams meetings now", method: "POST", url: () => "/api/meetings/auto", body: { action: "check" }, allow: ADMINS, skipAllowed: true },
  { what: "Try a skipped Teams meeting again", method: "POST", url: () => "/api/meetings/auto", body: { action: "retry", id: NOPE }, allow: ADMINS },
  { what: "Connect an allowed tool for their groups with the client's account, reconnect or disconnect it (Team Leads: their groups)", method: "DELETE", url: () => `/api/connectors/${NOPE}`, allow: MANAGERS },
  { what: "Link a tool's project to their groups, sync or unlink it", method: "POST", url: () => "/api/connectors/links", body: {}, allow: MANAGERS },
  { what: "Ask the Org Owner to allow a tool type for their group (Team Leads: their groups)", method: "POST", url: () => "/api/connectors/requests", body: {}, allow: MANAGERS },
  { what: "List a connected tool's projects (to link one)", method: "GET", url: () => `/api/connectors/${NOPE}/projects`, allow: MANAGERS },
  { what: "Change or delete a firm library document", method: "DELETE", url: () => `/api/firm/${NOPE}`, allow: ADMINS },
  { what: "Keep, limit or move a held firm library document", method: "POST", url: () => `/api/firm/${NOPE}`, body: { action: "keep" }, allow: ADMINS },
  { what: "See answer quality (👍/👎 counts)", method: "GET", url: () => "/api/feedback", allow: ADMINS },
  { what: "Download a deletion certificate", method: "GET", url: () => `/api/rolloffs/${NOPE}/certificate`, allow: ADMINS },
  // People and Teams links: admins everywhere, Team Leads only in the workspaces they lead (the walls test that part)
  { what: "See people (Team Leads: only people in their workspaces)", method: "GET", url: () => "/api/users", allow: MANAGERS },
  { what: "Add people (Team Leads: only as Member or Viewer, to their workspaces)", method: "POST", url: () => "/api/users", body: {}, allow: MANAGERS },
  { what: "Change which workspaces a person is in (Team Leads: Members and Viewers in their workspaces)", method: "PATCH", url: () => `/api/users/${NOPE}`, body: {}, allow: MANAGERS },
  { what: "Remove a person from the organization", method: "DELETE", url: () => `/api/users/${NOPE}`, allow: ADMINS },
  { what: "Link Teams channels and chats (Team Leads: to their workspaces)", method: "POST", url: () => "/api/teams-links", body: { ws: NOPE }, allow: MANAGERS },
  { what: "Change a Teams link (guests) or unlink it (Team Leads: in their workspaces)", method: "PATCH", url: () => "/api/teams-links", body: { id: NOPE }, allow: MANAGERS },
  { what: "Choose which chats get a group's meeting notes (Team Leads: their own groups)", method: "PUT", url: (s) => `/api/workspaces/${s.wsA}/notes-chats`, body: {}, allow: MANAGERS },
  { what: "Send a test message to one of a group's chats (Team Leads: their own groups)", method: "POST", url: (s) => `/api/workspaces/${s.wsA}/notes-chats/test`, body: { chatId: NOPE }, allow: MANAGERS },
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
  { what: "Allow or stop a tool type for the organization (Azure DevOps, Jira, GitHub, Confluence, Microsoft 365)", method: "PUT", url: () => "/api/connectors/kinds", body: { kind: "nope", allowed: true }, allow: ["owner"] },
  { what: "Approve or decline a request to allow a tool type", method: "POST", url: () => `/api/connectors/requests/${NOPE}`, body: { action: "approve" }, allow: ["owner"] },
];
