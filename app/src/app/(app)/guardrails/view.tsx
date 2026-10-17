"use client";

/**
 * Guardrails (/guardrails): the rules Sidekick follows in every answer, in the portal and in Teams.
 * Everyone sees the locked floor and which org-wide switches are on; only the Org Owner can flip a switch
 * (each change is audited). Org Owners and Admins also see how often each rule fired in the last 30 days
 * (counts only, never the questions or answers). See lib/guardrails.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { api, Pill, Spinner, Switch, fmtTime, useReportError, useToast } from "@/components/ui";

type Rules = {
  floor: { id: string; label: string; help: string }[];
  switches: { key: string; label: string; help: string; on: boolean }[];
  canEdit: boolean;
  updated: { by: string; at: string } | null;
  summary: { total: number; blocked: number; rules: { rule: string; label: string; blocked: number; masked: number; replaced: number; teams: number; total: number }[] } | null;
};

export default function GuardrailsPage() {
  const toast = useToast();
  const reportError = useReportError();
  const [r, setR] = useState<Rules | null>(null);
  const [saving, setSaving] = useState("");
  const load = useCallback(() => api<Rules>("/api/guardrails").then(setR).catch(reportError), [reportError]);
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
      toast(e instanceof Error ? e.message : "Couldn't change it.");
    } finally {
      setSaving("");
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Guardrails</div>
          <h1>Rules Sidekick always follows</h1>
          <p>These apply to every workspace, in the portal and in Teams. Questions are checked before Sidekick answers, and answers are checked again before anyone sees them.</p>
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

      {r.summary && (
        <div className="panel">
          <div className="panel-h"><h2>Last 30 days</h2><span className="muted">How often each rule fired. Counts only: the questions and answers themselves are never stored here.</span></div>
          {r.summary.rules.length ? (
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
          ) : (
            <div className="panel-b muted">Nothing has been refused or cleaned up yet.</div>
          )}
        </div>
      )}
    </>
  );
}
