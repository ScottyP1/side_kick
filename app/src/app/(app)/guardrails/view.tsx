"use client";

/**
 * Guardrails (/guardrails): the rules Sidekick follows in every answer, in the portal and in Teams.
 * - Everyone sees the locked floor, which org-wide switches are on, the custom rules, and (for workspaces
 *   they can see) what's in force in each workspace.
 * - Only the Org Owner can flip an organization switch. Org Owners and Org Admins can make one workspace
 *   stricter (extra switches, never fewer), write custom rules (org-wide or per workspace; rules that
 *   would loosen the guardrails are refused with the reason), see each rule's history, and use the
 *   "Test it" box, which checks a question (and an optional draft rule) without saving anything.
 * - Org Owners and Admins also see how often each rule fired in the last 30 days (counts only, never the
 *   questions or answers).
 * Every change is audited. See lib/guardrails.ts and /api/guardrails.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, Modal, Pill, Spinner, Switch, fmtTime, useReportError, useToast } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { featureNote } from "@/lib/plans";
import { useApp } from "@/components/shell";

type Rule = { id: string; workspaceId: string | null; text: string; version: number; updatedBy: string | null; updatedAt: string };
type Rules = {
  floor: { id: string; label: string; help: string }[];
  switches: { key: string; label: string; help: string; on: boolean }[];
  canEdit: boolean;
  canManage: boolean;
  updated: { by: string; at: string } | null;
  rules: Rule[];
  limits: { rules: number; length: number };
  workspaces: { id: string; name: string }[];
  workspace: {
    id: string;
    name: string;
    switches: { key: string; label: string; org: boolean; extra: boolean; on: boolean }[];
    rules: Rule[];
    updated: { by: string; at: string } | null;
  } | null;
  summary: { total: number; blocked: number; rules: { rule: string; label: string; blocked: number; masked: number; replaced: number; teams: number; total: number }[] } | null;
};
type TestResult = { allowed: boolean; rule: string | null; label: string | null; checker: "local" | "claude"; message: string | null; draft: boolean; locked?: boolean };
type Version = { version: number; text: string; change: string; by: string | null; at: string };

export default function GuardrailsPage() {
  const toast = useToast();
  const reportError = useReportError();
  const [r, setR] = useState<Rules | null>(null);
  const [ws, setWs] = useState<string | null>(null); // null = not chosen yet (defaults to the first workspace)
  const [saving, setSaving] = useState("");
  const load = useCallback(
    () =>
      api<Rules>(`/api/guardrails${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`)
        .then((d) => {
          setR(d);
          if (ws === null && d.workspaces.length) setWs(d.workspaces[0].id);
        })
        .catch(reportError),
    [ws, reportError],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (!r) return <span className="muted"><Spinner /> Loading guardrails…</span>;

  const flip = async (key: string, on: boolean) => {
    setSaving(key);
    try {
      await api("/api/guardrails", { method: "PUT", json: { [key]: on } });
      toast(on ? "Switched on for the whole organization" : "Switched off for the whole organization");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't change it.", "error");
    } finally {
      setSaving("");
    }
  };

  const flipWorkspace = async (key: string, on: boolean) => {
    if (!r.workspace) return;
    setSaving(`ws:${key}`);
    try {
      await api("/api/guardrails/workspace", { method: "PUT", json: { ws: r.workspace.id, [key]: on } });
      toast(on ? `Switched on for ${r.workspace.name}` : `Switched off for ${r.workspace.name}`);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't change it.", "error");
    } finally {
      setSaving("");
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Guardrails</div>
          <h1>Rules {BRAND.name} always follows</h1>
          <p>These apply to every workspace, in the portal and in Teams. Questions are checked before {BRAND.name} answers, and answers are checked again before anyone sees them. A workspace can be made stricter than the rest, never looser.</p>
        </div>
      </div>

      <div className="grid g2">
        <div className="panel">
          <div className="panel-h"><h2>Always on</h2><Pill kind="good">Locked</Pill></div>
          <div className="list">
            {r.floor.map((f) => (
              <div key={f.id} className="li">
                <div className="grow">
                  <b>{f.label}</b>
                  <div className="muted" style={{ fontSize: 13 }}>{f.help}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-h">
            <h2>Organization switches</h2>
            <span className="muted">{r.canEdit ? "Only the Org Owner can change these" : "Set by your Org Owner"}</span>
          </div>
          <div className="list">
            {r.switches.map((s) => (
              <div key={s.key} className="li" style={{ alignItems: "flex-start" }}>
                <div className="grow">
                  <b>{s.label}</b>
                  <div className="muted" style={{ fontSize: 13 }}>{s.help}</div>
                </div>
                {r.canEdit ? (
                  saving === s.key ? <Spinner /> : <Switch on={s.on} onChange={(v) => flip(s.key, v)} label={s.label} />
                ) : (
                  <Pill kind={s.on ? "info" : ""}>{s.on ? "On" : "Off"}</Pill>
                )}
              </div>
            ))}
          </div>
          {r.updated && <div className="panel-b muted" style={{ fontSize: 12.5 }}>Last changed by {r.updated.by}, {fmtTime(r.updated.at)}</div>}
        </div>
      </div>

      <RulesPanel
        title="Custom rules for the whole organization"
        hint="Short rules in your own words, on top of the ones above. They can only add restrictions."
        rules={r.rules}
        scope={null}
        canManage={r.canManage}
        limits={r.limits}
        onChange={load}
      />

      {r.workspaces.length > 0 && (
        <div className="panel">
          <div className="panel-h">
            <h2>Workspace rules</h2>
            <select className="input" style={{ width: "auto" }} value={ws ?? ""} onChange={(e) => setWs(e.target.value)} aria-label="Workspace">
              {r.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          {r.workspace ? (
            <>
              <div className="panel-b muted" style={{ fontSize: 13, paddingBottom: 0 }}>
                What&apos;s in force in {r.workspace.name}. A switch that&apos;s on for the whole organization stays on here; {r.canManage ? "you can turn more on for this workspace only." : "Org Owners and Admins can turn more on for this workspace only."}
              </div>
              <div className="list">
                {r.workspace.switches.map((s) => (
                  <div key={s.key} className="li" style={{ alignItems: "center" }}>
                    <div className="grow"><b>{s.label}</b></div>
                    {s.org ? (
                      <Pill kind="info">On for the organization</Pill>
                    ) : r.canManage ? (
                      saving === `ws:${s.key}` ? <Spinner /> : <Switch on={s.extra} onChange={(v) => flipWorkspace(s.key, v)} label={`${s.label} in ${r.workspace!.name}`} />
                    ) : (
                      <Pill kind={s.on ? "info" : ""}>{s.on ? "On for this workspace" : "Off"}</Pill>
                    )}
                  </div>
                ))}
              </div>
              {r.workspace.updated && <div className="panel-b muted" style={{ fontSize: 12.5 }}>Workspace switches last changed by {r.workspace.updated.by}, {fmtTime(r.workspace.updated.at)}</div>}
            </>
          ) : (
            <div className="panel-b muted"><Spinner /> Loading…</div>
          )}
        </div>
      )}

      {r.workspace && (
        <RulesPanel
          title={`Custom rules for ${r.workspace.name} only`}
          hint="Apply in this workspace on top of the organization's rules."
          rules={r.workspace.rules}
          scope={r.workspace.id}
          canManage={r.canManage}
          limits={r.limits}
          onChange={load}
        />
      )}

      {r.canManage && <TestBox workspace={r.workspace} limit={r.limits.length} />}

      {r.summary && (
        <div className="panel">
          <div className="panel-h"><h2>Last 30 days</h2><span className="muted">How often each rule fired. Counts only: the questions and answers themselves are never stored here.</span></div>
          {r.summary.rules.length ? (
            <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Rule</th><th className="r">Questions refused</th><th className="r">Answers cleaned</th><th className="r">From Teams</th></tr></thead>
              <tbody>
                {r.summary.rules.map((x) => (
                  <tr key={x.rule}>
                    <td>{x.label}</td>
                    <td className="r num">{x.blocked}</td>
                    <td className="r num">{x.masked + x.replaced}</td>
                    <td className="r num">{x.teams}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : (
            <div className="panel-b muted">Nothing has been refused or cleaned up yet.</div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * One list of custom rules (org-wide when `scope` is null, else one workspace's), with add, edit, remove
 * and history for Org Owners/Admins. A refused rule shows the server's reason under the box. Custom rules
 * are a plan feature (Team and up): on Starter, rules already there keep working and can be edited or
 * removed, but the add box is replaced by a "Not in your plan" note.
 */
