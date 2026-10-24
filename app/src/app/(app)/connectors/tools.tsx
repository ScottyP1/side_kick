"use client";

/**
 * The connected-tools part of the Connectors page: Azure DevOps Boards, Jira, GitHub Issues, Confluence and
 * Microsoft 365 files (SharePoint libraries, OneDrive shared folders), as an **approve → link → request** flow:
 * - the **Org Owner** turns each tool on or off for the organization with a toggle ("allowed for our
 *   organization"). Turning one on starts the tool's one-time sign-in (ADO first asks for the organization name,
 *   Jira and Confluence optionally for the Atlassian site); turning it off asks first, then removes the sign-in and
 *   everything it imported. The plan's connector limit disables the toggle with the upgrade message;
 * - **Team Leads and Org Admins** see tools that are on as ready to link to a group (pick the projects, GitHub:
 *   repositories, Confluence: spaces, Microsoft 365: libraries or folders; internal or shareable), sync now or
 *   unlink; tools that are off have a **Request** button with an optional reason, which goes to the Org Owner;
 *   Org Admins can also reconnect an expired sign-in;
 * - **Requests** (`RequestsPanel`, #requests): the Org Owner approves (= turns the tool on, signing in if needed)
 *   or declines with a note; the person who asked sees the status here (and on Home) and can cancel while pending;
 * - everyone else sees whether each tool is on and the status of their own groups' projects.
 * Health per tool: last sync, last success, the problem in plain words, an expired sign-in, files not read.
 * Data: GET /api/connectors (health, requests, what the viewer may do), /api/connectors/<id>/projects,
 * POST/DELETE /api/connectors/links[/<id>[/sync]], DELETE /api/connectors/<id>, POST /api/connectors/requests[/<id>],
 * GET /api/connectors/start (a page navigation). Server side: lib/connectors.ts and lib/connector-requests.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtDate, fmtTime, Pill, Spinner, useReportError, useToast } from "@/components/ui";
import { CONNECTOR_ICONS } from "@/components/connector-icons";
import { takeFlash } from "@/lib/flash";
import { BRAND } from "@/lib/brand";

/** The tools (lib/connector-text.ts `ConnectorKind`), in the order their panels show. */
export const KINDS = ["ado", "jira", "github", "confluence", "m365"] as const;
type Kind = (typeof KINDS)[number];
type LinkHealth = {
  id: string; connectorId: string; kind: Kind; workspaceId: string; workspaceName: string; project: string; projectName: string;
  audience: "internal" | "shareable"; items: number; skipped: number; lastSyncAt: string | null; lastOkAt: string | null; syncing: boolean; problem: string | null;
};
type ConnectorHealth = {
  id: string; kind: Kind; label: string; account: string; accountName: string | null; status: "ok" | "expired" | "error" | "waiting";
  problem: string | null; connectedBy: string | null; connectedAt: string; lastSyncAt: string | null; lastOkAt: string | null; links: LinkHealth[];
};
/** A request to turn a tool on (lib/connector-requests.ts `ConnectorRequest`). */
type ToolRequest = {
  id: string; kind: Kind; label: string; workspaceId: string; workspaceName: string; requestedBy: string; reason: string | null;
  status: "pending" | "approved" | "declined" | "cancelled"; decidedBy: string | null; decidedAt: string | null; note: string | null;
  createdAt: string; mine: boolean; canDecide: boolean;
};
type Data = {
  connectors: ConnectorHealth[]; configured: Record<Kind, boolean>; requests: ToolRequest[];
  canToggle: boolean; canReconnect: boolean; canRequest: boolean;
};

/**
 * Each tool's tile facts and connect wording: `site` is what to type before connecting (null: nothing), `signIn`
 * whose sign-in opens, `project`/`projects`/`items` what a linked project (one, several) and its items are called,
 * `icon` which tile icon its panel shows (default: its name).
 */
