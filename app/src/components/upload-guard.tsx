"use client";

/**
 * The upload guard on the page (lib/upload-guard.ts is the server side): the pieces every upload surface uses so a
 * document lands where it should.
 * - `UploadTarget`: the coloured line above an upload ("Uploading to Contoso Retail – Cloud Migration (Contoso Retail)",
 *   or "Uploading to the firm library: every group can use it"), on Knowledge & docs, "Add a past or outside
 *   meeting" and the Firm library.
 * - `TargetConfirm`: people in two or more groups confirm the group for each upload (they can switch it there).
 * - `HeldActions`: the question and buttons for a held or flagged document ("This looks like it's about Litware –
 *   Data Platform. Keep it here, or move it?"): Keep here, Move to the suggested group (when the person may), Move to
 *   another of their groups, and for the firm library Limit to that group.
 * The server checks every action again (roles, groups); these only make the choice clear.
 */

import { useState } from "react";
import { api, Modal, Spinner, useToast } from "@/components/ui";
import type { Workspace } from "@/components/shell";

/** What the server says matched (lib/upload-guard.ts `GuardMatch`): the group it seems to be about. */
export type GuardMatch = { workspaceId: string; group: string; client: string | null; mentions: number; terms: string[] };
/** A group a document may be moved to. */
export type MoveTarget = { id: string; name: string; client?: string | null };

/** "Contoso Retail – Cloud Migration (Contoso Retail)": the group, with its client when it has one. */
export const groupLabel = (g: { name: string; client?: string | null }) => (g.client ? `${g.name} (${g.client})` : g.name);

/**
 * The coloured "Uploading to …" line. `group` = the target group (its colour marks the line); `firm` = the firm
 * library, with `limitedTo` naming chosen groups when it won't reach every group.
 */
export function UploadTarget({ group, firm, limitedTo }: { group?: Pick<Workspace, "name" | "color" | "client"> | null; firm?: boolean; limitedTo?: string[] }) {
  if (firm) {
    return (
      <div className="upload-target firm" role="status">
        <span className="dot" aria-hidden="true" />
        <span>
          {limitedTo?.length
            ? <>Uploading to the <b>firm library</b>, only for {limitedTo.join(", ")}</>
            : <>Uploading to the <b>firm library</b>: every group can use it</>}
        </span>
      </div>
    );
  }
  if (!group) return null;
  return (
    <div className="upload-target" role="status" style={{ ["--group" as string]: group.color }}>
      <span className="dot" aria-hidden="true" />
      <span>Uploading to <b>{group.name}</b>{group.client ? <> ({group.client})</> : null}</span>
    </div>
  );
}

/**
 * Asks someone in two or more groups which group this upload is for (default: the current one). `what` says what is
 * being uploaded ("2 files", "this meeting"). `onPick` gets the chosen group id.
 */
export function TargetConfirm({ groups, current, what, onPick, onCancel }: { groups: Workspace[]; current: string; what: string; onPick: (id: string) => void; onCancel: () => void }) {
  const [pick, setPick] = useState(current);
  const g = groups.find((x) => x.id === pick);
  return (
    <Modal
      title="Which group is this for?"
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={() => onPick(pick)}>Upload to {g?.name ?? "this group"}</button>
        </>
      }
    >
      <p style={{ margin: 0 }}>You&apos;re in {groups.length} groups. Only people in the group you pick can use {what}.</p>
      <div className="field">
        <label htmlFor="target-group">Group</label>
        <select id="target-group" className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
          {groups.map((x) => <option key={x.id} value={x.id}>{groupLabel(x)}</option>)}
        </select>
      </div>
      {g && <UploadTarget group={g} />}
    </Modal>
  );
}

/**
 * The decision for a held (or flagged and kept) document. `scope` "document" posts to /api/docs/:id, "firm" to
 * /api/firm/:id. `targets` are the groups this person may move it to; `onDone` reloads the list.
 */
export function HeldActions({ scope, id, match, question, held, targets, currentWs, canReview, onDone }: {
  scope: "document" | "firm"; id: string; match: GuardMatch; question: string | null; held: boolean; targets: MoveTarget[]; currentWs?: string;
  /** May confirm a kept one belongs here (the group's Team Lead, admins). */
  canReview: boolean;
  onDone: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [other, setOther] = useState("");
  const url = scope === "firm" ? `/api/firm/${id}` : `/api/docs/${id}`;
  const choices = targets.filter((t) => t.id !== currentWs);
  const suggested = choices.find((t) => t.id === match.workspaceId);
  const act = async (json: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await api(url, { method: "POST", json });
      toast(done);
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't do that.", "error");
    } finally {
      setBusy(false);
    }
  };
  const move = (to: string) => act({ action: "move", to }, `Moved to ${targets.find((t) => t.id === to)?.name ?? "the group"}. Only its people can use it now.`);
  return (
    <div className={`callout ${held ? "warn" : "bad"} held-actions`} role="group" aria-label="Where does this document belong?">
      <div className="grow">
        <b>{question ?? `This looks like it's about ${match.group}.`}</b>
        <div className="muted" style={{ fontSize: 12.5 }}>
          Mentions {match.terms.map((t) => `“${t}”`).join(", ")}{match.mentions > 1 ? ` (${match.mentions}×)` : ""}.{" "}
          {held ? "Held: not used in any answer until you decide." : "Kept here: the managers were asked to check it."}
        </div>
        <div className="actions" style={{ marginTop: 8, flexWrap: "wrap" }}>
          {busy && <Spinner />}
          {suggested && <button className="btn small primary" disabled={busy} onClick={() => move(suggested.id)}>Move to {suggested.name}</button>}
          {scope === "firm" && held && (
            <button className="btn small" disabled={busy} onClick={() => act({ action: "limit", groups: [match.workspaceId] }, `Kept in the firm library, only for ${match.group}.`)}>
              Only for {match.group}
            </button>
          )}
          {held ? (
            <button className="btn small" disabled={busy} onClick={() => act({ action: "keep" }, scope === "firm" ? "Kept for every group it applies to." : "Kept in this group.")}>
              {scope === "firm" ? "Keep for every group" : "Keep it here"}
            </button>
          ) : canReview ? (
            <button className="btn small" disabled={busy} onClick={() => act({ action: "review" }, "Confirmed: it belongs here.")}>It belongs here</button>
          ) : null}
          {choices.length > 0 && (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <select className="input" style={{ width: "auto", padding: "4px 8px" }} aria-label="Move to another group" value={other} onChange={(e) => setOther(e.target.value)}>
                <option value="">Move to…</option>
                {choices.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <button className="btn small ghost" disabled={busy || !other} onClick={() => move(other)}>Move</button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
