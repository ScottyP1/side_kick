"use client";

/**
 * The connected-tools part of the Connectors page: Azure DevOps Boards, Jira, GitHub Issues, Confluence and
 * Microsoft 365 files (SharePoint libraries, OneDrive shared folders). For each tool it shows whether it's
 * connected and healthy (last sync, last success, the problem in plain words, an expired sign-in), the projects
 * (GitHub: repositories, Confluence: spaces, Microsoft 365: libraries or folders) linked to groups, how many files
 * weren't read (too large), and the actions the person's role allows:
 * - Org Owners/Admins connect (the tool's own sign-in; ADO first asks for the organization name, Jira and
 *   Confluence optionally for the Atlassian site, GitHub and Microsoft 365 for nothing), reconnect and disconnect
 *   (which removes the sign-in and every imported item);
 * - Org Owners/Admins and Team Leads link a project to one of their groups (internal or shareable), sync it now,
 *   or unlink it;
 * - everyone else sees the status of their own groups' projects.
 * Data: GET /api/connectors (health), /api/connectors/<id>/projects, POST/DELETE /api/connectors/links[/<id>[/sync]],
 * DELETE /api/connectors/<id>, GET /api/connectors/start (a page navigation). Server side: lib/connectors.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtTime, Pill, Spinner, useReportError, useToast } from "@/components/ui";
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
type Data = { connectors: ConnectorHealth[]; configured: Record<Kind, boolean> };

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

/** The tile's status pill for a tool, from its health (or why it can't connect). */
export function toolPill(kind: Kind, data: Data | null, included: number | null | undefined) {
  const c = data?.connectors.find((x) => x.kind === kind);
  if (c?.status === "expired") return <Pill kind="bad">Sign-in expired</Pill>;
  if (c?.status === "error") return <Pill kind="warn">Needs attention</Pill>;
  if (c) return <Pill kind="good">Connected</Pill>;
  if (data && !data.configured[kind]) return <Pill>Not set up yet</Pill>;
  if (included === 0) return <Pill>Not in your plan</Pill>;
  return <Pill kind="info">Ready to connect</Pill>;
}

/** Loads the connectors' health once for the page (tiles and panels share it). */
export function useConnectors() {
  const reportError = useReportError();
  const [data, setData] = useState<Data | null>(null);
  const load = useCallback(() => api<Data>("/api/connectors").then(setData).catch(reportError), [reportError]);
  return { data, load };
}

const ago = (s: string | null) => (s ? fmtTime(s) : "never");

/** The panels for every tool (see the file comment). */
export function ToolPanels({ data, load }: { data: Data | null; load: () => Promise<void> }) {
  const { me } = useApp();
  const toast = useToast();
  const [error, setError] = useState("");
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const done = q.get("connected");
    if ((KINDS as readonly string[]).includes(done ?? "")) toast(`${TOOLS[done as Kind].name} connected. Link a ${TOOLS[done as Kind].project} to a group next.`);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (q.has("error")) setError(takeFlash("Connecting didn't finish. Try again."));
    if (q.size) history.replaceState(null, "", "/connectors");
    load();
  }, [load, toast]);
  if (!data) return <div className="panel"><div className="empty"><Spinner /> Loading connected tools…</div></div>;
  const included = me.plan?.connectors;
  const usedKinds = data.connectors.map((c) => c.kind);
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }} id="tools">
      <div className="eyebrow">Connected tools (read-only)</div>
      {error && <div className="callout bad" role="alert">{error}</div>}
      {KINDS.map((k) => (
        <ToolPanel key={k} kind={k} c={data.connectors.find((x) => x.kind === k) ?? null} configured={data.configured[k]}
          blocked={included === 0 || (included !== null && included !== undefined && !usedKinds.includes(k) && usedKinds.length >= included)} reload={load} />
      ))}
    </section>
  );
}

