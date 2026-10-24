/**
 * @file "Save to knowledge": keeping a decision, requirement, risk or fact from a meeting as lasting group
 * knowledge, from the notes card in Teams or the Knowledge page in the portal.
 *
 * Concepts
 * - **Meeting items** (`items`): what the notes extraction found in a meeting (decisions, open questions,
 *   requirements, facts, risks, terms). They live with their meeting.
 * - **Saved to knowledge** (`items.pinned = 1`, with `saved_by` / `saved_at`): someone said "this one matters".
 *   A saved item is indexed as its own search source (`saved:<item id>`, type "notes", so it ranks with the
 *   meeting notes, above raw transcripts) and listed under Saved on the Knowledge page, so answers keep finding it
 *   long after the meeting. Unsaving removes that source again. Deleting or re-processing the meeting removes it.
 * - **Walls**: an item is only found inside its own organization and group; the audience follows its meeting
 *   (internal, or shareable when client guests attended). In a Teams chat with client guests, only items from
 *   meetings that had guests can be saved there (the only ones whose notes are posted there).
 */
import "server-only";
import { get, all, now, run } from "./db";
import { audit, canEdit, HttpError, type User } from "./auth";
import { indexText, removeIndexed } from "./search";
import { span } from "./trace";
import { BRAND } from "./brand";

/** Item kinds that can be saved to knowledge (open questions and pending decisions are temporary, so they can't). */
export const SAVABLE_KINDS = ["decision", "requirement", "fact", "risk", "glossary"] as const;
/** How each kind reads in titles and on cards. */
export const KIND_LABEL: Record<string, string> = { decision: "Decision", requirement: "Requirement", fact: "Fact", risk: "Risk", glossary: "Term" };

/** The search source id of a saved item. */
export const savedSourceId = (itemId: string) => `saved:${itemId}`;

/** A meeting item with what's needed to save it. */
type ItemRow = { id: string; org_id: string; workspace_id: string; kind: string; text: string; who: string | null; pinned: number; meeting_id: string | null; title: string | null; held_at: string | null; external_guests: number | null };

/**
 * Saves (or unsaves) one meeting item to the group's knowledge. `actor` is who clicked (a portal user or a Teams
 * person acting in the chat's group); the caller has already checked they may use `workspaceId`
 * (`requireWorkspace`, or the chat's own link). Viewers and Billing Admins can't (403). With `guestsOnly` (a Teams
 * chat with client guests) only items from meetings that had guests are found. Idempotent; audited when it
 * changes. Returns the item's new state.
 */
export async function setItemSaved(actor: User, workspaceId: string, itemId: unknown, saved: boolean, opts: { guestsOnly?: boolean; where?: "Teams" | "the portal" } = {}) {
  if (!canEdit(actor)) throw new HttpError(403, `Your ${BRAND.name} role (${actor.role}) can't save things to knowledge. Ask a Member, the Team Lead or an Org Admin.`);
  const item = typeof itemId === "string" && itemId
    ? await get<ItemRow>(
        `SELECT i.id, i.org_id, i.workspace_id, i.kind, i.text, i.who, i.pinned, i.meeting_id, m.title, m.held_at, m.external_guests
           FROM items i LEFT JOIN meetings m ON m.id = i.meeting_id AND m.org_id = i.org_id
          WHERE i.id = ? AND i.org_id = ? AND i.workspace_id = ?`,
        itemId, actor.org_id, workspaceId,
      )
    : undefined;
  if (!item || (opts.guestsOnly && item.external_guests !== 1)) throw new HttpError(404, "I couldn't find that item in this group.");
  if (!(SAVABLE_KINDS as readonly string[]).includes(item.kind)) throw new HttpError(400, "Only decisions, requirements, facts, risks and terms can be saved to knowledge.");
  if (Boolean(item.pinned) === saved) return { saved, by: null as string | null };
  await span("index", saved ? "Save a meeting item to knowledge" : "Remove a meeting item from knowledge", async () => {
    if (saved) {
      await run("UPDATE items SET pinned = 1, saved_by = ?, saved_at = ? WHERE id = ? AND org_id = ?", actor.name, now(), item.id, actor.org_id);
      await removeIndexed(savedSourceId(item.id));
      await indexText({
        orgId: actor.org_id,
        workspaceId,
        sourceType: "notes",
        sourceId: savedSourceId(item.id),
        title: `Saved ${(KIND_LABEL[item.kind] ?? "item").toLowerCase()}${item.title ? `: ${item.title} (${item.held_at})` : ""}`,
        audience: item.external_guests ? "shareable" : "internal",
        text: `${KIND_LABEL[item.kind] ?? "Item"} saved to the group's knowledge by ${actor.name}: ${item.text}${item.who ? ` (${item.who})` : ""}`,
      });
    } else {
      await run("UPDATE items SET pinned = 0, saved_by = NULL, saved_at = NULL WHERE id = ? AND org_id = ?", item.id, actor.org_id);
      await removeIndexed(savedSourceId(item.id));
    }
  }, { kind: item.kind });
  await audit(actor, `${saved ? "Saved" : "Removed"} ${(KIND_LABEL[item.kind] ?? "item").toLowerCase()} “${item.text.slice(0, 60)}” ${saved ? "to" : "from"} knowledge${opts.where ? ` in ${opts.where}` : ""}`, "Data", workspaceId);
  return { saved, by: saved ? actor.name : null };
}

/**
 * Removes the search entries of a meeting's saved items (before the meeting is deleted or re-processed, which
 * deletes the items themselves). Scoped to the organization.
 */
export async function removeSavedForMeeting(orgId: string, meetingId: string) {
  const saved = await all<{ id: string }>("SELECT id FROM items WHERE meeting_id = ? AND org_id = ? AND pinned = 1", meetingId, orgId);
  for (const s of saved) await removeIndexed(savedSourceId(s.id));
}