export const TOOLS: Record<Kind, { name: string; bg: string; what: string; signIn: string; project: string; projects: string; items: string; icon?: string; site: { label: string; placeholder: string; hint: string; optional?: boolean } | null }> = {
  ado: {
    name: "Azure DevOps", bg: "#0078D4", what: "Boards: work items, their state, owners, due dates and what blocks them", signIn: "your Microsoft work account", project: "project", projects: "projects", items: "work items",
    site: { label: "Azure DevOps organization", placeholder: "northwind", hint: "The name after dev.azure.com/" },
  },
  jira: {
    name: "Jira", bg: "#0052CC", what: "Issues: status, assignee, due dates, links and comments", signIn: "your Atlassian account", project: "project", projects: "projects", items: "work items",
    site: { label: "Jira site (optional)", placeholder: "northwind", hint: "The name before .atlassian.net; leave it empty if you use one site", optional: true },
  },
  github: {
    name: "GitHub", bg: "#24292F", what: "Issues and pull requests: state, assignees, labels, milestones and comments", signIn: "your GitHub account", project: "repository", projects: "repositories", items: "issues and pull requests",
    site: null,
  },
  confluence: {
    name: "Confluence", bg: "#1868DB", what: "Spaces and pages, kept up to date as group documents", signIn: "your Atlassian account", project: "space", projects: "spaces", items: "pages",
    site: { label: "Confluence site (optional)", placeholder: "northwind", hint: "The name before .atlassian.net; leave it empty if you use one site", optional: true },
  },
  m365: {
    name: "Microsoft 365 files", bg: "#038387", icon: "SharePoint", what: "SharePoint document libraries and OneDrive shared folders: Word, PDF, PowerPoint and text files, kept up to date as group documents",
    signIn: "your Microsoft work account", project: "library or folder", projects: "libraries or folders", items: "files", site: null,
  },
};

/** The address that turns a tool on (or reconnects it): a page navigation to the tool's sign-in. */
const startUrl = (kind: Kind, site?: string) => `/api/connectors/start?kind=${kind}${site ? `&site=${encodeURIComponent(site)}` : ""}`;

/** The tile's status pill for a tool: on (and healthy or not), requested, or off (and why it can't be turned on). */
export function toolPill(kind: Kind, data: Data | null, included: number | null | undefined) {
  const c = data?.connectors.find((x) => x.kind === kind);
  if (c?.status === "expired") return <Pill kind="bad">Sign-in expired</Pill>;
  if (c?.status === "error") return <Pill kind="warn">Needs attention</Pill>;
  if (c) return <Pill kind="good">On</Pill>;
  if (data && !data.configured[kind]) return <Pill>Not set up yet</Pill>;
  if (included === 0) return <Pill>Not in your plan</Pill>;
  if (data?.requests.some((r) => r.kind === kind && r.status === "pending")) return <Pill kind="info">Requested</Pill>;
  return <Pill>{data?.canToggle ? "Off" : "Not approved"}</Pill>;
}

/** Loads the connectors' health once for the page (tiles and panels share it). */
export function useConnectors() {
  const reportError = useReportError();
  const [data, setData] = useState<Data | null>(null);
  const load = useCallback(() => api<Data>("/api/connectors").then(setData).catch(reportError), [reportError]);
  return { data, load };
}

const ago = (s: string | null) => (s ? fmtTime(s) : "never");

/** What a plan-limited tool says, with the upgrade link for the people who can upgrade. */
function PlanNote() {
  const { me } = useApp();
  return (
    <div className="callout">
      {me.plan?.connectors === 0 ? `Your ${me.plan?.name ?? ""} plan doesn't include connectors to other tools.` : `Your ${me.plan?.name ?? ""} plan includes ${me.plan?.connectors} connected tool${me.plan?.connectors === 1 ? "" : "s"}, already in use.`}{" "}
      {["Org Owner", "Billing Admin"].includes(me.user.role) ? <a href="/usage">Upgrade on Usage &amp; billing</a> : "An Org Owner or Billing Admin can upgrade on Usage & billing."}
    </div>
  );
}

