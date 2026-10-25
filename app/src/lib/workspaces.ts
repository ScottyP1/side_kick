/**
 * @file Workspace housekeeping: unique names, renaming and deleting a workspace with everything in it.
 *
 * Concepts
 * - **One workspace per client engagement**, walled off from the others. Names are unique within an
 *   organization, ignoring upper/lower case, so people never have to guess which "Contoso" they're in.
 * - **Deleting a workspace** removes everything scoped to it, on both database engines: documents and
 *   their search passages (local index and Azure AI Search), meetings with their notes and action items,
 *   questions, the knowledge map and gap states, its guardrail switches and custom rules (with history),
 *   saved Teams chat messages, chat settings, reminders, Ask/Teams conversations (follow-ups), 👍/👎 feedback on its
 *   answers, and its members list. The org's firm library is not touched. Linked Teams chats are
 *   unlinked (Sidekick stops answering there). Kept on purpose: the audit log, AI usage and cost records,
 *   activity traces and guardrail counts, which hold no document text and are needed for billing and audit.
 *
 * Callers: /api/workspaces (create) and /api/workspaces/[id] (rename, delete). They check the role (Org
 * Owner/Admin) and the workspace wall, and write the audit log.
 */
import "server-only";
import { HttpError } from "./auth";
import { all, get, run, tx } from "./db";
import { removeWorkspaceIndex } from "./search";

/** Longest workspace name and engagement code, in characters. */
export const MAX_NAME = 120;
export const MAX_CODE = 40;
/** Longest client name (the company a group works for), in characters. */
export const MAX_CLIENT = 120;

/**
 * Throws 409 when another workspace in the org already has this name (case-insensitive).
 * @param exceptId the workspace being renamed, which may keep its own name
 */
export async function assertUniqueName(orgId: string, name: string, exceptId: string | null = null) {
  const clash = await get<{ id: string }>(
    "SELECT id FROM workspaces WHERE org_id = ? AND LOWER(name) = LOWER(?) AND id != ?",
    orgId, name, exceptId ?? "",
  );
  if (clash) throw new HttpError(409, `There's already a workspace called “${name}”. Pick a different name.`);
}

/** How much a workspace holds, for the delete confirmation ("12 documents, 4 meetings…"). Scoped to the org. */
export async function workspaceContents(orgId: string, workspaceId: string) {
  const n = async (table: string) =>
    Number((await get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ? AND org_id = ?`, workspaceId, orgId))?.n ?? 0);
  return {
    documents: await n("documents"),
    meetings: await n("meetings"),
    actionItems: await n("action_items"),
    questions: await n("questions"),
    chats: await n("teams_conversations"),
  };
}

/**
 * Deletes a workspace and everything scoped to it (see the file comment for what is kept). The caller has
 * checked the role and that the workspace belongs to `orgId`. Search passages are removed from Azure first
 * (outside the transaction, since Azure can't roll back); then every table is cleared in one transaction.
 * @returns the linked Teams conversations that were unlinked, for the audit log
 */
export async function deleteWorkspace(orgId: string, workspaceId: string): Promise<{ unlinked: number }> {
  await removeWorkspaceIndex(orgId, workspaceId);
  return tx(async () => {
    const ws = [workspaceId, orgId];
    const linked = await all<{ id: string }>("SELECT id FROM teams_conversations WHERE workspace_id = ? AND org_id = ?", ...ws);
    await run("UPDATE teams_conversations SET org_id = NULL, workspace_id = NULL, linked_by = NULL, linked_at = NULL WHERE workspace_id = ? AND org_id = ?", ...ws);
    await run("DELETE FROM guard_rule_versions WHERE org_id = ? AND rule_id IN (SELECT id FROM guard_custom_rules WHERE workspace_id = ? AND org_id = ?)", orgId, ...ws);
    // Ask and Teams conversations in this group (follow-ups), with their turns.
    await run("DELETE FROM conversation_turns WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id = ? AND org_id = ?)", ...ws);
    for (const table of [
      "guard_custom_rules", "guard_workspace_rules", "chat_messages", "teams_chat_settings", "notes_chats", "reminder_runs",
      "action_items", "items", "meetings", "documents", "questions", "passages", "answer_feedback", "conversations",
      // The group's connections to outside tools (lib/connectors.ts) with their links and imported items; other groups keep theirs.
      "connector_items", "connector_links", "connectors", "connector_states", "connector_requests",
      "findings", "watch_checks", "connector_health", "teams_post_failures", "jobs",
      // A firm document limited to chosen groups (lib/upload-guard.ts) stops applying to this one.
      "firm_doc_groups",
      // Calls seen in its chats for the transcription reminder (lib/call-nudge.ts).
      "call_nudges", "call_watch",
    ]) {
      await run(`DELETE FROM ${table} WHERE workspace_id = ? AND org_id = ?`, ...ws);
    }
    // Teams meetings captured for this group: forget the title and the link, keep the transcript id so a late or
    // repeated notification can't capture it again into another group.
    await run("UPDATE graph_meetings SET workspace_id = NULL, meeting_id = NULL, title = NULL, candidates = NULL, status = 'skipped', reason = 'The group was deleted.' WHERE workspace_id = ? AND org_id = ?", ...ws);
    // Meetings Sidekick set to record for this group (lib/auto-record.ts): forget the title and the group, keep the
    // row so the meeting isn't set again for another group.
    await run("UPDATE meeting_autorecord SET workspace_id = NULL, title = NULL, reason = 'The group was deleted.' WHERE workspace_id = ? AND org_id = ?", ...ws);
    // These tables have no org_id; the workspace id was checked against the org above.
    for (const table of ["insights", "gap_status", "reminder_state", "workspace_members"]) {
      await run(`DELETE FROM ${table} WHERE workspace_id = ?`, workspaceId);
    }
    await run("DELETE FROM workspaces WHERE id = ? AND org_id = ?", ...ws);
    return { unlinked: linked.length };
  });
}
