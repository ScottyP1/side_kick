"use client";

/**
 * "Import from Microsoft 365" on Users & access: search the organization's Microsoft 365 directory, tick people,
 * choose their role and workspaces, and create them as people who sign in with Microsoft (no temporary
 * password). Uses GET /api/directory (status and search) and POST /api/directory/import.
 *
 * Before the first import a Microsoft admin of the organization approves Sidekick once ("Approve Sidekick for
 * your organization", GET /api/auth/microsoft/consent). Until then searching answers `consent: "needed"` and
 * this modal explains what the approval allows, with the approve button for Org Owners/Admins.
 * Also shows the result of that approval when Microsoft sends the browser back (`?microsoft=approved` / `?error=`).
 */

import { useEffect, useState } from "react";
import { api, ApiError, Icon, Modal, Pill, useToast } from "@/components/ui";

type Status = { configured: boolean; connected: boolean; approvedAt: string | null; canApprove: boolean; permissions: { name: string; what: string }[] };
type Person = { id: string; name: string; email: string; jobTitle: string | null; inSidekick: boolean };
type Result = { added: { name: string; created: boolean }[]; skipped: { name: string; reason: string }[] };

/**
 * The button and its modal. `roles` and `workspaces` are what this person may give (`lead`: a Team Lead, who
 * must pick at least one workspace); `onImported` reloads the list.
 */
export function DirectoryImport({ roles, workspaces, lead, onImported }: { roles: string[]; workspaces: { id: string; name: string }[]; lead: boolean; onImported: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [role, setRole] = useState("Member");
  const [ws, setWs] = useState<string[]>([]);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  // Coming back from Microsoft's approval page: say how it went once, then tidy the address.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("microsoft") === "approved") toast("Sidekick is approved for your Microsoft 365 organization. You can import people now.");
    else if (p.get("error")) toast(p.get("error")!, "error");
    else return;
    window.history.replaceState(null, "", window.location.pathname);
  }, [toast]);

  const show = async () => {
    setOpen(true);
    setError("");
    setResult(null);
    try {
      setStatus(await api<Status>("/api/directory"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't check Microsoft 365.");
    }
  };

  const search = async () => {
    setError("");
    setBusy(true);
    try {
      const r = await api<{ people: Person[] }>(`/api/directory?q=${encodeURIComponent(q)}`);
      setPeople(r.people);
      setNeedsConsent(false);
    } catch (e) {
      if (e instanceof ApiError && e.data?.consent === "needed") setNeedsConsent(true);
      setError(e instanceof Error ? e.message : "Couldn't search Microsoft 365.");
    } finally {
      setBusy(false);
    }
  };

  const importNow = async () => {
    setError("");
    setBusy(true);
    try {
      const r = await api<Result>("/api/directory/import", { method: "POST", json: { ids: picked, role, workspaces: ws } });
      setResult(r);
      setPicked([]);
      onImported();
      if (r.added.length) toast(`Added ${r.added.length} ${r.added.length === 1 ? "person" : "people"} from Microsoft 365`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't import those people.");
    } finally {
      setBusy(false);
    }
  };

  const approve = status?.canApprove ? (
    <a className="btn" href="/api/auth/microsoft/consent">Approve Sidekick for your organization</a>
  ) : (
    <span className="muted">Ask your Org Owner or an Org Admin to approve Sidekick for your organization.</span>
  );

  return (
    <>
      <button className="btn" onClick={show}><Icon n="plus" />Import from Microsoft 365</button>
      {open && (
        <Modal
          wide
          title="Import from Microsoft 365"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>Close</button>
              <button className="btn primary" disabled={busy || !picked.length || (lead && !ws.length)} onClick={importNow}>
                Import {picked.length || ""} {picked.length === 1 ? "person" : "people"}
              </button>
            </>
          }
        >
          {status && !status.configured && <div className="callout warn">Microsoft isn&apos;t set up on this Sidekick yet.</div>}
          {status?.configured && !status.connected && (
            <div className="callout info">First connect your organization to Microsoft: the Org Owner does it on <a href="/settings">Settings → Microsoft sign-in</a>.</div>
          )}
          {status?.connected && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                People you import sign in with their Microsoft work account (no password to hand out).{" "}
                {status.approvedAt ? <>Approved for your organization on {new Date(status.approvedAt).toLocaleDateString()}.</> : null}
              </p>
              {(needsConsent || (!status.approvedAt && status.canApprove)) && (
                <div className="callout info" style={{ flexDirection: "column", marginBottom: 12 }}>
                  <b>{needsConsent ? "Sidekick needs your Microsoft admin's approval first" : "Not approved yet?"}</b>
                  <span>A Microsoft admin of your organization approves Sidekick once. What it allows:</span>
                  <ul style={{ margin: "4px 0 8px 18px", padding: 0 }}>
                    {status.permissions.map((p) => <li key={p.name}><b>{p.name}</b>: {p.what}</li>)}
                  </ul>
                  <div>{approve}</div>
                </div>
              )}
              <form
                style={{ display: "flex", gap: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  search();
                }}
              >
                <input className="input" aria-label="Search by name or email" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
                <button className="btn" type="submit" disabled={busy}>Search</button>
              </form>
              {people && !people.length && <p className="muted">Nobody found. Try part of a name or an email.</p>}
              {!!people?.length && (
                <div className="table-wrap" style={{ marginTop: 10, maxHeight: 280, overflow: "auto" }}>
                  <table>
                    <tbody>
                      {people.map((p) => (
                        <tr key={p.id}>
                          <td style={{ width: 28 }}>
                            <input type="checkbox" aria-label={`Import ${p.name}`} checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} />
                          </td>
                          <td>
                            <b>{p.name}</b> {p.inSidekick && <Pill kind="good" nodot>Already in Sidekick</Pill>}
                            <div className="muted" style={{ fontSize: 12.5 }}>{p.email}{p.jobTitle ? ` · ${p.jobTitle}` : ""}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="irole">Role for the people you import</label>
                <select id="irole" className="input" value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r}>{r}</option>)}</select>
              </div>
              {role !== "Org Admin" && (
                <div className="field">
                  <label>Workspaces</label>
                  {workspaces.map((w) => (
                    <label key={w.id} style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
                      <input type="checkbox" checked={ws.includes(w.id)} onChange={(e) => setWs(e.target.checked ? [...ws, w.id] : ws.filter((x) => x !== w.id))} />
                      {w.name}
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
          {result && (
            <div className="callout info" style={{ flexDirection: "column" }}>
              {result.added.map((a) => <span key={a.name}>✓ {a.name}{a.created ? " (new, signs in with Microsoft)" : " (added to the workspaces)"}</span>)}
              {result.skipped.map((s) => <span key={s.name}>✗ {s.name}: {s.reason}</span>)}
            </div>
          )}
          {error && <p className="err">{error}</p>}
        </Modal>
      )}
    </>
  );
}
