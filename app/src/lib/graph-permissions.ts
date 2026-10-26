/**
 * @file Settings → Microsoft permissions: one checklist of every Microsoft permission Sidekick asks for, what each
 * one unlocks, and whether the organization's Microsoft admin has approved it, so a strict IT team sees exactly
 * what it's agreeing to and nothing depends on a feature failing first.
 *
 * Concepts
 * - **Application permissions** belong to Sidekick's app registration (one list for every customer) and are
 *   approved per customer tenant by a Microsoft admin, all at once, with "Approve Sidekick for your organization"
 *   (the admin-consent round trip in lib/directory.ts). When Sidekick adds a permission, tenants that approved
 *   before must approve once more: approving again only adds the new ones.
 * - **Status** of each row: `approved`, `missing` (Not approved) or `unknown` (Not checked yet), from two sources:
 *   1. **Check now** (Org Owners/Admins): one call to Microsoft for a fresh app token, whose `roles` claim lists
 *      every application permission granted in the tenant (`appTokenRoles`). No Graph probing. The result is kept
 *      on the org (`orgs.graph_roles`, `graph_roles_at`, `graph_roles_by`), never fetched on a page load. Also
 *      run once right after an approval comes back.
 *   2. **Refusals features already recorded**: automatic notes (`auto_meetings.last_error` with
 *      `TRANSCRIPT_DENIED`, `ADHOC_DENIED` or `NOT_APPROVED`), automatic recording (`record_error` =
 *      `RECORD_DENIED`), leaving chats (`teams_conversations.leave_error = 'consent'`). A refusal counts only when it
 *      is newer than the last check and the last approval; otherwise the check (or "Not checked yet") stands.
 * - **Teams chat permissions** (`ChatMessage.Read.Chat`, `ChannelMessage.Read.Group`) are resource-specific: Teams
 *   grants them per chat or team when Sidekick is added there, not through the approve button. They're listed
 *   apart, with the chats Microsoft refused (`call_watch.error`).
 * - **Delegated permissions** (`User.Read`, `access_as_user`) are signing in as the person; they're part of the
 *   same approval and are listed as notes, without a status (they don't show in the app token).
 *
 * Who may call: `permissionsStatus` for Org Owners, Org Admins (who may act) and Team Leads (read-only), checked by
 * the route; `checkPermissions` for Org Owners/Admins (audited) and the admin-consent callback.
 * Everything is per organization: its own tenant and rows.
 */
import "server-only";
import { all, asSystem, get, now, run } from "./db";
import { audit, HttpError, type User } from "./auth";
import { appTokenRoles, NOT_APPROVED } from "./directory";
import { entraConfigured } from "./entra";
import { tenantOfOrg } from "./tenants";
import { span, spanAttrs } from "./trace";
import { ADHOC_DENIED, TRANSCRIPT_DENIED } from "./meetings-graph";
import { RECORD_DENIED } from "./auto-record";
import { REMIND_DENIED } from "./meeting-nudge";
import { BRAND } from "./brand";

/** A feature a permission unlocks, with the portal page where it lives (if it has one). */
export type PermissionFeature = { label: string; href?: string };

/** One application permission Sidekick asks for, in plain words. */
export type AppPermission = {
  /** Microsoft's name, exactly as in the app registration and the token's `roles` claim. */
  id: string;
  /** What it's called on the checklist. */
  name: string;
  /** What Sidekick does with it, and what it never does. */
  what: string;
  features: PermissionFeature[];
};

const MEETINGS: PermissionFeature = { label: "Meeting notes", href: "/meetings" };
const MEET_NOW: PermissionFeature = { label: "Meet now calls", href: "/meetings" };
const AUTO_RECORD: PermissionFeature = { label: "Meetings record by themselves", href: "/meetings" };
const MEETING_REMINDER: PermissionFeature = { label: "Transcription reminders for scheduled meetings", href: "/workspaces" };

/**
 * Every application permission in Sidekick's app registration (keep in step with lib/directory.ts
 * `PERMISSIONS_EXPLAINED`, lib/meetings-graph.ts, lib/auto-record.ts, lib/meeting-nudge.ts, lib/teams/install.ts and
 * docs/TEAMS-MULTITENANT.md).
 */
