"use client";

/**
 * What the watchers noticed (lib/watchers.ts), as a list of rows for Home ("Needs attention") and a group's
 * Overview tab. Each row: what's wrong (with a pill for the kind and the group on Home), the detail, the next step,
 * a button to the page that fixes it, and Snooze (7 days) for people who may act on it (admins, the group's Team
 * Lead). Loads GET /api/findings (with `ws` for one group); the server applies the workspace walls and roles.
 * A document that may be another client's (`misfiled_doc`, kept anyway) also gets **It belongs here**, which
 * confirms it (POST /api/docs/:id or /api/firm/:id `review`); "Move or keep" opens it on its page to move it.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, Pill, useReportError, useToast } from "@/components/ui";

/** One finding as GET /api/findings returns it. */
export type Finding = {
  id: string; kind: string; kindLabel: string; workspaceId: string | null; workspace: string | null; severity: "info" | "warn" | "bad"; status: string;
  title: string; detail: string | null; nextStep: string; actionHref: string | null; actionLabel: string | null;
  firstSeen: string; lastSeen: string; snoozedUntil: string | null; canAct: boolean;
  /** Upload guard findings: the document and where it lives. */
  guard?: { doc: string; scope: "document" | "firm"; held: boolean };
};

/** Loads the findings this person may see (one group's with `ws`) and reloads after a snooze. */
export function useFindings(ws?: string) {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const reportError = useReportError();
  const load = useCallback(
    () => api<{ findings: Finding[] }>(`/api/findings${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`).then((r) => setFindings(r.findings)).catch(reportError),
    [ws, reportError],
  );
  useEffect(() => {
    load();
  }, [load]);
  return { findings, reload: load };
}

/**
 * The rows, worst first. `showGroup` adds the group name (Home lists every group); `onOpen` runs before following a
 * link (Home switches the current group so the target page opens on it); `limit` shows that many with "Show all";
 * `here` is the current page's address (a button to it is left out).
 */
export function FindingRows({ findings, reload, showGroup, onOpen, limit, here }: { findings: Finding[]; reload: () => void; showGroup?: boolean; onOpen?: (f: Finding) => void; limit?: number; here?: string }) {
  const [all, setAll] = useState(false);
  const shown = limit && !all ? findings.slice(0, limit) : findings;
  const toast = useToast();
  const reportError = useReportError();
  const snooze = (f: Finding) =>
    api("/api/findings", { method: "POST", json: { id: f.id, action: "snooze" } })
      .then(() => {
        toast("Snoozed for a week. It comes back if it's still there.");
        reload();
      })
      .catch(reportError);
  const keep = (f: Finding) =>
    api(f.guard!.scope === "firm" ? `/api/firm/${f.guard!.doc}` : `/api/docs/${f.guard!.doc}`, { method: "POST", json: { action: "review" } })
      .then(() => {
        toast("Confirmed: it stays where it is.");
        reload();
      })
      .catch(reportError);
  return (
    <>
      {shown.map((f) => (
        <div key={f.id} className="li">
          <div className="grow">
            <div style={{ marginBottom: 4 }}><Pill kind={f.severity === "info" ? "info" : f.severity}>{f.kindLabel}</Pill></div>
            <b>{f.title}</b>
            {showGroup && f.workspace && <span className="muted"> · {f.workspace}</span>}
            {f.detail && <div className="muted">{f.detail}</div>}
            <div style={{ fontSize: 12.5, marginTop: 2 }}>Next step: {f.nextStep}</div>
            {((f.actionHref && f.actionHref !== here) || f.canAct) && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {f.actionHref && f.actionHref !== here && (
                  <Link className="btn small" href={f.actionHref} onClick={() => onOpen?.(f)}>
                    {f.actionLabel ?? "Open"}
                  </Link>
                )}
                {f.canAct && f.guard && !f.guard.held && (
                  <button className="btn small" onClick={() => keep(f)} title="Keep it where it is and clear this">It belongs here</button>
                )}
                {f.canAct && (
                  <button className="btn small ghost" onClick={() => snooze(f)} title="Hide it for a week">
                    Snooze
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      {shown.length < findings.length && (
        <div className="li">
          <button className="btn small" onClick={() => setAll(true)}>Show all {findings.length}</button>
        </div>
      )}
    </>
  );
}