/** The panels for every tool, with the requests above them (see the file comment). */
export function ToolPanels({ data, load }: { data: Data | null; load: () => Promise<void> }) {
  const { me } = useApp();
  const toast = useToast();
  const [error, setError] = useState("");
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const done = q.get("connected");
    if ((KINDS as readonly string[]).includes(done ?? "")) toast(`${TOOLS[done as Kind].name} is on. Team Leads can link a ${TOOLS[done as Kind].project} to their group now.`);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (q.has("error")) setError(takeFlash("Turning the tool on didn't finish. Try again."));
    if (q.size) history.replaceState(null, "", "/connectors" + location.hash);
    load();
  }, [load, toast]);
  if (!data) return <div className="panel"><div className="empty"><Spinner /> Loading connected tools…</div></div>;
  const included = me.plan?.connectors;
  const usedKinds = data.connectors.map((c) => c.kind);
  return (
    <>
      {error && <div className="callout bad" role="alert">{error}</div>}
      <RequestsPanel data={data} reload={load} />
      <section style={{ display: "flex", flexDirection: "column", gap: 12 }} id="tools">
        <div className="eyebrow">{data.canToggle ? "Tools your organization may use (read-only)" : "Tools your organization uses (read-only)"}</div>
        {KINDS.map((k) => (
          <ToolPanel key={k} kind={k} data={data} c={data.connectors.find((x) => x.kind === k) ?? null}
            blocked={included === 0 || (included !== null && included !== undefined && !usedKinds.includes(k) && usedKinds.length >= included)} reload={load} />
        ))}
      </section>
    </>
  );
}

/**
 * Requests to turn tools on: pending ones first (Approve / Decline for the Org Owner, Cancel for the person who
 * asked), then the last 30 days of decided ones. Hidden when there are none.
 */
function RequestsPanel({ data, reload }: { data: Data; reload: () => Promise<void> }) {
  const pending = data.requests.filter((r) => r.status === "pending");
  const decided = data.requests.filter((r) => r.status !== "pending");
  if (!data.requests.length) return null;
  return (
    <section className="panel" id="requests">
      <div className="panel-h">
        <h2 style={{ margin: 0 }}>Requests to turn tools on</h2>
        {pending.length ? <Pill kind="warn">{pending.length} waiting</Pill> : null}
      </div>
      <div style={{ padding: "12px 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        {!pending.length && <div className="muted">Nothing waiting.</div>}
        {pending.map((r) => <RequestRow key={r.id} r={r} reload={reload} />)}
        {decided.length ? (
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>Decided in the last 30 days ({decided.length})</summary>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {decided.map((r) => <RequestRow key={r.id} r={r} reload={reload} />)}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}

const STATUS_PILL: Record<ToolRequest["status"], { kind: string; text: string }> = {
  pending: { kind: "warn", text: "Waiting for the Org Owner" }, approved: { kind: "good", text: "Approved" },
  declined: { kind: "bad", text: "Declined" }, cancelled: { kind: "", text: "Cancelled" },
};

/** One request: who asked for which tool and group, why, its status, and the actions this person may take. */
function RequestRow({ r, reload }: { r: ToolRequest; reload: () => Promise<void> }) {
  const toast = useToast();
  const t = TOOLS[r.kind];
  const [mode, setMode] = useState<"" | "approve" | "decline">("");
  const [site, setSite] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async (json: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ approved?: boolean; signIn?: string }>(`/api/connectors/requests/${r.id}`, { method: "POST", json });
      if (res.signIn) {
        location.assign(res.signIn); // the tool's one-time sign-in; the request is approved when it finishes
        return;
      }
      toast(done);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
      setBusy(false);
    }
  };
  const approve = () => (t.site && mode !== "approve" ? setMode("approve") : send({ action: "approve", site }, `${t.name} approved for ${r.workspaceName}`));
  const pill = STATUS_PILL[r.status];
  return (
    <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }} data-request={r.id}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span className="app-ico" style={{ background: t.bg, color: "#fff", width: 28, height: 28, fontSize: 12 }} aria-hidden="true">{CONNECTOR_ICONS[t.icon ?? t.name]}</span>
        <div className="grow" style={{ flex: 1, minWidth: 200 }}>
          <b>{r.mine ? "You" : r.requestedBy}</b> asked for <b>{t.name}</b> in <b>{r.workspaceName}</b>
          <div className="muted" style={{ fontSize: 12.5 }}>{fmtDate(r.createdAt)}{r.decidedBy && r.status !== "pending" ? ` · ${r.status} by ${r.decidedBy} on ${fmtDate(r.decidedAt)}` : ""}</div>
        </div>
        <Pill kind={pill.kind}>{pill.text}</Pill>
      </div>
      {r.reason && <div style={{ fontSize: 13.5 }}>“{r.reason}”</div>}
      {r.note && <div className="muted" style={{ fontSize: 13 }}>Note from {r.decidedBy ?? "the Org Owner"}: “{r.note}”</div>}
      {error && <div className="callout bad" role="alert">{error}</div>}
      {r.status === "pending" && (r.canDecide || r.mine) && (
        <>
          {mode === "approve" && t.site && (
            <label className="field" style={{ maxWidth: 320 }}>
              <span>{t.site.label}</span>
              <input className="input" value={site} onChange={(e) => setSite(e.target.value)} placeholder={t.site.placeholder} pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,49}" />
              <span className="muted" style={{ fontSize: 12 }}>{t.site.hint}</span>
            </label>
          )}
          {mode === "decline" && (
            <label className="field">
              <span>Note for {r.requestedBy} (optional)</span>
              <textarea className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: we're moving off Jira this quarter." />
            </label>
          )}
          <div className="actions">
            {r.canDecide && mode !== "decline" && (
              <button className="btn primary small" disabled={busy || (mode === "approve" && !!t.site && !t.site.optional && !site.trim())} onClick={approve}>
                {busy ? <Spinner /> : mode === "approve" ? `Approve and sign in to ${t.name}` : "Approve"}
              </button>
            )}
            {r.canDecide && mode !== "approve" && (
              <button className="btn small" disabled={busy} onClick={() => (mode === "decline" ? send({ action: "decline", note }, "Request declined") : setMode("decline"))}>
                {mode === "decline" ? "Decline request" : "Decline"}
              </button>
            )}
            {mode && <button className="btn ghost small" disabled={busy} onClick={() => setMode("")}>Back</button>}
            {r.mine && !mode && <button className="btn ghost small" disabled={busy} onClick={() => send({ action: "cancel" }, "Request cancelled")}>Cancel request</button>}
          </div>
          {r.canDecide && <div className="muted" style={{ fontSize: 12.5 }}>Approving turns {t.name} on for your whole organization (read-only); you sign in to it once, then Team Leads link it to their groups.</div>}
        </>
      )}
    </div>
  );
}