export const APP_PERMISSIONS: AppPermission[] = [
  {
    id: "User.Read.All", name: "Read people in your directory",
    what: `Names, work emails, job titles and account ids only. ${BRAND.name} never changes anything in Microsoft 365.`,
    features: [{ label: "Import from Microsoft 365", href: "/users" }, { label: "Recognise people added by email", href: "/meetings" }, { label: `@${BRAND.name} add in Teams` }],
  },
  {
    id: "OnlineMeetings.Read.All", name: "Read Teams meeting details",
    what: "A meeting's subject, times and invitees, to find the right group. Meetings that aren't any group's are skipped.",
    features: [MEETINGS, MEETING_REMINDER],
  },
  {
    id: "OnlineMeetingTranscript.Read.All", name: "Read Teams meeting transcripts",
    what: `The transcript Teams made, to write the notes. ${BRAND.name} never joins a call.`,
    features: [MEETINGS],
  },
  {
    id: "CallTranscripts.Read.All", name: "Read transcripts of Meet now calls",
    what: "Calls started with Meet now (for example in a group chat), which Microsoft keeps apart from scheduled meetings.",
    features: [MEET_NOW],
  },
  {
    id: "Calendars.ReadBasic.All", name: "Read meeting times in calendars",
    what: "Times, subject, invitees and Teams link of a group's meetings in the next 7 days, never the invitation text. Only when recording by itself or transcription reminders are on.",
    features: [AUTO_RECORD, MEETING_REMINDER],
  },
  {
    id: "OnlineMeetings.ReadWrite.All", name: "Turn on Record and transcribe for meetings",
    what: "Sets Record and transcribe automatically on meetings clearly one group's. Changes nothing else, never meetings with outsiders.",
    features: [AUTO_RECORD],
  },
  {
    id: "TeamsAppInstallation.ReadWriteSelfForChat.All", name: `Remove ${BRAND.name} from Teams chats`,
    what: `Lets ${BRAND.name} leave a chat it shouldn't be in (added by someone who may not, never assigned, or removed in the portal). Only ${BRAND.name}, never other apps.`,
    features: [{ label: "Leaves chats it shouldn't be in", href: "/workspaces" }],
  },
  {
    id: "TeamsAppInstallation.ReadWriteSelfForTeam.All", name: `Remove ${BRAND.name} from Teams teams`,
    what: `The same for a team's channels. Only ${BRAND.name}, never other apps.`,
    features: [{ label: "Leaves teams it shouldn't be in", href: "/workspaces" }],
  },
];

/** Teams' per-chat permissions (resource-specific consent, in the Teams app package). */
export const CHAT_PERMISSIONS: AppPermission[] = [
  {
    id: "ChatMessage.Read.Chat", name: "Read messages in chats it's added to",
    what: `Granted by Teams in each chat when ${BRAND.name} is added there. ${BRAND.name} reads a chat only once it's assigned to a group.`,
    features: [{ label: "Transcription reminders for calls", href: "/workspaces" }, { label: "Answers in group chats" }],
  },
  {
    id: "ChannelMessage.Read.Group", name: "Read messages in teams it's added to",
    what: `The same for a team's channels, granted when ${BRAND.name} is added to the team.`,
    features: [{ label: "Answers in channels" }],
  },
];

/** Delegated permissions (signing in as the person), part of the same approval, shown as notes. */
export const DELEGATED_PERMISSIONS = [
  { id: "User.Read", name: `Sign in to ${BRAND.name} with a work account`, what: "Their name, email and account id." },
  { id: "access_as_user", name: `Sign in to the ${BRAND.name} tab in Teams`, what: "Without a password." },
];

export type PermissionStatus = "approved" | "missing" | "unknown";

/** One row of the checklist as the page shows it. */
export type PermissionRow = AppPermission & {
  status: PermissionStatus;
  /** Why it's marked Not approved when a feature was refused, e.g. "Automatic notes were refused on Oct 25". */
  reason: string | null;
};

