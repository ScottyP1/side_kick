"use client";

/**
 * Security & audit (/audit): the organization's audit log: sign-ins, access changes, uploads, deletions,
 * Teams links and every action Sidekick takes on its own. Admins only. "Where your data goes" is built from
 * /api/health, so it shows the setup actually running (database engine, search, AI answers, Teams).
 */

import { useEffect, useState } from "react";
import { api, fmtTime, Icon, useReportError } from "@/components/ui";
import { BRAND } from "@/lib/brand";

type Row = { id: number; actor: string; action: string; kind: string; created_at: string; workspace: string | null };

/** What /api/health reports (yes/no facts only). */
type Health = { database: { engine: string }; claude: boolean; search: string; teams: boolean };

/** The data path, step by step, for the setup that is running now. */
function flowFor(h: Health | null): [string, string][] {
  const search = !h ? "…" : h.search === "azure-hybrid" ? "Azure AI Search (keyword + meaning), filtered to your workspace" : h.search === "azure-keyword" ? "Azure AI Search (keyword), filtered to your workspace" : `Keyword search inside ${BRAND.name}'s own database`;
  return [
    ["Your browser", "Signed-in session, HTTPS in production"],
    [`${BRAND.name} server`, "Checks role and workspace on every request"],
    ["AI answers", !h ? "…" : h.claude ? "Working: the AI sees only the passages needed for one answer, and never trains on your data" : "Not set up yet"],
    ["Database", !h ? "…" : h.database.engine === "postgres" ? "PostgreSQL" : `SQLite on the machine running ${BRAND.name}`],
    ["Search", search],
    ...(h?.teams ? [["Microsoft Teams", "Only chats and channels an admin linked to a workspace"] as [string, string]] : []),
  ];
}

export default function AuditPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [kind, setKind] = useState("All");
  const [health, setHealth] = useState<Health | null>(null);
  const reportError = useReportError();
  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch(reportError);
  }, [reportError]);
  useEffect(() => {
    api<{ rows: Row[] }>("/api/audit").then((r) => setRows(r.rows)).catch((e) => setErr(e.message));
  }, []);
  if (err) return <div className="callout bad">{err}</div>;
  const kinds = ["All", ...new Set((rows ?? []).map((r) => r.kind))];
  const shown = (rows ?? []).filter((r) => kind === "All" || r.kind === kind);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Security & audit</div>
          <h1>Every action, recorded</h1>
          <p>Sign-ins, access changes, uploads, deletions and every action {BRAND.name} takes.</p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><h2>Where your data goes</h2></div>
        <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="flow">
            {flowFor(health).map(([a, b], i) => (
              <div key={a} style={{ display: "contents" }}>
                {i > 0 && <span className="flow-arrow" aria-hidden="true">→</span>}
                <div className="flow-step"><b>{a}</b><span className="muted">{b}</span></div>
              </div>
            ))}
          </div>
          <div className="grid g3" style={{ gap: 10 }}>
            {[
              ["Workspace walls", "Search and answers only use the workspace you're in; people only see workspaces they belong to"],
              ["Guest-safe answers", "With client guests present, documents tagged Internal are excluded"],
              ["Passwords hashed", "scrypt with a unique salt; sessions are random tokens, stored hashed"],
            ].map(([t, d]) => (
              <div key={t} className="row" style={{ alignItems: "flex-start", border: 0, padding: "4px 0" }}>
                <span style={{ color: "var(--good)" }}><Icon n="lock" /></span>
                <div className="grow"><b>{t}</b><div className="muted" style={{ fontSize: 12.5 }}>{d}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h">
          <div className="seg">{kinds.map((k) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k}</button>)}</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What happened</th><th>Workspace</th><th>Type</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className="ts" style={{ whiteSpace: "nowrap" }}>{fmtTime(r.created_at)}</td>
                  <td>{r.actor === BRAND.name ? <b style={{ color: "var(--accent)" }}>{BRAND.name}</b> : r.actor}</td>
                  <td>{r.action}</td>
                  <td className="muted">{r.workspace ?? "—"}</td>
                  <td><span className="tag">{r.kind}</span></td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={5} className="muted">Nothing recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
