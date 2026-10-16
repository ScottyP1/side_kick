"use client";

/**
 * Releases & switches (/owner/releases): the running version, models in use, kill switches and the operator log.
 */

import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, Modal, Pill, Switch, useReportError, useToast } from "@/components/ui";

type R = {
  build: { version: string; branch: string | null; commit: string | null; next: string; sdk: string; node: string; environment: string; startedAt: string };
  models: Record<string, string>;
  flags: { key: string; label: string; help: string; enabled: boolean }[];
  log: { id: number; actor: string; action: string; created_at: string }[];
};
const FEATURE: Record<string, string> = { ask: "Answering questions", extract: "Meeting notes", insights: "Knowledge map" };

export default function ReleasesPage() {
  const toast = useToast();
  const [r, setR] = useState<R | null>(null);
  const [pending, setPending] = useState<{ key: string; label: string; enabled: boolean } | null>(null);
  const load = useCallback(() => api<R>("/api/owner/releases").then(setR), []);
  const reportError = useReportError();
  useEffect(() => {
    load().catch(reportError);
  }, [load, reportError]);
  if (!r) return <span className="muted">Loading…</span>;

  const flip = async (key: string, enabled: boolean, label: string) => {
    try {
      await api("/api/owner/releases", { method: "POST", json: { key, enabled } });
      toast(enabled ? `${label} is on for all clients` : `${label} is paused for all clients`);
      setPending(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't change the switch.");
    }
  };
  const b = r.build;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Releases & switches</div>
          <h1>What&apos;s running, and the off switches</h1>
          <p>Pause any AI feature for every client at once if something goes wrong. Each change is logged below.</p>
        </div>
      </div>
      <div className="grid g2">
        <div className="panel">
          <div className="panel-h"><h2>Kill switches</h2><span className="muted">Apply to all clients</span></div>
          <div className="panel-b">
            {r.flags.map((f) => (
              <div key={f.key} className="row">
                <div className="grow">
                  <b>{f.label}</b> {!f.enabled && <Pill kind="bad">Paused</Pill>}
                  <div className="muted">{f.help}</div>
                </div>
                <Switch on={f.enabled} label={f.label} onChange={(v) => (v ? flip(f.key, true, f.label) : setPending({ key: f.key, label: f.label, enabled: false }))} />
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>Running build</h2><Pill kind="good">Up since {fmtTime(b.startedAt)}</Pill></div>
          <div className="panel-b">
            <dl className="kv">
              <dt>Sidekick version</dt><dd>{b.version}</dd>
              <dt>Branch</dt><dd className="mono">{b.branch ?? "—"}</dd>
              <dt>Commit</dt><dd className="mono">{b.commit ?? "not committed"}</dd>
              <dt>Environment</dt><dd>{b.environment}</dd>
              <dt>Next.js · Node</dt><dd>{b.next} · {b.node}</dd>
              <dt>Anthropic SDK</dt><dd>{b.sdk}</dd>
            </dl>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><h2>Models in production</h2><span className="muted">Set in app/.env.local</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Feature</th><th>Model</th><th>Setting</th></tr></thead>
            <tbody>
              {Object.entries(r.models).map(([k, m]) => (
                <tr key={k}><td>{FEATURE[k] ?? k}</td><td className="mono">{m}</td><td className="mono faint">SIDEKICK_MODEL_{k.toUpperCase()}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><h2>Operator log</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
            <tbody>
              {r.log.map((l) => (
                <tr key={l.id}><td className="ts" style={{ whiteSpace: "nowrap" }}>{fmtTime(l.created_at)}</td><td>{l.actor}</td><td>{l.action}</td></tr>
              ))}
              {!r.log.length && <tr><td colSpan={3} className="muted">Nothing yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {pending && (
        <Modal title={`Pause ${pending.label}?`} onClose={() => setPending(null)} footer={<><button className="btn" onClick={() => setPending(null)}>Cancel</button><button className="btn danger solid" onClick={() => flip(pending.key, false, pending.label)}>Pause for everyone</button></>}>
          <p style={{ margin: 0 }}>Every client will see “{pending.label} is paused by the Sidekick team” until you turn it back on. Nothing is deleted.</p>
        </Modal>
      )}
    </>
  );
}