/** What Settings → Microsoft permissions shows. */
export type PermissionsStatus = {
  /** Microsoft is set up on this Sidekick (the app registration exists). */
  configured: boolean;
  /** The organization is connected to its Microsoft tenant (Settings → Microsoft sign-in). */
  connected: boolean;
  /** Org Owners/Admins may press Check now and Approve; Team Leads only look. */
  canAct: boolean;
  approvedAt: string | null;
  checkedAt: string | null;
  checkedBy: string | null;
  rows: PermissionRow[];
  chats: PermissionRow[];
  delegated: typeof DELEGATED_PERMISSIONS;
};

type Refusal = { ids: string[]; at: string | null; reason: string };

/** Refusals the features recorded (see the file header), with when they happened. */
async function recordedRefusals(orgId: string, tenant: string | null): Promise<Refusal[]> {
  const out: Refusal[] = [];
  const m = await get<{ last_error: string | null; last_error_at: string | null; record_error: string | null; record_checked_at: string | null; directory_error: string | null; directory_error_at: string | null; remind_error: string | null; remind_checked_at: string | null }>(
    "SELECT last_error, last_error_at, record_error, record_checked_at, directory_error, directory_error_at, remind_error, remind_checked_at FROM auto_meetings WHERE org_id = ?", orgId,
  );
  if (m?.remind_error === REMIND_DENIED) out.push({ ids: ["Calendars.ReadBasic.All", "OnlineMeetings.Read.All"], at: m.remind_checked_at, reason: "Microsoft refused reading scheduled meetings for transcription reminders" });
  if (m?.directory_error) out.push({ ids: ["User.Read.All"], at: m.directory_error_at, reason: "Microsoft refused reading your directory to recognise people in meetings" });
  if (m?.last_error === NOT_APPROVED) out.push({ ids: APP_PERMISSIONS.map((p) => p.id), at: m.last_error_at, reason: "Microsoft refused automatic notes: not approved at all" });
  if (m?.last_error === TRANSCRIPT_DENIED) out.push({ ids: ["OnlineMeetingTranscript.Read.All", "OnlineMeetings.Read.All"], at: m.last_error_at, reason: "Microsoft refused reading meeting transcripts" });
  if (m?.last_error === ADHOC_DENIED) out.push({ ids: ["CallTranscripts.Read.All"], at: m.last_error_at, reason: "Microsoft refused reading Meet now call transcripts" });
  if (m?.record_error === RECORD_DENIED) out.push({ ids: ["Calendars.ReadBasic.All", "OnlineMeetings.ReadWrite.All"], at: m.record_checked_at, reason: "Microsoft refused turning on recording" });
  if (m?.record_error === NOT_APPROVED) out.push({ ids: APP_PERMISSIONS.map((p) => p.id), at: m.record_checked_at, reason: "Microsoft refused automatic recording: not approved at all" });
  if (tenant) {
    // Chats being left are often unlinked (no org yet): walled by the org's own tenant, as lib/watchers.ts does.
    const left = await asSystem("Teams chats without an org", () => all<{ kind: string; at: string | null }>(
      "SELECT kind, MAX(leave_tried_at) AS at FROM teams_conversations WHERE tenant_id = ? AND leaving IS NOT NULL AND leave_error = 'consent' GROUP BY kind", tenant,
    ));
    for (const l of left) {
      out.push({ ids: [l.kind === "channel" ? "TeamsAppInstallation.ReadWriteSelfForTeam.All" : "TeamsAppInstallation.ReadWriteSelfForChat.All"], at: l.at, reason: `Microsoft refused ${BRAND.name} leaving a ${l.kind === "channel" ? "team" : "chat"}` });
    }
  }
  return out;
}

/**
 * The checklist for this organization: each permission with its status (the last Check now, overruled by a
 * feature's refusal recorded since then and since the last approval). Reads only the database: never calls Microsoft.
 */
