"use client";

/**
 * The Plan section at the top of Usage & billing (/usage): the organization's plan and subscription status,
 * people and workspaces used against the plan's limits, and (Org Owners and Billing Admins) pay, change plan,
 * cancel, and the test-mode "simulate a failed payment". Org Admins see it read-only. Organizations managed
 * by the Sidekick team (no self-service subscription) see a short note instead. Data: GET/POST /api/billing.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, Modal, Pill, useReportError, useToast } from "@/components/ui";
import { TestModeBanner } from "@/components/public-shell";
import { limitText, planById, STATUS_LABEL, type Access, type Plan, type PlanId, type SubStatus } from "@/lib/plans";

type Billing = {
  subscription: { plan: PlanId; status: SubStatus; trial_ends_at: string | null; current_period_end: string | null; past_due_since: string | null; access_until: string | null } | null;
  access: Access;
  usage: { seats: number; workspaces: number };
  plans: Plan[];
  canManage: boolean;
  testMode: boolean;
};

const STATUS_KIND: Record<SubStatus, string> = { trialing: "info", active: "good", past_due: "warn", canceled: "bad" };

/** The Plan panel. Reloads itself after every change; problems show in place. */
export function PlanSection() {
  const toast = useToast();
  const reportError = useReportError();
  const [b, setB] = useState<Billing | null>(null);
  const [pick, setPick] = useState<PlanId | "">("");
  const [confirm, setConfirm] = useState<"change" | "cancel" | "fail" | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => api<Billing>("/api/billing").then(setB), []);
  useEffect(() => {
    load().catch(reportError);
  }, [load, reportError]);

  const act = async (action: "change" | "cancel" | "fail", done: string) => {
    setErr("");
    try {
      await api("/api/billing", { method: "POST", json: { action, plan: pick || undefined } });
      toast(done);
      setConfirm(null);
      setPick("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn't work.");
      setConfirm(null);
    }
  };

  if (!b) return null;
  const sub = b.subscription;
  if (!sub) {
    return (
      <div className="panel">
        <div className="panel-h"><h2>Plan</h2></div>
        <div className="panel-b muted">Your organization&apos;s plan is managed by the Sidekick team. Contact them to change it.</div>
      </div>
    );
  }
  const plan = planById(sub.plan)!;
  const seatPct = plan.seats ? Math.min(100, (b.usage.seats / plan.seats) * 100) : 0;
  const when =
    sub.status === "trialing" ? `Free trial until ${fmtDate(sub.trial_ends_at)}`
    : sub.status === "active" ? `Paid until ${fmtDate(sub.current_period_end)}`
    : sub.status === "past_due" ? `Payment failed on ${fmtDate(sub.past_due_since)}`
    : `Canceled; usable until ${fmtDate(sub.access_until)}`;
  const next = pick ? planById(pick) : undefined;

  return (
    <div className="panel">
      <div className="panel-h">
        <h2>Plan</h2>
        <Pill kind={b.access.mode === "read_only" ? "bad" : STATUS_KIND[sub.status]}>{b.access.mode === "read_only" ? "Read-only" : STATUS_LABEL[sub.status]}</Pill>
      </div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {b.testMode && <TestModeBanner />}
        {b.access.notice && <div className={`callout ${b.access.mode === "read_only" ? "bad" : "warn"}`}><span>{b.access.notice}</span></div>}
        <div className="grid g3">
          <div>
            <div className="eyebrow">Current plan</div>
            <b style={{ fontSize: 18 }}>{plan.name}</b>
            <div className="muted">${plan.pricePerSeat} per person / month · {when}</div>
          </div>
          <div>
            <div className="eyebrow">People</div>
            <b className="num">{b.usage.seats} of {limitText(plan.seats)}</b>
            {plan.seats !== null && <div className="meter" style={{ marginTop: 6 }}><span style={{ width: `${seatPct}%`, background: seatPct >= 100 ? "var(--warn)" : undefined }} /></div>}
          </div>
          <div>
            <div className="eyebrow">Workspaces</div>
            <b className="num">{b.usage.workspaces} of {limitText(plan.workspaces)}</b>
            <div className="muted">About ${(plan.pricePerSeat * Math.max(1, b.usage.seats)).toFixed(2)} every 30 days</div>
          </div>
        </div>
        {err && <p className="err" role="alert" style={{ margin: 0 }}>{err}</p>}
        {b.canManage ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {sub.status !== "active" && <Link className="btn primary" href={`/checkout?plan=${sub.plan}`}>Pay now</Link>}
            <select className="input" style={{ width: "auto" }} value={pick} onChange={(e) => setPick(e.target.value as PlanId)} aria-label="Change plan to">
              <option value="">Change plan…</option>
              {b.plans.filter((p) => p.id !== sub.plan).map((p) => <option key={p.id} value={p.id}>{p.name}: ${p.pricePerSeat} per person</option>)}
            </select>
            <button className="btn" disabled={!pick} onClick={() => setConfirm("change")}>Change</button>
            <span className="spacer" style={{ flex: 1 }} />
            {b.testMode && sub.status !== "canceled" && <button className="btn small ghost" onClick={() => setConfirm("fail")}>Simulate a failed payment</button>}
            {sub.status !== "canceled" && <button className="btn small danger" onClick={() => setConfirm("cancel")}>Cancel plan</button>}
          </div>
        ) : (
          <span className="muted">Only the Org Owner and Billing Admins can pay, change the plan or cancel.</span>
        )}
      </div>
      {confirm === "change" && next && (
        <Modal title={`Switch to ${next.name}?`} onClose={() => setConfirm(null)} footer={<><button className="btn" onClick={() => setConfirm(null)}>Back</button><button className="btn primary" onClick={() => act("change", `You're on the ${next.name} plan now`)}>Switch plan</button></>}>
          <p style={{ margin: 0 }}>{next.name} is ${next.pricePerSeat} per person / month, for up to {limitText(next.seats)} people and {limitText(next.workspaces)} workspaces. It applies straight away; the paid-until date stays the same.</p>
        </Modal>
      )}
      {confirm === "cancel" && (
        <Modal title="Cancel your plan?" onClose={() => setConfirm(null)} footer={<><button className="btn" onClick={() => setConfirm(null)}>Keep plan</button><button className="btn danger solid" onClick={() => act("cancel", "Plan canceled")}>Cancel plan</button></>}>
          <p style={{ margin: 0 }}>Sidekick stays fully usable until the end of what you paid for (or the trial). Then it turns read-only: everyone can still see everything, but nothing new is added and Sidekick stops answering. Nothing is deleted, and paying again turns it all back on.</p>
        </Modal>
      )}
      {confirm === "fail" && (
        <Modal title="Simulate a failed payment?" onClose={() => setConfirm(null)} footer={<><button className="btn" onClick={() => setConfirm(null)}>Back</button><button className="btn primary" onClick={() => act("fail", "Simulated a failed payment")}>Simulate it</button></>}>
          <p style={{ margin: 0 }}>Test mode only: marks the last payment as failed so you can see what your team sees. Sidekick keeps working for a 7-day grace period, then turns read-only. <b>Pay now</b> fixes it.</p>
        </Modal>
      )}
    </div>
  );
}
