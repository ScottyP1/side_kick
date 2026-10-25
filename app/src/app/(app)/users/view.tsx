"use client";

/**
 * Users & access (/users): add people, choose their role and which workspaces they can see, or remove them.
 * Org Owners and Org Admins manage everyone. A Team Lead sees only the people in the workspaces they lead
 * and can add people to those workspaces (as Member or Viewer) or take them off; roles and removing people
 * from the organization stay with admins. New people get a temporary password they must change at first sign-in.
 * Removing someone asks for confirmation first. Nobody can change their own role or remove themselves here.
 * After "Approve Sidekick for your organization" Microsoft comes back here with `?microsoft=approved`, or
 * `?error=1` with the reason in a one-time cookie (lib/flash.ts), shown as a note. Team Leads are a plan
 * feature (Team and up): on Starter "Team Lead" can't be picked for anyone new, and people who already are
 * Team Leads stay so.
 */

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtDate, Icon, Modal, Pill, useToast } from "@/components/ui";
import { takeFlash } from "@/lib/flash";
import { BRAND } from "@/lib/brand";
import { featureNote } from "@/lib/plans";

type P = { id: string; name: string; email: string; role: string; last_active: string | null; must_change_password: number; microsoft: number; signin_locked?: boolean; workspaces: string[] };
const ROLES = ["Org Admin", "Team Lead", "Member", "Viewer"];
/** Roles a Team Lead can give (same rule as the server: LEAD_ASSIGNABLE_ROLES in lib/auth.ts). */
const LEAD_ROLES = ["Member", "Viewer"];
const ROLE_HELP: [string, string][] = [
  ["Org Owner", "Everything, plus the organization-wide guardrail switches and Microsoft sign-in"],
  ["Org Admin", "People, groups, usage and billing (sees the plan; only the Org Owner pays or changes it) and audit log, across all groups"],
  ["Team Lead", "A Member who also adds people to the groups they lead (as Member or Viewer), takes them off again, and links Teams chats to those groups"],
  ["Member", "Their groups: upload documents, import meetings, ask, manage action items"],
  ["Viewer", "Their groups, read-only"],
];