/** One tool: the Org Owner's on/off toggle, its health, linked projects, and the request flow when it's off. */
function ToolPanel({ kind, data, c, blocked, reload }: { kind: Kind; data: Data; c: ConnectorHealth | null; blocked: boolean; reload: () => Promise<void> }) {
  const { me } = useApp();
  const toast = useToast();
  const t = TOOLS[kind];
  const configured = data.configured[kind];
  const lead = me.user.role === "Team Lead";
  const admin = me.user.role === "Org Owner" || me.user.role === "Org Admin";
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [turningOn, setTurningOn] = useState(false);
  const act = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    setError("");
    try {
      await fn();
      toast(done);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
      await reload(); // health may have changed (e.g. a failed sync)
    } finally {
      setBusy("");
    }
  };
  const turnOff = () => {
    if (!c) return;
    const items = c.links.reduce((n, l) => n + l.items, 0);
    if (!confirm(`Turn ${t.name} off for your organization?\n\n${BRAND.name} stops syncing, forgets its sign-in and removes every linked ${t.project} (${c.links.length}) and all ${items} ${t.items} it read from your groups' knowledge. Turning it back on means signing in and linking again.`)) return;
    void act("off", () => api(`/api/connectors/${c.id}`, { method: "DELETE" }), `${t.name} is off`);
  };
  const turnOn = () => (t.site ? setTurningOn(true) : location.assign(startUrl(kind)));
  const pendingHere = data.requests.filter((r) => r.kind === kind && r.status === "pending");
  const declinedHere = data.requests.filter((r) => r.kind === kind && r.status === "declined");
  const canSwitch = data.canToggle && (!!c || (configured && !blocked));
  return (
    <div className="panel" id={`tool-${kind}`}>
      <div className="panel-h" style={{ gap: 12, flexWrap: "wrap" }}>
        <span className="app-ico" style={{ background: t.bg, color: "#fff", width: 36, height: 36 }} aria-hidden="true">{CONNECTOR_ICONS[t.icon ?? t.name]}</span>
        <div className="grow" style={{ flex: 1, minWidth: 200 }}>
          <h2 style={{ margin: 0 }}>{t.name}</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>{c ? `On · ${c.accountName ?? c.account} · turned on by ${c.connectedBy ?? "someone"} on ${fmtTime(c.connectedAt)}` : t.what}</span>
        </div>
        {c && (c.status === "expired" ? <Pill kind="bad">Sign-in expired</Pill> : c.status === "error" ? <Pill kind="warn">Needs attention</Pill> : c.status === "waiting" ? <Pill kind="info">First sync pending</Pill> : <Pill kind="good">Healthy</Pill>)}
        {/* A page navigation (not fetch): the tool's sign-in opens and comes back here. */}
        {c && data.canReconnect && <a className="btn small ghost" href={startUrl(kind, t.site ? (kind === "ado" ? c.account : c.accountName ?? "") : undefined)}>Reconnect</a>}
        {data.canToggle ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span className="muted" aria-hidden="true">{c ? "Allowed" : "Off"}</span>
            <button className="switch" role="switch" aria-checked={!!c} aria-label={`Allow ${t.name} for our organization`} disabled={!canSwitch || busy === "off" || turningOn}
              onClick={() => (c ? turnOff() : turnOn())} style={!canSwitch ? { opacity: 0.5, cursor: "not-allowed" } : undefined} />
          </div>
        ) : !c && <Pill>{configured ? (pendingHere.length ? "Requested" : "Not approved") : "Not set up yet"}</Pill>}
      </div>
      <div style={{ padding: "12px 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {error && <div className="callout bad" role="alert">{error}</div>}
        {!c && !configured && <div className="callout">Connecting {t.name} isn&apos;t set up on this {BRAND.name} yet: the {BRAND.name} team adds its app first.</div>}
        {!c && configured && blocked && <PlanNote />}
        {!c && turningOn && t.site && (
          // A plain GET form: the browser goes to the tool's sign-in and comes back to this page.
          <form className="actions" style={{ alignItems: "flex-end", flexWrap: "wrap" }} method="get" action="/api/connectors/start">
            <input type="hidden" name="kind" value={kind} />
            <label className="field" style={{ minWidth: 220 }}>
              <span>{t.site.label}</span>
              <input className="input" name="site" required={!t.site.optional} pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,49}" title={t.site.hint} placeholder={t.site.placeholder} aria-describedby={`hint-${kind}`} autoFocus />
              <span className="muted" id={`hint-${kind}`} style={{ fontSize: 12 }}>{t.site.hint}</span>
            </label>
            <button className="btn primary" type="submit">Turn on and sign in</button>
            <button className="btn ghost" type="button" onClick={() => setTurningOn(false)}>Cancel</button>
          </form>
        )}
        {!c && configured && !blocked && data.canToggle && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            Turning it on lets your Team Leads link it to their groups. You sign in once with {t.signIn}; {BRAND.name} only reads, and stores no password.
            {kind === "github" && " Only repositories your GitHub owner installed the Sidekick app on can be linked."}
            {kind === "m365" && ` The first time, Microsoft asks an admin of your organization to approve ${BRAND.name} reading SharePoint and OneDrive files.`}
            {pendingHere.length ? ` ${pendingHere.length} request${pendingHere.length === 1 ? " is" : "s are"} waiting for it (above).` : ""}
          </span>
        )}
        {!c && configured && !blocked && data.canRequest && (
          <RequestBox kind={kind} pending={pendingHere} declined={declinedHere} reload={reload} />
        )}
        {!c && configured && !data.canToggle && !data.canRequest && (
          <div className="muted">{t.name} isn&apos;t turned on for your organization. Your Team Lead can ask the Org Owner for it.</div>
        )}
        {c?.problem && <div className={`callout ${c.status === "expired" ? "bad" : "warn"}`} role="status">{c.problem}</div>}
        {c && <Links c={c} canLink={admin || lead} reload={reload} act={act} busy={busy} />}
      </div>
    </div>
  );
}

