"use client";

/**
 * One client (/owner/clients/:id): who is in this organization (role, workspaces, Microsoft sign-in, last
 * active), its workspaces, its plan (the operator can set plan and subscription status, audited), and its
 * restrictions: feature switches that apply to this client only. Also its limits against use ("over limit"
 * / "near limit"), this month's AI credit with a one-off top-up, its plan terms (custom limits for
 * Enterprise or managed clients, AI credit override, contract price, partner/referrer, questions per person
 * per hour), and its AI use by feature and model (model names are only shown here, never in the portal).
 * Roll-off: groups ending and the organization's pending deletion, with **End client** (read-only now,
 * deleted after 30 days) and links to Owner Console → Roll-offs to extend or cancel.
 * Operators only; opening the page is recorded in the operator log once per visit (reloads after a switch
 * flip aren't). Shows no document or meeting content.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { api, fmtDate, fmtTime, Icon, Modal, Pill, Switch, useReportError, useToast } from "@/components/ui";
import { ALL_PLANS, LIMIT_KEYS, LIMIT_LABEL, limitsWithExtras, limitText, monthlyPrice, planById, planWithExtras, STATUS_LABEL, SUB_STATUSES, usd, type Access, type LimitKey, type PlanId, type PlanLimits, type SubStatus } from "@/lib/plans";
import { BRAND } from "@/lib/brand";
import { Limits } from "@/app/(app)/usage/plan";

type LimitLine = { key: LimitKey; label: string; used: number; limit: number | null; pct: number; over: boolean; full: boolean; near: boolean };
type Terms = { limits: Partial<PlanLimits>; aiCreditUsd: number | null; monthlyPriceUsd: number | null; partner: string | null; askPerHour: number | null; updatedBy: string | null; updatedAt: string | null };
type Credit = { month: string; creditUsd: number | null; topUpUsd: number; usedUsd: number; pct: number; level: string };

type Person = { id: string; name: string; email: string; role: string; microsoft: boolean; last_active: string | null; created_at: string; workspaces: string[] };
type Workspace = { id: string; name: string; code: string | null; documents: number; meetings: number; members: number };
type Flag = { key: string; label: string; help: string; enabled: boolean; platformEnabled: boolean };
type Detail = {
  org: { id: string; name: string; status: string; created_at: string; microsoft_connected: boolean; microsoft_required: boolean };
  people: Person[];
  workspaces: Workspace[];
  flags: Flag[];
  billing: {
    subscription: { plan: PlanId; status: SubStatus; provider: string; trial_ends_at: string | null; current_period_end: string | null; access_until: string | null; updated_by: string | null; updated_at: string; extra_groups: number } | null;
    access: Access;
    usage: { seats: number; workspaces: number; ending: number };
  };
  rolloffs: { id: string; scope: "group" | "org"; group: string | null; status: string; deleteOn: string; readOnlyFrom: string | null; requestedBy: string; reason: string | null; certificate: { id: string } | null }[];
  terms: Terms;
  credit: Credit;
  limits: LimitLine[];
  ai: { byModel: { feature: string; model: string; calls: number; cost: number; input: number; cached: number }[] };
};

export default function ClientPage() {
  return (
    <Suspense>
      <Client />
    </Suspense>
  );
}

function Client() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const reportError = useReportError();
  const [d, setD] = useState<Detail | null>(null);
  const [pending, setPending] = useState<Flag | null>(null);

  // `reload`: refreshing after a change during this visit, so the server doesn't log another "Viewed".
  const load = useCallback((reload = false) => api<Detail>(`/api/owner/tenants/${id}${reload ? "?reload=1" : ""}`).then(setD), [id]);
  useEffect(() => {
    load().catch(reportError);
  }, [load, reportError]);

  const flip = async (f: Flag, enabled: boolean) => {
    try {
      await api(`/api/owner/tenants/${id}/flags`, { method: "POST", json: { key: f.key, enabled } });
      toast(`${f.label} is ${enabled ? "on" : "off"} for ${d?.org.name}`);
      setPending(null);
      load(true).catch(reportError);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.");
    }
  };

  if (!d) return <div className="panel"><div className="panel-b muted">Loading…</div></div>;
  const admins = d.people.filter((p) => p.role === "Org Owner" || p.role === "Org Admin").length;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow"><Link href="/owner/clients">Clients</Link></div>
          <h1>{d.org.name}</h1>
          <p>
            <Pill kind={d.org.status === "Active" ? "good" : "bad"}>{d.org.status === "Active" ? "Active" : "Paused"}</Pill>{" "}
            {d.people.length} {d.people.length === 1 ? "person" : "people"} ({admins} admin{admins === 1 ? "" : "s"}) · {d.workspaces.length} group{d.workspaces.length === 1 ? "" : "s"} · since {fmtDate(d.org.created_at)} ·{" "}
            Microsoft sign-in {d.org.microsoft_connected ? (d.org.microsoft_required ? "connected and required" : "connected") : "not connected"}
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><h2>People</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>Groups</th><th>Sign-in</th><th>Last active</th></tr></thead>
            <tbody>
              {d.people.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.name}</b><div className="muted" style={{ fontSize: 12.5 }}>{p.email} · added {fmtDate(p.created_at)}</div></td>
                  <td>{p.role}</td>
                  <td className="muted">{p.workspaces.join(", ") || "None yet"}</td>
                  <td>{p.microsoft ? <Pill kind="good">Microsoft</Pill> : <span className="muted">Password</span>}</td>
                  <td className="muted">{fmtTime(p.last_active)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <PlanPanel d={d} onSaved={() => load(true).catch(reportError)} />
      <div className="grid g2">
        <div className="panel">
          <div className="panel-h"><h2>Limits this month</h2></div>
          <div className="panel-b"><Limits lines={d.limits} /></div>
        </div>
        <CreditPanel d={d} onSaved={() => load(true).catch(reportError)} />
      </div>
      <TermsPanel d={d} onSaved={() => load(true).catch(reportError)} />

      <div className="grid g2">
        <div className="panel">
          <div className="panel-h"><h2>Groups</h2></div>
          <div className="list">
            {!d.workspaces.length && <div className="li muted">No groups yet.</div>}
            {d.workspaces.map((w) => (
              <div key={w.id} className="li">
                <span><b>{w.name}</b>{w.code && <span className="muted"> · {w.code}</span>}</span>
                <span className="muted num">{w.members} member{w.members === 1 ? "" : "s"} · {w.documents} docs · {w.meetings} meetings</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><h2>Restrictions for this client</h2></div>
          <div className="panel-b">
            <p className="muted" style={{ marginTop: 0 }}>Turn a feature off for {d.org.name} only. A feature paused for everyone on Releases &amp; switches stays off here too.</p>
            {d.flags.map((f) => (
              <div key={f.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "8px 0" }}>
                <div>
                  <b>{f.label}</b>
                  <div className="muted" style={{ fontSize: 12.5 }}>{f.help}{!f.platformEnabled && <> · <Icon n="lock" /> paused for everyone</>}</div>
                </div>
                <Switch on={f.enabled} label={`${f.label} for ${d.org.name}`} onChange={(v) => (v ? flip(f, true) : setPending(f))} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {pending && (
        <Modal title={`Turn off ${pending.label} for ${d.org.name}?`} onClose={() => setPending(null)} footer={<><button className="btn" onClick={() => setPending(null)}>Cancel</button><button className="btn danger solid" onClick={() => flip(pending, false)}>Turn off</button></>}>
          <p style={{ margin: 0 }}>Their people will see a message that it&apos;s turned off for their organization. Nothing else changes, and you can turn it back on any time.</p>
        </Modal>
      )}
    </>
  );
}

/**
 * The client's plan and subscription, and the operator's controls to set plan and/or status (PATCH
 * /api/owner/tenants/:id/billing). Setting a status restarts its dates: Active = paid for 30 days from now,
 * Free trial = a new 14-day trial, Payment failed = the 7-day grace period starts now, Canceled = read-only now.
 */