export async function permissionsStatus(user: User, opts: { canAct: boolean }): Promise<PermissionsStatus> {
  return span("microsoft", "Show Microsoft permissions", async () => {
    const org = await get<{ entra_tenant_id: string | null; graph_consent_at: string | null; graph_roles: string | null; graph_roles_at: string | null; graph_roles_by: string | null }>(
      "SELECT entra_tenant_id, graph_consent_at, graph_roles, graph_roles_at, graph_roles_by FROM orgs WHERE id = ?", user.org_id,
    );
    const tenant = org?.entra_tenant_id ?? null;
    // A check from before the latest approval is out of date: the approval may have added permissions.
    const fresh = org?.graph_roles_at && (!org.graph_consent_at || org.graph_roles_at >= org.graph_consent_at);
    const granted = fresh && org?.graph_roles ? new Set(JSON.parse(org.graph_roles) as string[]) : null;
    const since = [org?.graph_roles_at, org?.graph_consent_at].filter(Boolean).sort().pop() ?? "";
    const refusals = (await recordedRefusals(user.org_id, tenant)).filter((r) => (r.at ?? "") > since);
    const rows: PermissionRow[] = APP_PERMISSIONS.map((p) => {
      const refused = refusals.find((r) => r.ids.includes(p.id));
      if (refused) return { ...p, status: "missing", reason: `${refused.reason}${refused.at ? ` on ${refused.at.slice(0, 10)}` : ""}.` };
      return { ...p, status: granted ? (granted.has(p.id) ? "approved" : "missing") : "unknown", reason: null };
    });
    const watched = await get<{ ok: number | null; refused: number | null }>(
      "SELECT SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN error IS NULL THEN 0 ELSE 1 END) AS refused FROM call_watch WHERE org_id = ?", user.org_id,
    );
    const refusedChats = Number(watched?.refused ?? 0);
    const chats: PermissionRow[] = CHAT_PERMISSIONS.map((p) => p.id === "ChatMessage.Read.Chat"
      ? {
        ...p,
        status: refusedChats ? "missing" : Number(watched?.ok ?? 0) ? "approved" : "unknown",
        reason: refusedChats ? `Microsoft refused it in ${refusedChats} chat${refusedChats === 1 ? "" : "s"}: see the group's Teams chats tab.` : null,
      }
      : { ...p, status: "unknown", reason: null });
    return {
      configured: entraConfigured(),
      connected: Boolean(tenant),
      canAct: opts.canAct,
      approvedAt: org?.graph_consent_at ?? null,
      checkedAt: org?.graph_roles_at ?? null,
      checkedBy: org?.graph_roles_by ?? null,
      rows,
      chats,
      delegated: DELEGATED_PERMISSIONS,
    };
  });
}

/**
 * "Check now": asks Microsoft which application permissions the organization's tenant has granted Sidekick (one
 * fresh app token, its `roles` claim) and keeps the answer on the org. `by` is who pressed it (audited), or null for
 * the automatic check after an approval. Returns how many of Sidekick's permissions are approved.
 * @throws HttpError 400/503 when Microsoft isn't set up or the org isn't connected; 502 when Microsoft can't be reached
 */
export async function checkPermissions(orgId: string, by: Pick<User, "org_id" | "name"> | null): Promise<{ approved: number; total: number }> {
  const total = APP_PERMISSIONS.length;
  const tenant = await tenantOfOrg(orgId);
  if (!entraConfigured()) throw new HttpError(503, `Microsoft isn't set up on this ${BRAND.name} yet.`);
  if (!tenant) throw new HttpError(400, "Connect your organization to Microsoft first: the Org Owner does it on Settings → Microsoft sign-in.");
  return span("microsoft", "Check Microsoft permissions", async () => {
    const roles = await appTokenRoles(tenant);
    const ours = new Set(APP_PERMISSIONS.map((p) => p.id));
    const granted = roles.filter((r) => ours.has(r)).sort();
    await run("UPDATE orgs SET graph_roles = ?, graph_roles_at = ?, graph_roles_by = ? WHERE id = ?", JSON.stringify(granted), now(), by?.name ?? BRAND.name, orgId);
    spanAttrs({ approved: granted.length });
    if (by) await audit(by, `Checked ${BRAND.name}'s Microsoft permissions: ${granted.length} of ${total} approved`, "Policy change");
    return { approved: granted.length, total };
  }, { total });
}
