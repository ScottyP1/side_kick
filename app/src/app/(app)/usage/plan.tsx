"use client";

/**
 * The Plan section at the top of Usage & billing (/usage): the organization's plan (priced per organization
 * by groups, lib/plans.ts), its extra groups and monthly price, subscription status, every plan limit with
 * its use (people, groups, tracked chats, meeting hours, documents, connectors, AI credit; "Over limit" when
 * a plan shrank below what's used, nothing is ever deleted), and (Org Owners and Billing Admins) pay, change
 * plan, add or remove extra groups, cancel, and the test-mode "simulate a failed payment". Org Admins see it
 * read-only. Organizations managed by the Sidekick team (no self-service subscription) and Enterprise see
 * their limits and a note to contact the team.
 *
 * Arriving from the group-limit message (`/usage?groups=N`, from New group) shows the two ways to make room
 * for N groups, cheaper first: extra groups on this plan, or the next plan up (`groupOptions`).
 * Data: GET/POST /api/billing.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, Modal, Pill, useReportError, useToast } from "@/components/ui";
import { TestModeBanner } from "@/components/public-shell";
import { groupOptions, limitsWithExtras, limitText, monthlyPrice, planById, planWithExtras, STATUS_LABEL, usd, type Access, type GroupOption, type LimitKey, type Plan, type PlanId, type SubStatus } from "@/lib/plans";
import { BRAND } from "@/lib/brand";

type LimitLine = { key: LimitKey; label: string; used: number; limit: number | null; pct: number; over: boolean; full: boolean; near: boolean };

type Billing = {
  subscription: { plan: PlanId; status: SubStatus; trial_ends_at: string | null; current_period_end: string | null; past_due_since: string | null; access_until: string | null; extra_groups: number } | null;
  access: Access;
  usage: { seats: number; workspaces: number; ending: number };
  priceUsd: number | null;
  extraGroup: { priceUsd: number; adds: Record<string, number> };
  maxExtraGroups: number;
  limits: LimitLine[];
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
  const [confirm, setConfirm] = useState<"change" | "cancel" | "fail" | "extras" | null>(null);
  const [extras, setExtras] = useState<number | null>(null);
  const [option, setOption] = useState<GroupOption | null>(null);
  const [need, setNeed] = useState(0);
  const [err, setErr] = useState("");

  const load = useCallback(() => api<Billing>("/api/billing").then(setB), []);
  useEffect(() => {
    load().catch(reportError);
    const n = Number(new URLSearchParams(location.search).get("groups"));
    if (Number.isInteger(n) && n > 0 && n < 1000) setNeed(n);
  }, [load, reportError]);

  const act = async (action: "change" | "cancel" | "fail" | "extras", done: string, body: Record<string, unknown> = {}) => {
    setErr("");
    try {
      await api("/api/billing", { method: "POST", json: { action, plan: pick || undefined, ...body } });
      toast(done);
      setConfirm(null);
      setPick("");
      setExtras(null);
      setOption(null);
      setNeed(0);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn't work.");
      setConfirm(null);
    }
  };

  if (!b) return null;
  const sub = b.subscription;
  const plan = sub ? planById(sub.plan)! : null;
  if (!sub || !plan?.selfService) {
    return (
      <div className="panel">
        <div className="panel-h"><h2>Plan</h2>{plan && <Pill kind="info">{plan.name}</Pill>}</div>
        <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <span className="muted">Your organization&apos;s plan is managed by the {BRAND.name} team. Contact them to change it or raise a limit.</span>
          {b.access.notice && <div className={`callout ${b.access.mode === "read_only" ? "bad" : "warn"}`}><span>{b.access.notice}</span></div>}
          <Limits lines={b.limits} />
        </div>
      </div>
    );
  }
  const extraNow = sub.extra_groups ?? 0;
  const lim = limitsWithExtras(plan, extraNow);
  const seatPct = lim.seats ? Math.min(100, (b.usage.seats / lim.seats) * 100) : 0;
  const when =
    sub.status === "trialing" ? `Free trial until ${fmtDate(sub.trial_ends_at)}`
    : sub.status === "active" ? `Paid until ${fmtDate(sub.current_period_end)}`
    : sub.status === "past_due" ? `Payment failed on ${fmtDate(sub.past_due_since)}`
    : `Canceled; usable until ${fmtDate(sub.access_until)}`;
  const next = pick ? planById(pick) : undefined;
  const offer = need > (lim.workspaces ?? Infinity) ? groupOptions(plan, extraNow, need) : null;
  const wantExtras = extras ?? extraNow;
  const choose = (o: GroupOption) => setOption(o);

  return (
    <div className="panel">
      <div className="panel-h">
        <h2>Plan</h2>
        <Pill kind={b.access.mode === "read_only" ? "bad" : STATUS_KIND[sub.status]}>{b.access.mode === "read_only" ? "Read-only" : STATUS_LABEL[sub.status]}</Pill>
      </div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {b.testMode && <TestModeBanner />}
        {b.access.notice && <div className={`callout ${b.access.mode === "read_only" ? "bad" : "warn"}`}><span>{b.access.notice}</span></div>}
        {offer && (
          <div className="callout info" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
            <span>To add another group you need room for <b>{need}</b> groups. Your plan includes {lim.workspaces}. Two ways to get there (cheaper first):</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[offer.cheaper === "extra" ? offer.extra : offer.upgrade, offer.cheaper === "extra" ? offer.upgrade : offer.extra].filter((o): o is GroupOption => !!o).map((o, i) => (
                <button key={o.plan + o.extras} className={`btn ${i === 0 ? "primary" : ""}`} disabled={!b.canManage} onClick={() => choose(o)}>
                  {o.plan === plan.id ? `Add ${o.extras - extraNow} extra group${o.extras - extraNow === 1 ? "" : "s"}` : `Move to ${planWithExtras(planById(o.plan)!, o.extras)}`}: {usd(o.priceUsd)} / month{i === 0 ? " (cheaper)" : ""}
                </button>
              ))}
            </div>
            {!b.canManage && <span className="muted">Ask your Org Owner or a Billing Admin to pick one.</span>}
          </div>
        )}
        <div className="grid g3">
          <div>
            <div className="eyebrow">Current plan</div>
            <b style={{ fontSize: 18 }}>{planWithExtras(plan, extraNow)}</b>
            <div className="muted">{usd(b.priceUsd ?? monthlyPrice(plan, extraNow))} / month for the organization · {when}</div>
          </div>
          <div>
            <div className="eyebrow">Groups</div>
            <b className="num">{b.usage.workspaces} of {limitText(lim.workspaces)}</b>
            <div className="muted">{extraNow ? `${plan.workspaces} included + ${extraNow} extra` : `${limitText(plan.workspaces)} included`}{b.usage.ending ? ` · ${b.usage.ending} ending (not counted)` : ""}</div>
          </div>
          <div>
            <div className="eyebrow">People</div>
            <b className="num">{b.usage.seats} of {limitText(lim.seats)}</b>
            {lim.seats !== null && <div className="meter" style={{ marginTop: 6 }}><span style={{ width: `${seatPct}%`, background: seatPct >= 100 ? "var(--warn)" : undefined }} /></div>}
          </div>
        </div>
        <Limits lines={b.limits} />
        {err && <p className="err" role="alert" style={{ margin: 0 }}>{err}</p>}
        {b.canManage ? (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label htmlFor="extra-groups" className="muted">Extra groups ({usd(b.extraGroup.priceUsd)} each / month, +{b.extraGroup.adds.seats} people, +{b.extraGroup.adds.meetingHours} meeting hours, +{usd(b.extraGroup.adds.aiCreditUsd)} AI credit each)</label>
              <input id="extra-groups" className="input num" type="number" min={0} max={b.maxExtraGroups} style={{ width: 80 }} value={wantExtras} onChange={(e) => setExtras(Math.max(0, Math.min(b.maxExtraGroups, Math.floor(Number(e.target.value) || 0))))} />
              <button className="btn" disabled={wantExtras === extraNow} onClick={() => setConfirm("extras")}>Update</button>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {sub.status !== "active" && <Link className="btn primary" href={`/checkout?plan=${sub.plan}&extras=${extraNow}`}>Pay now</Link>}
              <select className="input" style={{ width: "auto" }} value={pick} onChange={(e) => setPick(e.target.value as PlanId)} aria-label="Change plan to">
                <option value="">Change plan…</option>
                {b.plans.filter((p) => p.id !== sub.plan && p.selfService).map((p) => <option key={p.id} value={p.id}>{p.name}: {usd(p.priceUsd)} / month, {limitText(p.workspaces)} groups</option>)}
              </select>
              <button className="btn" disabled={!pick} onClick={() => setConfirm("change")}>Change</button>
              <span className="spacer" style={{ flex: 1 }} />
              {b.testMode && sub.status !== "canceled" && <button className="btn small ghost" onClick={() => setConfirm("fail")}>Simulate a failed payment</button>}
              {sub.status !== "canceled" && <button className="btn small danger" onClick={() => setConfirm("cancel")}>Cancel plan</button>}
            </div>
          </>
        ) : (
          <span className="muted">Only the Org Owner and Billing Admins can pay, change the plan or extra groups, or cancel.</span>
        )}
      </div>
      {confirm === "change" && next && (
        <Modal title={`Switch to ${next.name}?`} onClose={() => setConfirm(null)} footer={<><button className="btn" onClick={() => setConfirm(null)}>Back</button><button className="btn primary" onClick={() => act("change", `You're on the ${next.name} plan now`)}>Switch plan</button></>}>
          <p style={{ margin: 0 }}>{planWithExtras(next, extraNow)} is {usd(monthlyPrice(next, extraNow))} a month for the organization, for {limitText(limitsWithExtras(next, extraNow).workspaces)} groups, up to {limitText(limitsWithExtras(next, extraNow).seats)} people, {limitText(next.chats)} tracked chats, {limitText(next.meetingHours)} meeting hours a month, {limitText(next.documents)} documents and {usd(next.aiCreditUsd ?? 0)} of AI credit a month{extraNow ? `, plus what your ${extraNow} extra group${extraNow === 1 ? "" : "s"} add` : ""}. It applies straight away; the paid-until date stays the same. If you use more than a smaller plan allows, nothing is deleted: you just can&apos;t add more until you&apos;re under the limit.</p>
        </Modal>
      )}
      {confirm === "extras" && (
        <Modal title={`${wantExtras} extra group${wantExtras === 1 ? "" : "s"}?`} onClose={() => setConfirm(null)} footer={<><button className="btn" onClick={() => setConfirm(null)}>Back</button><button className="btn primary" onClick={() => act("extras", `${planWithExtras(plan, wantExtras)} now`, { extraGroups: wantExtras })}>Update</button></>}>
          <p style={{ margin: 0 }}>{planWithExtras(plan, wantExtras)} is {usd(monthlyPrice(plan, wantExtras))} a month (now {usd(monthlyPrice(plan, extraNow))}), for {limitText(limitsWithExtras(plan, wantExtras).workspaces)} groups and up to {limitText(limitsWithExtras(plan, wantExtras).seats)} people. It applies straight away (test mode: no money moves).</p>
        </Modal>
      )}
      {option && (
        <Modal title={option.plan === plan.id ? `Add extra groups?` : `Move to ${planById(option.plan)!.name}?`} onClose={() => setOption(null)} footer={<><button className="btn" onClick={() => setOption(null)}>Back</button><button className="btn primary" onClick={() => (option.plan === plan.id ? act("extras", `${planWithExtras(plan, option.extras)} now`, { extraGroups: option.extras }) : act("change", `You're on ${planWithExtras(planById(option.plan)!, option.extras)} now`, { plan: option.plan, extraGroups: option.extras }))}>Confirm</button></>}>
          <p style={{ margin: 0 }}>{planWithExtras(planById(option.plan)!, option.extras)} is {usd(option.priceUsd)} a month for the organization and has room for {option.groups} groups. It applies straight away (test mode: no money moves). Go back to New group afterwards to create the group.</p>
        </Modal>
      )}
      {confirm === "cancel" && (
        <Modal title="Cancel your plan?" onClose={() => setConfirm(null)} footer={<><button className="btn" onClick={() => setConfirm(null)}>Keep plan</button><button className="btn danger solid" onClick={() => act("cancel", "Plan canceled")}>Cancel plan</button></>}>
          <p style={{ margin: 0 }}>{BRAND.name} stays fully usable until the end of what you paid for (or the trial). Then it turns read-only for 30 days: everyone can still see everything and Org Owners and Org Admins can download it all (Settings → Export your data), but nothing new is added and {BRAND.name} stops answering. After those 30 days everything is deleted, and you get a deletion certificate. Paying again before then keeps everything.</p>
        </Modal>
      )}
      {confirm === "fail" && (
        <Modal title="Simulate a failed payment?" onClose={() => setConfirm(null)} footer={<><button className="btn" onClick={() => setConfirm(null)}>Back</button><button className="btn primary" onClick={() => act("fail", "Simulated a failed payment")}>Simulate it</button></>}>
          <p style={{ margin: 0 }}>Test mode only: marks the last payment as failed so you can see what your team sees. {BRAND.name} keeps working for a 7-day grace period, then turns read-only. <b>Pay now</b> fixes it.</p>
        </Modal>
      )}
    </div>
  );
}

/** Shows one limit's number: money for the AI credit, one decimal for meeting hours. */
const shown = (key: LimitKey, n: number) => (key === "aiCreditUsd" ? `$${n.toFixed(2)}` : key === "meetingHours" || key === "liveMeetingHours" ? String(Math.round(n * 10) / 10) : n.toLocaleString());

/**
 * Every plan limit with its use: "3 of 5", a meter, and "Over limit" (more than the plan allows, e.g. after
 * moving to a smaller plan; new ones are refused, nothing is deleted), "At limit" (nothing more fits) or
 * "Near limit" from 80%.
 */
export function Limits({ lines }: { lines: LimitLine[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Limit</th><th className="r">Used</th><th className="r">Included</th><th style={{ width: "30%" }}></th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key}>
              <td>{l.label[0].toUpperCase() + l.label.slice(1)}</td>
              <td className="r num">{(l.key === "connectors" || l.key === "liveMeetingHours") && l.used === 0 ? "—" : shown(l.key, l.used)}</td>
              <td className="r num">{l.limit === null ? (l.key === "connectors" ? "All" : "Unlimited") : l.limit === 0 ? "Not included" : shown(l.key, l.limit)}</td>
              <td>
                {l.over ? <Pill kind="bad">Over limit</Pill> : l.full && l.limit !== 0 ? <Pill kind="warn">At limit</Pill> : l.near ? <Pill kind="warn">Near limit</Pill> : l.limit !== null && l.limit > 0 ? <div className="meter"><span style={{ width: `${Math.min(100, l.pct)}%` }} /></div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
