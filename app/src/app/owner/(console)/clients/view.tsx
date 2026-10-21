"use client";

/**
 * Clients (/owner/clients): every client organization with its plan, users, usage and errors; add a client or pause one.
 * "Managed" in the Plan column means no self-service subscription (added here or by first-run Setup).
 * Click a client's name to see its people and workspaces and set restrictions for it (clients/[id]).
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, fmtTime, Icon, Modal, Pill, usd, useReportError, useToast } from "@/components/ui";
import { planById, STATUS_LABEL, type SubStatus } from "@/lib/plans";
import { BRAND } from "@/lib/brand";

type T = {
  id: string; name: string; status: string; created_at: string; users: number; active_users: number; workspaces: number; documents: number; meetings: number;
  month_cost: number; month_calls: number; month_errors: number; last_activity: string | null; owner_email: string | null;
  plan: string | null; sub_status: SubStatus | null;
};

export default function ClientsPage() {
  const toast = useToast();
  const [list, setList] = useState<T[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ org: "", name: "", email: "" });
  const [formErr, setFormErr] = useState("");
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [confirm, setConfirm] = useState<T | null>(null);

  const load = useCallback(() => api<{ tenants: T[] }>("/api/owner/tenants").then((r) => setList(r.tenants)), []);
  const reportError = useReportError();
  useEffect(() => {
    load().catch(reportError);
  }, [load, reportError]);

  const add = async () => {
    setFormErr("");
    try {
      const r = await api<{ tempPassword: string }>("/api/owner/tenants", { method: "POST", json: form });
      setCreated({ email: form.email, password: r.tempPassword });
      setAdding(false);
      setForm({ org: "", name: "", email: "" });
      load();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : "Couldn't add the client.");
    }
  };
  const setStatus = async (t: T, status: "Active" | "Suspended") => {
    try {
      await api(`/api/owner/tenants/${t.id}`, { method: "PATCH", json: { status } });
      toast(status === "Suspended" ? `${t.name} is paused. Their users can't sign in.` : `${t.name} is active again`);
      setConfirm(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.");
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Clients</div>
          <h1>{list ? `${list.length} client organization${list.length === 1 ? "" : "s"}` : "Clients"}</h1>
          <p>Each client has its own users, workspaces, documents and memory. Nothing is shared between clients.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setAdding(true)}><Icon n="plus" />Add client</button>
        </div>
      </div>
      {created && (
        <div className="callout info">
          <Icon n="lock" />
          <div style={{ flex: 1 }}>
            Client created. Send <b>{created.email}</b> the portal address and this temporary password. It&apos;s shown only once, and they&apos;ll change it at first sign-in:
            <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code className="mono" style={{ background: "var(--surface)", padding: "4px 8px", borderRadius: 6, userSelect: "all" }}>{created.password}</code>
              <button className="btn small" onClick={() => navigator.clipboard.writeText(created.password).then(() => toast("Copied"), () => toast("Select the password and copy it"))}>Copy</button>
              <button className="btn small ghost" onClick={() => setCreated(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
      <div className="panel">
        {list && !list.length ? (
          <div className="empty"><h2>No clients yet</h2><span>Add your first client organization to give them a portal.</span></div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Status</th>
                  <th>Plan</th>
                  <th className="r">Users</th>
                  <th className="r">Workspaces</th>
                  <th className="r">Meetings</th>
                  <th className="r">Docs</th>
                  <th className="r">Spend (month)</th>
                  <th className="r">Errors</th>
                  <th>Last activity</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list?.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/owner/clients/${t.id}`}><b>{t.name}</b></Link>
                      <div className="muted" style={{ fontSize: 12.5 }}>{t.owner_email ?? "—"} · since {fmtDate(t.created_at)}</div>
                    </td>
                    <td><Pill kind={t.status === "Active" ? "good" : "bad"}>{t.status === "Active" ? "Active" : "Paused"}</Pill></td>
                    <td>{t.plan ? <>{planById(t.plan)?.name ?? t.plan}<div className="muted" style={{ fontSize: 12.5 }}>{t.sub_status ? STATUS_LABEL[t.sub_status] : ""}</div></> : <span className="muted">Managed</span>}</td>
                    <td className="r num">{t.users}<span className="faint"> ({t.active_users} active)</span></td>
                    <td className="r num">{t.workspaces}</td>
                    <td className="r num">{t.meetings}</td>
                    <td className="r num">{t.documents}</td>
                    <td className="r num">{usd(t.month_cost)}<div className="faint" style={{ fontSize: 12 }}>{t.month_calls} requests</div></td>
                    <td className="r num" style={{ color: t.month_errors ? "var(--bad)" : undefined }}>{t.month_errors}</td>
                    <td className="muted">{fmtTime(t.last_activity)}</td>
                    <td className="r">
                      {t.status === "Active" ? (
                        <button className="btn small danger" onClick={() => setConfirm(t)}>Pause</button>
                      ) : (
                        <button className="btn small" onClick={() => setStatus(t, "Active")}>Resume</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {adding && (
        <Modal title="Add a client" onClose={() => setAdding(false)} footer={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" disabled={!form.org.trim() || !form.name.trim() || !form.email.trim()} onClick={add}>Create client</button></>}>
          <div className="field"><label htmlFor="corg">Organization name</label><input id="corg" className="input" value={form.org} onChange={(e) => setForm({ ...form, org: e.target.value })} placeholder="e.g. Northwind Consulting" /></div>
          <div className="field"><label htmlFor="cname">Their admin&apos;s name</label><input id="cname" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="cemail">Their admin&apos;s work email</label><input id="cemail" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /><span className="hint">They become the client&apos;s Org Owner and can add their own team.</span></div>
          {formErr && <p className="err">{formErr}</p>}
        </Modal>
      )}
      {confirm && (
        <Modal title={`Pause ${confirm.name}?`} onClose={() => setConfirm(null)} footer={<><button className="btn" onClick={() => setConfirm(null)}>Cancel</button><button className="btn danger solid" onClick={() => setStatus(confirm, "Suspended")}>Pause access</button></>}>
          <p style={{ margin: 0 }}>Their {confirm.users} user{confirm.users === 1 ? "" : "s"} won&apos;t be able to use {BRAND.name} until you resume. Their data stays as it is.</p>
        </Modal>
      )}
    </>
  );
}