/**
 * For a Team Lead or Org Admin when a tool is off: their groups' pending requests (cancel their own), the latest
 * decline with its note, and the Request form (group, optional reason).
 */
function RequestBox({ kind, pending, declined, reload }: { kind: Kind; pending: ToolRequest[]; declined: ToolRequest[]; reload: () => Promise<void> }) {
  const { me, ws: current } = useApp();
  const toast = useToast();
  const t = TOOLS[kind];
  const free = me.workspaces.filter((w) => !pending.some((r) => r.workspaceId === w.id));
  const [open, setOpen] = useState(false);
  const [ws, setWs] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const group = ws || (free.some((w) => w.id === current) ? current : free[0]?.id) || "";
  const send = async () => {
    setSaving(true);
    setError("");
    try {
      await api("/api/connectors/requests", { method: "POST", json: { kind, ws: group, reason } });
      toast(`Request sent to the Org Owner`);
      setOpen(false);
      setReason("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the request.");
    } finally {
      setSaving(false);
    }
  };
  const cancel = async (id: string) => {
    try {
      await api(`/api/connectors/requests/${id}`, { method: "POST", json: { action: "cancel" } });
      toast("Request cancelled");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't cancel it.");
    }
  };
  const lastDeclined = declined[0];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="muted">{t.name} isn&apos;t approved for your organization yet. Ask the Org Owner to turn it on, then link it to your group.</div>
      {pending.map((r) => (
        <div key={r.id} className="callout" role="status" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1 }}>Requested for <b>{r.workspaceName}</b> by {r.mine ? "you" : r.requestedBy} on {fmtDate(r.createdAt)}: waiting for the Org Owner.</span>
          {r.mine && <button className="btn ghost small" onClick={() => cancel(r.id)}>Cancel request</button>}
        </div>
      ))}
      {lastDeclined && !pending.length && (
        <div className="callout warn" role="status">
          {lastDeclined.decidedBy ?? "The Org Owner"} declined the request for {lastDeclined.workspaceName} on {fmtDate(lastDeclined.decidedAt)}{lastDeclined.note ? `: “${lastDeclined.note}”` : "."}
        </div>
      )}
      {error && <div className="callout bad" role="alert">{error}</div>}
      {free.length > 0 && (open ? (
        <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <label className="field">
            <span>For which group</span>
            <select className="input" value={group} onChange={(e) => setWs(e.target.value)}>
              {free.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Why (optional)</span>
            <textarea className="input" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`For example: the client tracks the cutover in ${t.name}.`} />
          </label>
          <div className="actions">
            <button className="btn primary" onClick={send} disabled={saving || !group}>{saving ? <><Spinner /> Sending…</> : "Send request"}</button>
            <button className="btn ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</button>
          </div>
        </div>
      ) : <div><button className="btn small" onClick={() => setOpen(true)}>Request {t.name}</button></div>)}
    </div>
  );
}