export default function UsersPage() {
  const { me } = useApp();
  const toast = useToast();
  const lead = !me.user.admin && Boolean(me.user.lead);
  const roles = lead ? LEAD_ROLES : ROLES;
  // Team Lead isn't in every plan: offered (disabled) with a note, unless the person already is one.
  const leadNote = featureNote(me.plan, "teamLeads");
  const roleOption = (r: string, current?: string) => {
    const off = r === "Team Lead" && !!leadNote && current !== "Team Lead";
    return <option key={r} value={r} disabled={off}>{off ? "Team Lead (not in your plan)" : r}</option>;
  };
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
  // The result of the Microsoft admin-approval round trip (the reason never travels in the address).
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("microsoft") === "approved") toast(`${BRAND.name} is approved for your organization's Microsoft directory`);
    if (q.has("error")) toast(takeFlash(`Approving ${BRAND.name} in Microsoft didn't finish. Try again.`), "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const wsName = (id: string) => me.workspaces.find((w) => w.id === id)?.name ?? "Group";

  const add = async () => {
    setFormErr("");
    try {
      const r = await api<{ tempPassword?: string; existing?: boolean }>("/api/users", { method: "POST", json: form });
      setInvite(false);
      if (r.tempPassword) setTemp({ email: form.email, password: r.tempPassword });
      else toast(`${form.email} already had an account: added them to your groups`);
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
  // Clears a lock left by too many wrong passwords (anyone can cause one by guessing), so they can sign in now.
  const unlock = async (p: P) => {
    try {
      await api(`/api/users/${p.id}`, { method: "POST", json: { action: "unlock" } });
      toast(`${p.name} can sign in again`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't unlock.");
    }
  };
  const remove = async (p: P) => {
    // Same confirm-first pattern as removing a guardrail rule.
    if (!window.confirm(`Remove ${p.name} (${p.email}) from the organization? They're signed out and lose access to every group. This can't be undone.`)) return;
    try {
      await api(`/api/users/${p.id}`, { method: "DELETE" });
      // Drop the row now, so it doesn't linger while the list reloads.
      setPeople((ps) => ps?.filter((x) => x.id !== p.id) ?? ps);
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
          <p>{lead ? "The people in the groups you lead. Add teammates to your groups, or take them off; an Org Admin changes roles." : "Add teammates and choose which groups they can see. People can sign in with their Microsoft work account once Microsoft sign-in is connected on Settings."}</p>
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
              <tr><th>Person</th><th>Role</th><th>Groups</th><th>Last active</th><th /></tr>
            </thead>
            <tbody>
              {people?.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <span className="avatar">{p.name.split(" ").map((x) => x[0]).join("").slice(0, 2)}</span>
                      <div style={{ minWidth: 0 }}>
                        <b>{p.name}</b> {p.microsoft ? <Pill kind="good">Microsoft</Pill> : p.must_change_password ? <Pill kind="info">Temporary password</Pill> : null}
                        {p.signin_locked && (
                          <>
                            {" "}<Pill kind="warn">Sign-in locked</Pill>
                            {!lead && <button className="btn small ghost" onClick={() => unlock(p)} title="Too many wrong passwords in the last 15 minutes. Unlock lets them sign in now.">Unlock</button>}
                          </>
                        )}
                        <div className="muted" style={{ fontSize: 12.5 }}>{p.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {/* Nobody changes their own role here (the server refuses it too), so an admin can't lock themselves out. */}
                    {p.role === "Org Owner" || lead || p.id === me.user.id ? <b title={p.id === me.user.id ? "Ask the Org Owner or another Org Admin to change your role" : undefined}>{p.role}</b> : (
                      <select className="input" style={{ width: "auto", padding: "4px 8px" }} value={p.role} aria-label={`Role for ${p.name}`} onChange={(e) => patch(p, { role: e.target.value }, `${p.name} is now ${e.target.value}`)}>
                        {ROLES.map((r) => roleOption(r, p.role))}
                      </select>
                    )}
                  </td>
                  <td>
                    {["Org Owner", "Org Admin"].includes(p.role) ? <span className="muted">All groups</span> : (
                      <div className="chips">
                        {p.workspaces.map((w) => <span key={w} className="tag">{wsName(w)}</span>)}
                        {(!lead || LEAD_ROLES.includes(p.role)) && <button className="btn small ghost" onClick={() => setEditWs(p)}>Edit</button>}
                      </div>
                    )}
                  </td>
                  <td className="muted">{fmtDate(p.last_active)}</td>
                  <td className="r">{!lead && p.role !== "Org Owner" && p.id !== me.user.id && <button className="btn small ghost" onClick={() => remove(p)}>Remove</button>}</td>
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
        <Modal title="Add a person" onClose={() => setInvite(false)} footer={<><button className="btn" onClick={() => setInvite(false)}>Cancel</button><button className="btn primary" onClick={add} disabled={!form.name.trim() || !form.email.trim() || (lead && !form.workspaces.length)}>Add person</button></>}>
          <div className="field"><label htmlFor="pname">Name</label><input id="pname" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="pemail">Work email</label><input id="pemail" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="field"><label htmlFor="prole">Role</label><select id="prole" className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{roles.map((r) => roleOption(r))}</select>{leadNote && !lead && <span className="hint">{leadNote}</span>}</div>
          {!["Org Admin"].includes(form.role) && (
            <div className="field">
              <label>Groups</label>
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
        <WsEditor person={editWs} workspaces={me.workspaces} onClose={() => setEditWs(null)} onSave={(ids) => { patch(editWs, { workspaces: ids }, `Updated ${editWs.name}'s groups`); setEditWs(null); }} />
      )}
    </>
  );
}

function WsEditor({ person, workspaces, onClose, onSave }: { person: P; workspaces: { id: string; name: string }[]; onClose: () => void; onSave: (ids: string[]) => void }) {
  const [sel, setSel] = useState(person.workspaces);
  return (
    <Modal title={`${person.name}'s groups`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave(sel)}>Save</button></>}>
      {workspaces.map((w) => (
        <label key={w.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={sel.includes(w.id)} onChange={(e) => setSel(e.target.checked ? [...sel, w.id] : sel.filter((x) => x !== w.id))} />
          {w.name}
        </label>
      ))}
    </Modal>
  );
}