function RulesPanel({ title, hint, rules, scope, canManage, limits, onChange }: {
  title: string;
  hint: string;
  rules: Rule[];
  scope: string | null;
  canManage: boolean;
  limits: { rules: number; length: number };
  onChange: () => Promise<void> | void;
}) {
  const { me } = useApp();
  const notInPlan = featureNote(me.plan, "customRules");
  const toast = useToast();
  const reportError = useReportError();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string; err: string } | null>(null);
  const [history, setHistory] = useState<{ rule: Rule; versions: Version[] } | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("add");
    setErr("");
    try {
      await api("/api/guardrails/rules", { method: "POST", json: { text, ws: scope } });
      setText("");
      toast("Rule added. It applies from the next question.");
      await onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't add the rule.");
    } finally {
      setBusy("");
    }
  };
  const save = async () => {
    if (!editing) return;
    setBusy(editing.id);
    try {
      await api("/api/guardrails/rules", { method: "PUT", json: { id: editing.id, text: editing.text } });
      setEditing(null);
      toast("Rule updated. The old wording is kept in its history.");
      await onChange();
    } catch (e) {
      setEditing({ ...editing, err: e instanceof Error ? e.message : "Couldn't save the rule." });
    } finally {
      setBusy("");
    }
  };
  const remove = async (rule: Rule) => {
    if (!window.confirm(`Remove the rule “${rule.text}”? Its history is kept.`)) return;
    setBusy(rule.id);
    try {
      await api(`/api/guardrails/rules?id=${encodeURIComponent(rule.id)}`, { method: "DELETE" });
      toast("Rule removed.");
      await onChange();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't remove the rule.", "error");
    } finally {
      setBusy("");
    }
  };
  const showHistory = (rule: Rule) =>
    api<{ versions: Version[] }>(`/api/guardrails/rules?id=${encodeURIComponent(rule.id)}`)
      .then((d) => setHistory({ rule, versions: d.versions }))
      .catch(reportError);

  return (
    <div className="panel">
      <div className="panel-h">
        <h2>{title}</h2>
        <span className="muted">{rules.length} of {limits.rules}</span>
      </div>
      <div className="panel-b muted" style={{ fontSize: 13, paddingBottom: 0 }}>{hint}</div>
      <div className="list">
        {rules.map((rule) => (
          <div key={rule.id} className="li" style={{ alignItems: "center" }}>
            {editing?.id === rule.id ? (
              <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <input className="input" value={editing.text} maxLength={limits.length} onChange={(e) => setEditing({ ...editing, text: e.target.value, err: "" })} aria-label="Rule" />
                  <button className="btn primary small" onClick={save} disabled={busy === rule.id || !editing.text.trim()}>{busy === rule.id ? <Spinner /> : "Save"}</button>
                  <button className="btn small ghost" onClick={() => setEditing(null)}>Cancel</button>
                </div>
                {editing.err && <p className="err" style={{ margin: 0 }}>{editing.err}</p>}
              </div>
            ) : (
              <>
                <div className="grow">
                  <b>{rule.text}</b>
                  <div className="muted" style={{ fontSize: 12.5 }}>Version {rule.version} · {rule.updatedBy ?? "Unknown"}, {fmtTime(rule.updatedAt)}</div>
                </div>
                {canManage && (
                  busy === rule.id ? <Spinner /> : (
                    <span style={{ display: "flex", gap: 4 }}>
                      <button className="btn small ghost" onClick={() => showHistory(rule)}>History</button>
                      <button className="btn small ghost" onClick={() => setEditing({ id: rule.id, text: rule.text, err: "" })}>Edit</button>
                      <button className="btn small ghost" onClick={() => remove(rule)}>Remove</button>
                    </span>
                  )
                )}
              </>
            )}
          </div>
        ))}
        {!rules.length && <div className="li muted">No custom rules yet.</div>}
      </div>
      {canManage && notInPlan && <div className="panel-b muted" style={{ fontSize: 13 }}>{notInPlan}</div>}
      {canManage && !notInPlan && rules.length < limits.rules && (
        <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <form style={{ display: "flex", gap: 8 }} onSubmit={add}>
            <input className="input" placeholder="e.g. Never quote day rates" value={text} maxLength={limits.length} onChange={(e) => { setText(e.target.value); setErr(""); }} aria-label="New rule" />
            <button className="btn primary" type="submit" disabled={busy === "add" || !text.trim()}>{busy === "add" ? <><Spinner /> Checking</> : "Add rule"}</button>
          </form>
          {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
        </div>
      )}
      {history && (
        <Modal title="Rule history" onClose={() => setHistory(null)}>
          <div className="list">
            {history.versions.map((v) => (
              <div key={v.version} className="li">
                <div className="grow">
                  <b>{v.text}</b>
                  <div className="muted" style={{ fontSize: 12.5 }}>Version {v.version} · {v.change} by {v.by ?? "Unknown"}, {fmtTime(v.at)}</div>
                </div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * The "Test it" box: checks a question against the guardrails in force (for the chosen workspace, or the
 * whole organization), optionally with a draft rule that isn't saved. Nothing is recorded.
 */
function TestBox({ workspace, limit }: { workspace: Rules["workspace"]; limit: number }) {
  const [question, setQuestion] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    setResult(null);
    try {
      setResult(await api<TestResult>("/api/guardrails/test", { method: "POST", json: { question, ws: workspace?.id ?? null, draft: draft || undefined } }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't run the test.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-h">
        <h2>Test it</h2>
        <span className="muted">Nothing is saved or counted</span>
      </div>
      <form className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }} onSubmit={run}>
        <div className="muted" style={{ fontSize: 13 }}>
          Type a question to see whether {BRAND.name} would refuse it{workspace ? ` in ${workspace.name}` : ""}, and why. Add a draft rule to try it before saving.
        </div>
        <div className="field">
          <label htmlFor="test-q">Question</label>
          <input id="test-q" className="input" placeholder="e.g. What's our day rate for senior consultants?" value={question} maxLength={1000} onChange={(e) => setQuestion(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="test-draft">Draft rule (optional)</label>
          <input id="test-draft" className="input" placeholder="e.g. Never quote day rates" value={draft} maxLength={limit} onChange={(e) => setDraft(e.target.value)} />
        </div>
        <div><button className="btn primary" type="submit" disabled={busy || !question.trim()}>{busy ? <><Spinner /> Checking</> : "Test"}</button></div>
        {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
        {result && (
          <div className="answer" role="status">
            {result.allowed ? (
              <Pill kind="good">Would be answered</Pill>
            ) : (
              <>
                <Pill kind="warn">Would be refused</Pill>
                <p style={{ margin: "8px 0 4px" }}>
                  <b>{result.label}</b>
                  {result.draft ? " (your draft)" : result.locked ? " (locked)" : ""} · caught by the {result.checker === "local" ? "quick check" : "AI check"}
                </p>
                <p className="muted" style={{ margin: 0 }}>They&apos;d see: “{result.message}”</p>
              </>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
