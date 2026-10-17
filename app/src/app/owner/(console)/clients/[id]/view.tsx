"use client";

/**
 * One client (/owner/clients/:id): who is in this organization (role, workspaces, Microsoft sign-in, last
 * active), its workspaces, and its restrictions: feature switches that apply to this client only.
 * Operators only; opening the page is recorded in the operator log. Shows no document or meeting content.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { api, fmtDate, fmtTime, Icon, Modal, Pill, Switch, useReportError, useToast } from "@/components/ui";

type Person = { id: string; name: string; email: string; role: string; microsoft: boolean; last_active: string | null; created_at: string; workspaces: string[] };
type Workspace = { id: string; name: string; code: string | null; documents: number; meetings: number; members: number };
type Flag = { key: string; label: string; help: string; enabled: boolean; platformEnabled: boolean };
type Detail = {
  org: { id: string; name: string; status: string; created_at: string; microsoft_connected: boolean; microsoft_required: boolean };
  people: Person[];
  workspaces: Workspace[];
  flags: Flag[];
};

export default function ClientPage() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}

function Client() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const reportError = useReportError();
  const [d, setD] = useState<Detail | null>(null);
  const [pending, setPending] = useState<Flag | null>(null);

  const load = useCallback(() => api<Detail>(`/api/owner/tenants/${id}`).then(setD), [id]);
  useEffect(() => {
    load().catch(reportError);
  }, [load, reportError]);

  const flip = async (f: Flag, enabled: boolean) => {
    try {
      await api(`/api/owner/tenants/${id}/flags`, { method: "POST", json: { key: f.key, enabled } });
      toast(`${f.label} is ${enabled ? "on" : "off"} for ${d?.org.name}`);
      setPending(null);
      load().catch(reportError);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.");
    }
  };

  if (!d) return <div className="panel"><div className="panel-b muted">Loading…</div></div>;
  const admins = d.people.filter((p) => p.role === "Org Owner" || p.role === "Org Admin").length;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow"><Link href="/owner/clients">Clients</Link></div>
          <h1>{d.org.name}</h1>
          <p>
            <Pill kind={d.org.status === "Active" ? "good" : "bad"}>{d.org.status === "Active" ? "Active" : "Paused"}</Pill>{" "}
            {d.people.length} {d.people.length === 1 ? "person" : "people"} ({admins} admin{admins === 1 ? "" : "s"}) · {d.workspaces.length} workspace{d.workspaces.length === 1 ? "" : "s"} · since {fmtDate(d.org.created_at)} ·{" "}
            Microsoft sign-in {d.org.microsoft_connected ? (d.org.microsoft_required ? "connected and required" : "connected") : "not connected"}
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><h2>People</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>Workspaces</th><th>Sign-in</th><th>Last active</th></tr></thead>
            <tbody>
              {d.people.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.name}</b><div className="muted" style={{ fontSize: 12.5 }}>{p.email} · added {fmtDate(p.created_at)}</div></td>
                  <td>{p.role}</td>
                  <td className="muted">{p.workspaces.join(", ") || "None yet"}</td>
                  <td>{p.microsoft ? <Pill kind="good">Microsoft</Pill> : <span className="muted">Password</span>}</td>
                  <td className="muted">{fmtTime(p.last_active)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid g2">
        <div className="panel">
          <div className="panel-h"><h2>Workspaces</h2></div>
          <div className="list">
            {!d.workspaces.length && <div className="li muted">No workspaces yet.</div>}
            {d.workspaces.map((w) => (
              <div key={w.id} className="li">
                <span><b>{w.name}</b>{w.code && <span className="muted"> · {w.code}</span>}</span>
                <span className="muted num">{w.members} member{w.members === 1 ? "" : "s"} · {w.documents} docs · {w.meetings} meetings</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>Restrictions for this client</h2></div>
          <div className="panel-b">
            <p className="muted" style={{ marginTop: 0 }}>Turn a feature off for {d.org.name} only. A feature paused for everyone on Releases &amp; switches stays off here too.</p>
            {d.flags.map((f) => (
              <div key={f.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "8px 0" }}>
                <div>
                  <b>{f.label}</b>
                  <div className="muted" style={{ fontSize: 12.5 }}>{f.help}{!f.platformEnabled && <> · <Icon n="lock" /> paused for everyone</>}</div>
                </div>
                <Switch on={f.enabled} label={`${f.label} for ${d.org.name}`} onChange={(v) => (v ? flip(f, true) : setPending(f))} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {pending && (
        <Modal title={`Turn off ${pending.label} for ${d.org.name}?`} onClose={() => setPending(null)} footer={<><button className="btn" onClick={() => setPending(null)}>Cancel</button><button className="btn danger solid" onClick={() => flip(pending, false)}>Turn off</button></>}>
          <p style={{ margin: 0 }}>Their people will see a message that it&apos;s turned off for their organization. Nothing else changes, and you can turn it back on any time.</p>
        </Modal>
      )}
    </>
  );
}
