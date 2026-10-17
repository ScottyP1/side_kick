"use client";

/**
 * Users & access (/users): add people, choose their role and which workspaces they can see, or remove them.
 * Admins only. New people get a temporary password they must change at first sign-in.
 */

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtDate, Icon, Modal, Pill, useToast } from "@/components/ui";

type P = { id: string; name: string; email: string; role: string; last_active: string | null; must_change_password: number; microsoft: number; workspaces: string[] };
const ROLES = ["Org Admin", "Billing Admin", "Member", "Viewer"];
const ROLE_HELP: [string, string][] = [
  ["Org Owner", "Everything, including deleting the organization"],
  ["Org Admin", "People, workspaces, usage and audit log, across all workspaces"],
  ["Billing Admin", "Usage and billing only"],
  ["Member", "Their workspaces: upload documents, import meetings, ask, manage action items"],
  ["Viewer", "Their workspaces, read-only"],
];

export default function UsersPage() {
  const { me } = useApp();
  const toast = useToast();
  const [people, setPeople] = useState<P[] | null>(null);
  const [err, setErr] = useState("");
  const [invite, setInvite] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "Member", workspaces: [] as string[] });
  const [formErr, setFormErr] = useState("");
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const [editWs, setEditWs] = useState<P | null>(null);

  const load = useCallback(() => api<{ users: P[] }>("/api/users").then((r) => setPeople(r.users)).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const wsName = (id: string) => me.workspaces.find((w) => w.id === id)?.name ?? "Workspace";

  const add = async () => {
    setFormErr("");
    try {
      const r = await api<{ tempPassword: string }>("/api/users", { method: "POST", json: form });
      setInvite(false);
      setTemp({ email: form.email, password: r.tempPassword });
      setForm({ name: "", email: "", role: "Member", workspaces: [] });
      load();
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : "Couldn't add this person.");
    }
  };
  const patch = async (p: P, body: object, msg: string) => {
    try {
      await api(`/api/users/${p.id}`, { method: "PATCH", json: body });
      toast(msg);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.");
    }
  };
  const remove = async (p: P) => {
    try {
      await api(`/api/users/${p.id}`, { method: "DELETE" });
      toast(`${p.name} was removed`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't remove.");
    }
  };

  if (err) return <div className="callout bad">{err}</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Users & access</div>
          <h1>{people ? `${people.length} ${people.length === 1 ? "person" : "people"}` : "People"}</h1>
          <p>Add teammates and choose which workspaces they can see. In step 2, people sign in with their Microsoft account and roles can come from Entra ID groups.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setInvite(true)}><Icon n="plus" />Add person</button>
        </div>
      </div>
      {temp && (
        <div className="callout info">
          <Icon n="lock" />
          <div style={{ flex: 1 }}>
            <b>{temp.email}</b> can sign in with this temporary password. It&apos;s shown only once, and they&apos;ll be asked to change it:
            <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code className="mono" style={{ background: "var(--surface)", padding: "4px 8px", borderRadius: 6, userSelect: "all" }}>{temp.password}</code>
              <button className="btn small" onClick={() => navigator.clipboard.writeText(temp.password).then(() => toast("Copied"), () => toast("Select the password and copy it"))}>Copy</button>
              <button className="btn small ghost" onClick={() => setTemp(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Person</th><th>Role</th><th>Workspaces</th><th>Last active</th><th /></tr>
            </thead>
            <tbody>
              {people?.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <span className="avatar">{p.name.split(" ").map((x) => x[0]).join("").slice(0, 2)}</span>
                      <div style={{ minWidth: 0 }}>
                        <b>{p.name}</b> {p.microsoft ? <Pill kind="good">Microsoft</Pill> : p.must_change_password ? <Pill kind="info">Temporary password</Pill> : null}
                        <div className="muted" style={{ fontSize: 12.5 }}>{p.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {p.role === "Org Owner" ? <b>Org Owner</b> : (
                      <select className="input" style={{ width: "auto", padding: "4px 8px" }} value={p.role} aria-label={`Role for ${p.name}`} onChange={(e) => patch(p, { role: e.target.value }, `${p.name} is now ${e.target.value}`)}>
                        {ROLES.map((r) => <option key={r}>{r}</option>)}
                      </select>
                    )}
                  </td>
                  <td>
                    {["Org Owner", "Org Admin"].includes(p.role) ? <span className="muted">All workspaces</span> : (
                      <div className="chips">
                        {p.workspaces.map((w) => <span key={w} className="tag">{wsName(w)}</span>)}
                        <button className="btn small ghost" onClick={() => setEditWs(p)}>Edit</button>
                      </div>
                    )}
                  </td>
                  <td className="muted">{fmtDate(p.last_active)}</td>
                  <td className="r">{p.role !== "Org Owner" && p.id !== me.user.id && <button className="btn small ghost" onClick={() => remove(p)}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><h2>What each role can do</h2></div>
        <div className="table-wrap">
          <table>
            <tbody>
              {ROLE_HELP.map(([r, d]) => <tr key={r}><td style={{ width: 160 }}><b>{r}</b></td><td>{d}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
      {invite && (
        <Modal title="Add a person" onClose={() => setInvite(false)} footer={<><button className="btn" onClick={() => setInvite(false)}>Cancel</button><button className="btn primary" onClick={add} disabled={!form.name.trim() || !form.email.trim()}>Add person</button></>}>
          <div className="field"><label htmlFor="pname">Name</label><input id="pname" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="pemail">Work email</label><input id="pemail" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="field"><label htmlFor="prole">Role</label><select id="prole" className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></div>
          {!["Org Admin"].includes(form.role) && (
            <div className="field">
              <label>Workspaces</label>
              {me.workspaces.map((w) => (
                <label key={w.id} style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
                  <input type="checkbox" checked={form.workspaces.includes(w.id)} onChange={(e) => setForm({ ...form, workspaces: e.target.checked ? [...form.workspaces, w.id] : form.workspaces.filter((x) => x !== w.id) })} />
                  {w.name}
                </label>
              ))}
            </div>
          )}
          {formErr && <p className="err">{formErr}</p>}
        </Modal>
      )}
      {editWs && (
        <WsEditor person={editWs} workspaces={me.workspaces} onClose={() => setEditWs(null)} onSave={(ids) => { patch(editWs, { workspaces: ids }, `Updated ${editWs.name}'s workspaces`); setEditWs(null); }} />
      )}
    </>
  );
}

function WsEditor({ person, workspaces, onClose, onSave }: { person: P; workspaces: { id: string; name: string }[]; onClose: () => void; onSave: (ids: string[]) => void }) {
  const [sel, setSel] = useState(person.workspaces);
  return (
    <Modal title={`${person.name}'s workspaces`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave(sel)}>Save</button></>}>
      {workspaces.map((w) => (
        <label key={w.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={sel.includes(w.id)} onChange={(e) => setSel(e.target.checked ? [...sel, w.id] : sel.filter((x) => x !== w.id))} />
          {w.name}
        </label>
      ))}
    </Modal>
  );
}
