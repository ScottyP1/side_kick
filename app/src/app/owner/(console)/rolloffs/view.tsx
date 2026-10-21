"use client";

/**
 * Roll-offs (/owner/rolloffs): every client's pending and past roll-offs (lib/rolloff.ts) in one list:
 * groups that are ending, organizations in their grace period after canceling or being ended, and done
 * deletions with their certificate (download as PDF or text; an organization's is only here once it's
 * gone). Pending ones can be **extended** (a new date, 1 to 365 days from today), **deleted now** (on the
 * timer's next run, for a client who asks for prompt deletion) or **cancelled**. Errors
 * from the scheduled deletion show on the row (it's retried every 5 minutes). Operators only.
 * Data: GET /api/owner/rolloffs, PATCH /api/owner/rolloffs/:id, GET /api/owner/rolloffs/:id/certificate.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, fmtTime, Modal, Pill, useReportError, useToast } from "@/components/ui";

type Row = {
  id: string; orgId: string; org: string; scope: "group" | "org"; group: string | null; status: "scheduled" | "running" | "canceled" | "done";
  reason: string | null; readOnlyFrom: string | null; deleteOn: string; requestedBy: string; requestedAt: string; closedBy: string | null; closedAt: string | null;
  error: string | null; certificate: { id: string; counts: Record<string, number> } | null;
};
const KIND: Record<Row["status"], string> = { scheduled: "warn", running: "info", canceled: "", done: "good" };
const LABEL: Record<Row["status"], string> = { scheduled: "Scheduled", running: "Deleting", canceled: "Cancelled", done: "Deleted" };

export default function RolloffsPage() {
  const toast = useToast();
  const reportError = useReportError();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [extend, setExtend] = useState<Row | null>(null);
  const [days, setDays] = useState(30);
  const [cancel, setCancel] = useState<Row | null>(null);
  const [soon, setSoon] = useState<Row | null>(null);
  const load = useCallback(() => api<{ rolloffs: Row[] }>("/api/owner/rolloffs").then((r) => setRows(r.rolloffs)), []);
  useEffect(() => {
    load().catch(reportError);
  }, [load, reportError]);

  const patch = async (r: Row, json: Record<string, unknown>, done: string) => {
    try {
      await api(`/api/owner/rolloffs/${r.id}`, { method: "PATCH", json });
      toast(done);
      setExtend(null);
      setCancel(null);
      setSoon(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "That didn't work.");
    }
  };
  if (!rows) return <span className="muted">Loading…</span>;
  const what = (r: Row) => (r.scope === "group" ? `Group “${r.group}”` : "Whole organization");

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Roll-offs</div>
          <h1>Groups ending and clients leaving</h1>
          <p>Groups ending and clients leaving: read-only until the date, then deleted by the timer, with a deletion certificate (counts only, no content).</p>
        </div>
      </div>
      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Client</th><th>What</th><th>Status</th><th>Deleted on</th><th>Asked by</th><th></th></tr></thead>
            <tbody>
              {!rows.length && <tr><td colSpan={6} className="muted">No roll-offs yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.status === "done" && r.scope === "org" ? r.org : <Link href={`/owner/clients/${r.orgId}`}>{r.org}</Link>}</td>
                  <td>{what(r)}{r.reason && <div className="muted" style={{ fontSize: 12.5 }}>{r.reason}</div>}</td>
                  <td><Pill kind={KIND[r.status]}>{LABEL[r.status]}</Pill>{r.error && <div className="err" style={{ fontSize: 12.5 }}>Last try failed: {r.error}</div>}</td>
                  <td className="num">{r.status === "done" ? fmtTime(r.closedAt) : fmtDate(r.deleteOn)}{r.readOnlyFrom && r.scope === "org" && r.status === "scheduled" && <div className="muted" style={{ fontSize: 12.5 }}>read-only from {fmtDate(r.readOnlyFrom)}</div>}</td>
                  <td>{r.requestedBy}<div className="muted" style={{ fontSize: 12.5 }}>{fmtDate(r.requestedAt)}</div></td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {r.status === "scheduled" && <><button className="btn small" onClick={() => { setDays(30); setExtend(r); }}>Extend</button> <button className="btn small danger" onClick={() => setSoon(r)}>Delete now</button> <button className="btn small ghost" onClick={() => setCancel(r)}>Cancel</button></>}
                    {r.certificate && <><a className="btn small" href={`/api/owner/rolloffs/${r.id}/certificate?format=pdf`}>Certificate (PDF)</a> <a className="btn small ghost" href={`/api/owner/rolloffs/${r.id}/certificate`}>Text</a></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {extend && (
        <Modal title={`Move the deletion of ${extend.org}?`} onClose={() => setExtend(null)} footer={<><button className="btn" onClick={() => setExtend(null)}>Back</button><button className="btn primary" onClick={() => patch(extend, { action: "extend", days }, "Deletion date moved")}>Save date</button></>}>
          <div className="field">
            <label htmlFor="days">{what(extend)}: delete in how many days from today?</label>
            <input id="days" className="input num" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.max(1, Math.min(365, Math.floor(Number(e.target.value) || 1))))} />
          </div>
          <p className="muted" style={{ margin: 0 }}>Now set for {fmtDate(extend.deleteOn)}. Recorded in the client&apos;s audit log and the operator log.</p>
        </Modal>
      )}
      {soon && (
        <Modal title={`Delete ${soon.scope === "group" ? `“${soon.group}”` : `all of ${soon.org}`} now?`} onClose={() => setSoon(null)} footer={<><button className="btn" onClick={() => setSoon(null)}>Back</button><button className="btn danger solid" onClick={() => patch(soon, { action: "now" }, "Deletes on the timer's next run")}>Delete now</button></>}>
          <p style={{ margin: 0 }}>The timer deletes it within 5 minutes and writes the deletion certificate. This can&apos;t be undone.</p>
        </Modal>
      )}
      {cancel && (
        <Modal title={`Keep ${cancel.scope === "group" ? `“${cancel.group}”` : cancel.org}?`} onClose={() => setCancel(null)} footer={<><button className="btn" onClick={() => setCancel(null)}>Back</button><button className="btn primary" onClick={() => patch(cancel, { action: "cancel" }, "Roll-off cancelled")}>Cancel the deletion</button></>}>
          <p style={{ margin: 0 }}>{cancel.scope === "group" ? "The group becomes a normal group again (it counts toward the plan's groups) and its Teams chats are relinked where possible." : "Nothing is deleted. The organization goes back to what its plan allows (still read-only if its plan has lapsed)."}</p>
        </Modal>
      )}
    </>
  );
}
