"use client";

/**
 * The "Microsoft permissions" checklist on Settings (GET/POST /api/microsoft-permissions, lib/graph-permissions.ts):
 * one row per Microsoft permission Sidekick asks for, the features it unlocks (linking to where they live) and
 * whether the organization's Microsoft admin approved it: Approved, Not approved or Not checked yet.
 * Org Owners and Org Admins press **Check now** (one call to Microsoft, cached) and **Approve Sidekick for your
 * organization** (the admin-consent round trip, which comes back here with `?microsoft=approved`, or `?error=1`
 * and `about=permissions` with the reason in a one-time cookie, lib/flash.ts). Team Leads see it read-only.
 * Anchored at `#microsoft-permissions`, so features whose permission is missing link straight here.
 */

import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, Pill, useReportError, useToast } from "@/components/ui";
import { takeFlash } from "@/lib/flash";
import { BRAND } from "@/lib/brand";

type Row = { id: string; name: string; what: string; features: { label: string; href?: string }[]; status: "approved" | "missing" | "unknown"; reason: string | null };
type Status = {
  configured: boolean; connected: boolean; canAct: boolean; approvedAt: string | null; checkedAt: string | null; checkedBy: string | null;
  rows: Row[]; chats: Row[]; delegated: { id: string; name: string; what: string }[];
};

const LABEL = { approved: "Approved", missing: "Not approved", unknown: "Not checked yet" } as const;
const KIND = { approved: "good", missing: "bad", unknown: "" } as const;

/** One permission: plain name, Microsoft's name, what it unlocks, its status. */
function PermissionItem({ r }: { r: Row }) {
  return (
    <li style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "flex-start", padding: "10px 0", borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <b style={{ fontSize: 13.5 }}>{r.name}</b>
        <code style={{ fontSize: 11.5, wordBreak: "break-all" }} className="muted">{r.id}</code>
        <span className="muted" style={{ fontSize: 12.5 }}>{r.what}</span>
        <span style={{ fontSize: 12.5 }}>
          Unlocks: {r.features.map((f, i) => (
            <span key={f.label}>{i > 0 && " · "}{f.href ? <a href={f.href}>{f.label}</a> : f.label}</span>
          ))}
        </span>
        {r.reason && <span className="hint" style={{ color: "var(--bad)" }}>{r.reason}</span>}
      </div>
      <Pill kind={KIND[r.status]}>{LABEL[r.status]}</Pill>
    </li>
  );
}

/**
 * The panel. Shown on Settings to Org Owners, Org Admins (who act) and Team Leads (read-only).
 */
export function MicrosoftPermissionsPanel() {
  const toast = useToast();
  const reportError = useReportError();
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => api<Status>("/api/microsoft-permissions").then(setS).catch(reportError), [reportError]);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("microsoft") === "approved") toast(`${BRAND.name} is approved for your Microsoft 365 organization`);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (q.has("error") && q.get("about") === "permissions") setError(takeFlash(`Approving ${BRAND.name} in Microsoft didn't finish. Try again.`));
    if (q.get("microsoft") === "approved" || q.get("about") === "permissions") history.replaceState(null, "", "/settings#microsoft-permissions");
    load();
  }, [load, toast]);
  if (!s) return null;

  const check = async () => {
    setError("");
    setBusy(true);
    try {
      const r = await api<{ approved: number; total: number; status: Status }>("/api/microsoft-permissions", { method: "POST" });
      setS(r.status);
      toast(`${r.approved} of ${r.total} Microsoft permissions approved`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't check with Microsoft.");
    } finally {
      setBusy(false);
    }
  };
  const missing = s.rows.filter((r) => r.status === "missing").length;
  const ready = s.configured && s.connected;

  return (
    <div className="panel" id="microsoft-permissions" style={{ gridColumn: "1 / -1" }}>
      <div className="panel-h">
        <h2>Microsoft permissions</h2>
        {!ready ? <Pill>Not connected</Pill> : missing ? <Pill kind="bad">{missing} not approved</Pill> : s.rows.every((r) => r.status === "approved") ? <Pill kind="good">All approved</Pill> : <Pill>Not checked yet</Pill>}
      </div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          Everything {BRAND.name} may do in your Microsoft 365, and what each permission unlocks. A Microsoft admin of your organization approves them all at once.
          When {BRAND.name} adds a new feature that needs a new permission, it shows here as Not approved: approving again adds just the new ones.
        </p>
        {!s.configured && <p className="callout warn" style={{ margin: 0 }}>Microsoft isn&apos;t set up on this {BRAND.name} yet.</p>}
        {s.configured && !s.connected && <p className="callout" style={{ margin: 0 }}>Connect your organization to Microsoft first (Microsoft sign-in, above; the Org Owner does it).</p>}
        {ready && s.canAct && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <a className="btn primary" href="/api/auth/microsoft/consent?from=settings">Approve {BRAND.name} for your organization</a>
            <button className="btn" onClick={check} disabled={busy}>{busy ? "Checking…" : "Check now"}</button>
          </div>
        )}
        {ready && s.canAct && <span className="hint">Whoever approves must be a Microsoft admin of your organization (Global Administrator, Privileged Role Administrator or Cloud Application Administrator). Microsoft can take a minute to show a new approval: press Check now again if a row stays Not approved.</span>}
        {ready && !s.canAct && <span className="hint">Only Org Owners and Org Admins can check or approve these. Ask one of them if a feature you need is Not approved.</span>}
        <span className="muted" style={{ fontSize: 12.5 }}>
          {s.approvedAt ? <>Last approved {fmtDate(s.approvedAt)}. </> : null}
          {s.checkedAt ? <>Last checked {fmtDate(s.checkedAt)}{s.checkedBy ? ` by ${s.checkedBy}` : ""}.</> : <>Not checked with Microsoft yet.</>}
        </span>
        {error && <p className="err" role="alert" style={{ margin: 0 }}>{error}</p>}
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Approved with the button">
          {s.rows.map((r) => <PermissionItem key={r.id} r={r} />)}
        </ul>
        <h3 className="eyebrow" style={{ margin: "6px 0 0" }}>Granted by Teams in each chat</h3>
        <span className="muted" style={{ fontSize: 12.5 }}>Not part of the approval: Teams grants these in each chat or team when {BRAND.name} is added there.</span>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Granted by Teams in each chat">
          {s.chats.map((r) => <PermissionItem key={r.id} r={r} />)}
        </ul>
        <h3 className="eyebrow" style={{ margin: "6px 0 0" }}>Signing in</h3>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
          {s.delegated.map((d) => <li key={d.id}><b>{d.name}</b> <code className="muted">{d.id}</code>: <span className="muted">{d.what}</span></li>)}
        </ul>
      </div>
    </div>
  );
}
