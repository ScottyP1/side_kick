"use client";

import { useEffect, useState } from "react";
import { api, fmtTime, Icon, Pill } from "@/components/ui";

type Row = { id: number; actor: string; action: string; kind: string; created_at: string; workspace: string | null };

const FLOW: [string, string][] = [
  ["Your browser", "Signed-in session, HTTPS in production"],
  ["Sidekick server", "Checks role and workspace on every request"],
  ["Claude API", "Anthropic · moves to Azure-hosted Claude in step 2"],
  ["Local database", "SQLite on this machine · Azure Postgres + AI Search in step 2"],
];

export default function AuditPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [kind, setKind] = useState("All");
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
          <p>Sign-ins, access changes, uploads, deletions and every action Sidekick takes.</p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><h2>Where your data goes (step 1)</h2><Pill kind="info">Local demo</Pill></div>
        <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="flow">
            {FLOW.map(([a, b], i) => (
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
                  <td>{r.actor === "Sidekick" ? <b style={{ color: "var(--accent)" }}>Sidekick</b> : r.actor}</td>
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