function Links({ c, canLink, reload, act, busy }: { c: ConnectorHealth; canLink: boolean; reload: () => Promise<void>; act: (l: string, fn: () => Promise<unknown>, done: string) => Promise<void>; busy: string }) {
  const { me } = useApp();
  const [adding, setAdding] = useState(false);
  const t = TOOLS[c.kind];
  const Word = t.project[0].toUpperCase() + t.project.slice(1);
  return (
    <>
      {c.links.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{Word}</th><th>Group</th><th>Status</th><th className="r">Items</th><th>Last sync</th><th /></tr></thead>
            <tbody>
              {c.links.map((l) => (
                <tr key={l.id}>
                  <td><b>{l.projectName}</b><div className="muted" style={{ fontSize: 12 }}>{l.audience === "shareable" ? "Shareable (also with client guests)" : "Internal (team only)"}</div></td>
                  <td>{l.workspaceName}</td>
                  <td>
                    {c.status === "expired" ? <Pill>Paused</Pill> : l.syncing ? <Pill kind="info">Syncing</Pill> : l.problem ? <Pill kind="bad">Problem</Pill> : l.lastOkAt ? <Pill kind="good">OK</Pill> : <Pill>Waiting</Pill>}
                    {/* An expired sign-in is explained once, above the table. */}
                    {l.problem && c.status !== "expired" && <div style={{ fontSize: 12.5, color: "var(--bad)", maxWidth: 360 }}>{l.problem}</div>}
                  </td>
                  <td className="r num">{l.items}{l.skipped ? <div className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }} title="Too large (over 25 MB) or couldn't be opened: answers can name them with a link, but their contents weren't read">{l.skipped} not read</div> : null}</td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {/* After a reconnect the last try is cleared (so it syncs soon): show the last success instead. */}
                    {ago(l.lastSyncAt ?? l.lastOkAt)}
                    {l.lastSyncAt && l.lastOkAt && l.lastOkAt !== l.lastSyncAt ? <div style={{ fontSize: 12 }}>last OK {ago(l.lastOkAt)}</div> : null}
                  </td>
                  <td className="r" style={{ whiteSpace: "nowrap" }}>
                    {canLink && me.workspaces.some((w) => w.id === l.workspaceId) && (
                      <>
                        <button className="btn small ghost" disabled={!!busy || c.status === "expired"} onClick={() => act(`sync-${l.id}`, async () => {
                          const r = await api<{ link: LinkHealth }>(`/api/connectors/links/${l.id}/sync`, { method: "POST" });
                          if (r.link.problem) throw new Error(r.link.problem); // shown above the table, not as "Synced"
                        }, `Synced ${l.projectName}`)}>
                          {busy === `sync-${l.id}` ? <Spinner /> : "Sync now"}
                        </button>
                        <button className="btn small ghost" disabled={!!busy} onClick={() => confirm(`Unlink ${l.projectName} from ${l.workspaceName}? Its ${l.items} ${t.items} leave the group's knowledge.`) && act(`unlink-${l.id}`, () => api(`/api/connectors/links/${l.id}`, { method: "DELETE" }), `Unlinked ${l.projectName}`)}>
                          Unlink
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted">No {t.projects} linked to your groups yet.{canLink ? ` Link one so its ${t.items} become part of a group's knowledge.` : ""}</div>
      )}
      {canLink && c.status !== "expired" && (adding
        ? <LinkForm c={c} onDone={async () => { setAdding(false); await reload(); }} onCancel={() => setAdding(false)} />
        : <div><button className="btn small" onClick={() => setAdding(true)}>Link a {t.project} to a group</button></div>)}
    </>
  );
}

function LinkForm({ c, onDone, onCancel }: { c: ConnectorHealth; onDone: () => Promise<void>; onCancel: () => void }) {
  const { me, ws: current } = useApp();
  const toast = useToast();
  const [projects, setProjects] = useState<{ key: string; name: string }[] | null>(null);
  const [project, setProject] = useState("");
  const [ws, setWs] = useState(current || me.workspaces[0]?.id || "");
  const [audience, setAudience] = useState<"internal" | "shareable">("internal");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const t = TOOLS[c.kind];
  useEffect(() => {
    api<{ projects: { key: string; name: string }[] }>(`/api/connectors/${c.id}/projects`)
      .then((r) => { setProjects(r.projects); setProject(r.projects[0]?.key ?? ""); })
      .catch((e) => setError(e instanceof Error ? e.message : `Couldn't load the ${t.projects}.`));
  }, [c.id, t.projects]);
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const r = await api<{ link: LinkHealth }>("/api/connectors/links", { method: "POST", json: { connector: c.id, ws, project, audience } });
      toast(r.link.problem ? `Linked, but the first sync had a problem: ${r.link.problem}` : `Linked ${r.link.projectName}: ${r.link.items} ${t.items} read`, r.link.problem ? "error" : "info");
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't link it.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      {error && <div className="callout bad" role="alert">{error}</div>}
      <div className="form-grid" style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <label className="field">
          <span>{t.project[0].toUpperCase() + t.project.slice(1)} in {c.label}</span>
          {projects ? (
            <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
              {!projects.length && <option value="">{c.kind === "github" ? "No repositories: install the app on one first" : `No ${t.projects} this account can read`}</option>}
              {/* Microsoft 365 keys are Graph drive ids: meaningless to people, so only the name shows. */}
              {projects.map((p) => <option key={p.key} value={p.key}>{p.name}{p.name !== p.key && c.kind !== "m365" ? ` (${p.key})` : ""}</option>)}
            </select>
          ) : <span className="muted"><Spinner /> Loading…</span>}
        </label>
        <label className="field">
          <span>Group</span>
          <select className="input" value={ws} onChange={(e) => setWs(e.target.value)}>
            {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      </div>
      <div className="field">
        <span>Who may see its {t.items} in answers</span>
        <div className="seg">
          {(["internal", "shareable"] as const).map((a) => (
            <button key={a} type="button" aria-pressed={audience === a} onClick={() => setAudience(a)}>{a === "internal" ? "Internal (team only)" : "Shareable (also with client guests)"}</button>
          ))}
        </div>
      </div>
      <div className="actions">
        <button className="btn primary" onClick={save} disabled={saving || !project || !ws}>{saving ? <><Spinner /> Linking and reading {t.items}…</> : "Link and sync"}</button>
        <button className="btn ghost" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}