function ToolPanel({ kind, c, configured, blocked, reload }: { kind: Kind; c: ConnectorHealth | null; configured: boolean; blocked: boolean; reload: () => Promise<void> }) {
  const { me } = useApp();
  const toast = useToast();
  const t = TOOLS[kind];
  const admin = me.user.role === "Org Owner" || me.user.role === "Org Admin";
  const lead = me.user.role === "Team Lead";
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
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
  const disconnect = () => {
    if (!c || !confirm(`Disconnect ${t.name}? ${BRAND.name} forgets its sign-in and removes every one of the ${t.items} it read (${c.links.reduce((n, l) => n + l.items, 0)}) from your groups' knowledge.`)) return;
    void act("disconnect", () => api(`/api/connectors/${c.id}`, { method: "DELETE" }), `${t.name} disconnected`);
  };
  return (
    <div className="panel" id={`tool-${kind}`}>
      <div className="panel-h" style={{ gap: 12, flexWrap: "wrap" }}>
        <span className="app-ico" style={{ background: t.bg, color: "#fff", width: 36, height: 36 }} aria-hidden="true">{CONNECTOR_ICONS[t.icon ?? t.name]}</span>
        <div className="grow" style={{ minWidth: 200 }}>
          <h2 style={{ margin: 0 }}>{t.name}</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>{c ? `${c.accountName ?? c.account} · connected by ${c.connectedBy ?? "someone"} on ${fmtTime(c.connectedAt)}` : t.what}</span>
        </div>
        {c ? (
          <>
            {c.status === "expired" ? <Pill kind="bad">Sign-in expired</Pill> : c.status === "error" ? <Pill kind="warn">Needs attention</Pill> : c.status === "waiting" ? <Pill kind="info">First sync pending</Pill> : <Pill kind="good">Healthy</Pill>}
            {admin && (
              <>
                {/* A page navigation (not fetch): the tool's sign-in opens and comes back here. */}
                <a className="btn small" href={`/api/connectors/start?kind=${kind}${t.site ? `&site=${encodeURIComponent(kind === "ado" ? c.account : c.accountName ?? "")}` : ""}`}>Reconnect</a>
                <button className="btn small ghost" onClick={disconnect} disabled={busy === "disconnect"}>Disconnect</button>
              </>
            )}
          </>
        ) : null}
      </div>
      <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {error && <div className="callout bad" role="alert">{error}</div>}
        {!c && !configured && <div className="callout">Connecting {t.name} isn&apos;t set up on this {BRAND.name} yet: the {BRAND.name} team adds its app first.</div>}
        {!c && configured && blocked && (
          <div className="callout">
            {me.plan?.connectors === 0 ? `Your ${me.plan?.name ?? ""} plan doesn't include connectors to other tools.` : `Your ${me.plan?.name ?? ""} plan includes ${me.plan?.connectors} connected tool${me.plan?.connectors === 1 ? "" : "s"}, already in use.`}{" "}
            {me.user.role === "Org Owner" ? <a href="/usage">Upgrade on Usage &amp; billing</a> : "The Org Owner can upgrade on Usage & billing."}
          </div>
        )}
        {!c && configured && !blocked && (admin ? (
          // A plain GET form: the browser goes to the tool's sign-in and comes back to this page.
          <form className="actions" style={{ alignItems: "flex-end", flexWrap: "wrap" }} method="get" action="/api/connectors/start">
            <input type="hidden" name="kind" value={kind} />
            {t.site && (
              <label className="field" style={{ minWidth: 220 }}>
                <span>{t.site.label}</span>
                <input className="input" name="site" required={!t.site.optional} pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,49}" title={t.site.hint} placeholder={t.site.placeholder} aria-describedby={`hint-${kind}`} />
                <span className="muted" id={`hint-${kind}`} style={{ fontSize: 12 }}>{t.site.hint}</span>
              </label>
            )}
            <button className="btn primary" type="submit">Connect {t.name}</button>
            <span className="muted" style={{ fontSize: 12.5 }}>
              You sign in with {t.signIn}; {BRAND.name} only reads, and stores no password.
              {kind === "github" && " Only repositories your GitHub owner installed the Sidekick app on can be linked."}
              {kind === "m365" && ` The first time, Microsoft asks an admin of your organization to approve ${BRAND.name} reading SharePoint and OneDrive files.`}
            </span>
          </form>
        ) : <div className="muted">An Org Owner or Org Admin can connect {t.name}.</div>)}
        {c?.problem && <div className={`callout ${c.status === "expired" ? "bad" : "warn"}`} role="status">{c.problem}</div>}
        {c && <Links c={c} canLink={admin || lead} reload={reload} act={act} busy={busy} />}
      </div>
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