function PlanPanel({ d, onSaved }: { d: Detail; onSaved: () => void }) {
  const toast = useToast();
  const sub = d.billing.subscription;
  const [plan, setPlan] = useState<PlanId>(sub?.plan ?? "team");
  const [status, setStatus] = useState<SubStatus>(sub?.status ?? "active");
  const [extras, setExtras] = useState(sub?.extra_groups ?? 0);
  const [ending, setEnding] = useState(false);
  const [err, setErr] = useState("");
  const changed = !sub || plan !== sub.plan || status !== sub.status || extras !== (sub.extra_groups ?? 0);
  const pendingOrg = d.rolloffs.find((r) => r.scope === "org" && (r.status === "scheduled" || r.status === "running"));
  const endClient = async () => {
    setErr("");
    try {
      await api(`/api/owner/tenants/${d.org.id}/rolloff`, { method: "POST", json: {} });
      toast(`${d.org.name} ended: read-only now, deleted in 30 days`);
      setEnding(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't end the client.");
      setEnding(false);
    }
  };
  const save = async () => {
    setErr("");
    try {
      await api(`/api/owner/tenants/${d.org.id}/billing`, { method: "PATCH", json: { plan, ...(sub && status === sub.status ? {} : { status }), ...(extras !== (sub?.extra_groups ?? 0) ? { extraGroups: extras } : {}) } });
      toast(`${d.org.name}: ${planById(plan)!.name} plan, ${STATUS_LABEL[status]}`);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save.");
    }
  };
  const p = sub ? planById(sub.plan)! : null;
  return (
    <div className="panel">
      <div className="panel-h">
        <h2>Plan</h2>
        {sub ? <Pill kind={d.billing.access.mode === "read_only" ? "bad" : sub.status === "active" ? "good" : "warn"}>{d.billing.access.mode === "read_only" ? "Read-only" : STATUS_LABEL[sub.status]}</Pill> : <Pill>Managed</Pill>}
      </div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          {sub && p
            ? <>{planWithExtras(p, sub.extra_groups ?? 0)} ({p.selfService ? `${usd(monthlyPrice(p, sub.extra_groups ?? 0))} a month` : "custom price"}) via {sub.provider === "mock" ? "test-mode checkout" : sub.provider === "manual" ? `the ${BRAND.name} team` : sub.provider} · {d.billing.usage.seats} of {limitText(limitsWithExtras(p, sub.extra_groups ?? 0).seats)} people · {d.billing.usage.workspaces} of {limitText(limitsWithExtras(p, sub.extra_groups ?? 0).workspaces)} groups{d.billing.usage.ending ? ` (+${d.billing.usage.ending} ending)` : ""} · last change by {sub.updated_by ?? "—"} {fmtTime(sub.updated_at)}</>
            : <>No self-service plan: this client was added by the {BRAND.name} team and has full use. Setting a plan here starts billing rules for them.</>}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select className="input" style={{ width: "auto" }} value={plan} onChange={(e) => setPlan(e.target.value as PlanId)} aria-label="Plan">
            {ALL_PLANS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <select className="input" style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value as SubStatus)} aria-label="Status">
            {SUB_STATUSES.map((x) => <option key={x} value={x}>{STATUS_LABEL[x]}</option>)}
          </select>
          <label className="muted" htmlFor="owner-extras">Extra groups</label>
          <input id="owner-extras" className="input num" type="number" min={0} max={50} style={{ width: 70 }} value={extras} onChange={(e) => setExtras(Math.max(0, Math.min(50, Math.floor(Number(e.target.value) || 0))))} />
          <button className="btn primary" disabled={!changed} onClick={save}>Save plan</button>
          <span className="spacer" style={{ flex: 1 }} />
          {!pendingOrg && <button className="btn small danger" onClick={() => setEnding(true)}>End client…</button>}
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>Recorded in the operator log and the client&apos;s audit log. Canceled turns the client read-only at once and deletes its data after 30 days (any other status stops that); Payment failed gives them 7 days.</span>
        {pendingOrg && <div className="callout bad"><span>All of this client&apos;s data will be deleted on {fmtDate(pendingOrg.deleteOn)} ({pendingOrg.reason ?? "ended"}; asked by {pendingOrg.requestedBy}). Extend or cancel it on <Link href="/owner/rolloffs">Roll-offs</Link>.</span></div>}
        {d.rolloffs.filter((r) => r.scope === "group" && r.status === "scheduled").map((r) => <div key={r.id} className="callout warn"><span>Group “{r.group}” is ending: deleted on {fmtDate(r.deleteOn)} (asked by {r.requestedBy}).</span></div>)}
        {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
      </div>
      {ending && (
        <Modal title={`End ${d.org.name}?`} onClose={() => setEnding(false)} footer={<><button className="btn" onClick={() => setEnding(false)}>Back</button><button className="btn danger solid" onClick={endClient}>End client</button></>}>
          <p style={{ margin: 0 }}>The organization turns read-only now: its people can still sign in, see everything and download it (Settings → Export your data). In 30 days every group, person, Teams link, setting and usage record is deleted, and a deletion certificate is kept on Roll-offs. You can extend or cancel it until then; paying again also cancels it.</p>
        </Modal>
      )}
    </div>
  );
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * This month's AI credit (used of included, top-ups) and a one-off top-up for this month (POST
 * /api/owner/tenants/:id/credit, audited on both sides), plus the client's AI use by feature and model.
 */
function CreditPanel({ d, onSaved }: { d: Detail; onSaved: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const c = d.credit;
  const topUp = async () => {
    setErr("");
    try {
      await api(`/api/owner/tenants/${d.org.id}/credit`, { method: "POST", json: { amountUsd: Number(amount), note } });
      toast(`Added $${Number(amount).toFixed(2)} of AI credit for ${d.org.name}`);
      setAmount("");
      setNote("");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't add the top-up.");
    }
  };
  return (
    <div className="panel">
      <div className="panel-h">
        <h2>AI credit ({c.month})</h2>
        <Pill kind={c.level === "essentials" ? "bad" : c.level === "warn" ? "warn" : "good"}>{c.level === "unlimited" ? "No limit" : c.level === "essentials" ? "Used up: essentials only" : `${Math.round(c.pct)}% used`}</Pill>
      </div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span><b className="num">{money(c.usedUsd)}</b>{c.creditUsd !== null && <span className="muted"> of {money(c.creditUsd)}{c.topUpUsd ? ` (incl. ${money(c.topUpUsd)} top-ups)` : ""}</span>}</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="input" style={{ width: 120 }} inputMode="decimal" placeholder="Amount $" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Top-up amount in dollars" />
          <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Top-up note" />
          <button className="btn primary" disabled={!(Number(amount) > 0)} onClick={topUp}>Add top-up</button>
        </div>
        {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Feature</th><th>Model</th><th className="r">Requests</th><th className="r" title="Share of input read from the prompt cache">Cached</th><th className="r">Cost</th></tr></thead>
            <tbody>
              {d.ai.byModel.map((m) => <tr key={`${m.feature}-${m.model}`}><td>{m.feature}</td><td className="mono">{m.model}</td><td className="r num">{m.calls}</td><td className="r num">{m.input ? `${Math.round((m.cached / m.input) * 100)}%` : "—"}</td><td className="r num">{money(Number(m.cost))}</td></tr>)}
              {!d.ai.byModel.length && <tr><td colSpan={5} className="muted">No AI use this month.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * The client's plan terms (PATCH /api/owner/tenants/:id/terms): custom limits (empty = the plan's number,
 * "unlimited" = no limit), AI credit override, contract price per month, partner/referrer, and questions
 * per person per hour. Saves only what changed; audited in the operator log and the client's audit log.
 */
function TermsPanel({ d, onSaved }: { d: Detail; onSaved: () => void }) {
  const toast = useToast();
  const t = d.terms;
  const keys = LIMIT_KEYS.filter((k) => k !== "aiCreditUsd");
  const show = (v: number | null | undefined) => (v === undefined ? "" : v === null ? "unlimited" : String(v));
  const [lim, setLim] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [k, show(t.limits[k])])));
  const [credit, setCredit] = useState(t.aiCreditUsd === null ? "" : String(t.aiCreditUsd));
  const [price, setPrice] = useState(t.monthlyPriceUsd === null ? "" : String(t.monthlyPriceUsd));
  const [partner, setPartner] = useState(t.partner ?? "");
  const [ask, setAsk] = useState(t.askPerHour === null ? "" : String(t.askPerHour));
  const [err, setErr] = useState("");
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const save = async () => {
    setErr("");
    const limits: Record<string, number | null> = {};
    for (const k of keys) {
      const v = lim[k].trim().toLowerCase();
      if (v === "") continue;
      limits[k] = v === "unlimited" ? null : Number(v);
    }
    const body: Record<string, unknown> = {
      limits: Object.keys(limits).length ? limits : null,
      aiCreditUsd: num(credit), monthlyPriceUsd: num(price), partner: partner.trim() || null, askPerHour: num(ask),
    };
    // NaN would travel as null (= no limit), so typos are caught here.
    if ([...Object.values(limits), body.aiCreditUsd, body.monthlyPriceUsd, body.askPerHour].some((v) => typeof v === "number" && Number.isNaN(v))) {
      setErr("Use numbers only (or \"unlimited\" for a limit, or leave it empty).");
      return;
    }
    try {
      await api(`/api/owner/tenants/${d.org.id}/terms`, { method: "PATCH", json: body });
      toast(`Saved plan terms for ${d.org.name}`);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save.");
    }
  };
  return (
    <div className="panel">
      <div className="panel-h"><h2>Plan terms</h2>{t.updatedBy && <span className="muted">Last change by {t.updatedBy} {fmtTime(t.updatedAt)}</span>}</div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>Leave a limit empty to use the plan&apos;s number; type &quot;unlimited&quot; for no limit. Lowering a limit never deletes anything: the client just can&apos;t add more.</p>
        <div className="grid g3">
          {keys.map((k) => (
            <label key={k} className="field">
              <span>{LIMIT_LABEL[k].many[0].toUpperCase() + LIMIT_LABEL[k].many.slice(1)}</span>
              <input className="input" value={lim[k]} placeholder="Plan's number" onChange={(e) => setLim((cur) => ({ ...cur, [k]: e.target.value }))} />
            </label>
          ))}
          <label className="field"><span>AI credit per month ($)</span><input className="input" inputMode="decimal" value={credit} placeholder="Plan's credit" onChange={(e) => setCredit(e.target.value)} /></label>
          <label className="field"><span>Contract price per month ($)</span><input className="input" inputMode="decimal" value={price} placeholder="Enterprise / managed only" onChange={(e) => setPrice(e.target.value)} /></label>
          <label className="field"><span>Partner or referrer</span><input className="input" value={partner} maxLength={120} placeholder="Who brought this client" onChange={(e) => setPartner(e.target.value)} /></label>
          <label className="field"><span>Questions per person per hour</span><input className="input" inputMode="numeric" value={ask} placeholder="Default (60)" onChange={(e) => setAsk(e.target.value)} /></label>
        </div>
        <div><button className="btn primary" onClick={save}>Save plan terms</button></div>
        {err && <p className="err" style={{ margin: 0 }}>{err}</p>}
      </div>
    </div>
  );
}
