"use client";

/**
 * Setup wizard (/get-started): a new organization's first-time setup, one step at a time, after sign-up and
 * checkout (or any time from the "Finish setting up" banner). Steps (lib/setup.ts):
 * 1. Welcome: the plan and trial, and how groups and Team Leads work.
 * 2. Microsoft 365: connect the company's Microsoft tenant so people sign in with their work account
 *    (Org Owner; the same flow as Settings → Microsoft sign-in, coming back here).
 * 3. Teams: who gets the Sidekick app (recommended: Team Leads and admins only) and what the Teams admin does.
 * 4. Rules: a guardrails starting point, Standard or Strict (Org Owner; PUT /api/guardrails).
 * 5. First groups: name, client and Team Lead for each client team, picking a Team Lead from the
 *    organization or adding someone new (they get a temporary password, shown once).
 * Then Done. Any step can be skipped and come back to; progress is saved per organization (/api/setup).
 * Org Owners and Org Admins only.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/shell";
import { api, fmtDate, Icon, Pill, useReportError, useToast } from "@/components/ui";

type Step = "welcome" | "microsoft" | "teams" | "rules" | "groups";
type Preset = "standard" | "strict";
type Setup = {
  steps: Partial<Record<Step, "done" | "skipped">>; completedAt: string | null; org: string;
  facts: { microsoftConnected: boolean; groups: number };
  people: { id: string; name: string; email: string; role: string }[];
  rules: { current: Preset | "custom"; presets: Record<Preset, Record<string, boolean>>; labels: Record<string, string>; canChange: boolean };
  canConnectMicrosoft: boolean;
};
type Billing = { subscription: { plan: string; status: string; trial_ends_at: string | null } | null; plans: { id: string; name: string; seats?: number }[] };
type GroupRow = { name: string; client: string; lead: string; newName: string; newEmail: string };
type Created = { group: string; lead: string; tempPassword?: string; email?: string };

const STEPS: [Step | "done", string, string][] = [
  ["welcome", "Welcome", "Your account is ready"],
  ["microsoft", "Connect Microsoft 365", "Sign in with work accounts"],
  ["teams", "Add to Teams", "Who gets Sidekick"],
  ["rules", "Rules", "Pick a starting point"],
  ["groups", "First groups", "One per client team"],
  ["done", "Done", "What happens next"],
];
const NEW = "__new__";
const emptyRow = (): GroupRow => ({ name: "", client: "", lead: "", newName: "", newEmail: "" });

export default function SetupWizard() {
  const { me, reload } = useApp();
  const toast = useToast();
  const reportError = useReportError();
  const [s, setS] = useState<Setup | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [at, setAt] = useState(0);

  const load = useCallback(() => api<Setup>("/api/setup").then(setS), []);
  useEffect(() => {
    if (!me.user.admin) return;
    load()
      .then(() => {
        const q = new URLSearchParams(location.search);
        if (q.get("microsoft") === "connected") {
          toast("Microsoft 365 connected");
          setAt(1);
        } else if (q.get("paid")) toast("Payment received. Let's set up Sidekick.");
      })
      .catch(reportError);
    api<Billing>("/api/billing").then(setBilling).catch(reportError);
  }, [me.user.admin, load, reportError, toast]);

  if (!me.user.admin) {
    return <div className="panel"><div className="empty"><h2>Setup is for admins</h2><span>Your Org Owner or an Org Admin sets Sidekick up for your organization.</span><Link className="btn" href="/home">Go home</Link></div></div>;
  }
  if (!s) return <span className="muted">Loading setup…</span>;

  const mark = async (step: Step, state: "done" | "skipped") => {
    await api("/api/setup", { method: "PUT", json: { step, state } });
    await load();
    setAt((i) => Math.min(i + 1, STEPS.length - 1));
    window.scrollTo(0, 0);
  };
  const next = (step: Step) => mark(step, "done").catch(reportError);
  const skip = (step: Step) => mark(step, "skipped").catch(reportError);
  const back = () => setAt((i) => Math.max(0, i - 1));
  const stateOf = (k: Step | "done") => (k === "done" ? (s.completedAt ? "done" : undefined) : s.steps[k]);
  const key = STEPS[at][0];

  return (
    <div className="wiz">
      <aside className="wiz-side">
        <ol className="wiz-steps">
          {STEPS.map(([k, title, sub], i) => {
            const st = stateOf(k);
            return (
              <li key={k} className={i === at ? "now" : st === "done" ? "done" : ""}>
                <span className="n">{st === "done" ? <Icon n="check" /> : i + 1}</span>
                <button onClick={() => setAt(i)} aria-current={i === at ? "step" : undefined}>
                  <b>{title}</b>
                  <small>{st === "skipped" ? "Skipped for now" : sub}</small>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>You can stop at any time. Your progress is saved, and a banner brings you back here until setup is finished.</p>
      </aside>
      <section className="panel wiz-card" aria-live="polite">
        {key === "welcome" && <Welcome s={s} billing={billing} name={me.user.name} onNext={() => next("welcome")} />}
        {key === "microsoft" && <Microsoft s={s} onNext={() => next("microsoft")} onSkip={() => skip("microsoft")} onBack={back} />}
        {key === "teams" && <Teams onNext={() => next("teams")} onSkip={() => skip("teams")} onBack={back} />}
        {key === "rules" && <Rules s={s} reload={load} onNext={() => next("rules")} onSkip={() => skip("rules")} onBack={back} />}
        {key === "groups" && <Groups s={s} reload={async () => { await load(); await reload(); }} onNext={() => next("groups")} onSkip={() => skip("groups")} onBack={back} />}
        {key === "done" && <Done s={s} onFinish={async () => { await api("/api/setup", { method: "PUT", json: { finished: true } }); await load(); await reload(); }} onBack={back} />}
      </section>
    </div>
  );
}

/** Back / Skip / Continue under each step. */
function Foot({ onBack, onSkip, onNext, nextLabel = "Continue", disabled }: { onBack?: () => void; onSkip?: () => void; onNext: () => void; nextLabel?: string; disabled?: boolean }) {
  return (
    <div className="wiz-foot">
      {onBack && <button className="btn" onClick={onBack}><Icon n="back" />Back</button>}
      <span style={{ flex: 1 }} />
      {onSkip && <button className="btn ghost" onClick={onSkip}>Do this later</button>}
      <button className="btn primary" onClick={onNext} disabled={disabled}>{nextLabel}</button>
    </div>
  );
}

function Welcome({ s, billing, name, onNext }: { s: Setup; billing: Billing | null; name: string; onNext: () => void }) {
  const sub = billing?.subscription;
  const plan = sub ? billing?.plans.find((p) => p.id === sub.plan)?.name ?? sub.plan : null;

  return (
    <>
      <header><span className="eyebrow">Step 1 of 5</span><h1>Welcome to Sidekick, {name.split(" ")[0]}</h1>
        <p>{s.org} is ready. In about 10 minutes you&apos;ll connect Microsoft 365, choose your rules and set up a group for each client team.</p></header>
      <div className="gstats" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))" }}>
        <div><span className="eyebrow">Plan</span><span className="v">{plan ?? "Managed"}</span><span className="muted" style={{ fontSize: 12.5 }}>{sub?.status === "trialing" ? `Free trial until ${fmtDate(sub.trial_ends_at)}` : sub ? sub.status === "active" ? "Paid" : sub.status : "By the Sidekick team"}</span></div>
        <div><span className="eyebrow">Groups</span><span className="v">{s.facts.groups}</span><span className="muted" style={{ fontSize: 12.5 }}>One per client team</span></div>
        <div><span className="eyebrow">Microsoft 365</span><span className="v" style={{ fontSize: 18 }}>{s.facts.microsoftConnected ? "Connected" : "Not yet"}</span><span className="muted" style={{ fontSize: 12.5 }}>For work-account sign-in</span></div>
      </div>
      <div className="ng-two">
        <div className="callout info"><Icon n="folder" /><div><b>One group per client team.</b> Northwind Bank&apos;s documents and chats stay in the Northwind group. Sidekick never mixes clients.</div></div>
        <div className="callout info"><Icon n="users" /><div><b>Each group has a Team Lead.</b> They add their people and assign their team&apos;s Teams chats, so you don&apos;t have to.</div></div>
      </div>
      <Foot onNext={onNext} nextLabel="Start setup" />
    </>
  );
}

function Microsoft({ s, onNext, onSkip, onBack }: { s: Setup; onNext: () => void; onSkip: () => void; onBack: () => void }) {
  const ok = s.facts.microsoftConnected;
  return (
    <>
      <header><span className="eyebrow">Step 2 of 5</span><h1>Connect Microsoft 365</h1>
        <p>Connect your company&apos;s Microsoft 365 so your people sign in to Sidekick with their work account, with no new passwords. You sign in once with your own work account to connect it.</p></header>
      {ok && <div className="callout good"><Icon n="check" /><div><b>Connected.</b> People you add can use <b>Sign in with Microsoft</b>. You can require it later under Settings.</div></div>}
      <div className="panel">
        <div className="panel-h"><h3>What Microsoft asks you to allow, in plain words</h3></div>
        <div className="panel-b" style={{ paddingBlock: 4 }}>
          <div className="perm"><Icon n="check" /><b>Sign people in with their work account</b><span /><span className="muted">Microsoft confirms who someone is. Sidekick only lets in people you&apos;ve added.</span></div>
          <div className="perm"><Icon n="check" /><b>See their name and email</b><span /><span className="muted">So Sidekick can match the Microsoft account to the person you added.</span></div>
          <div className="perm no"><Icon n="x" /><b>Not: email, files, calendars or chats</b><span /><span className="muted">Signing in doesn&apos;t give Sidekick any of these. Teams chats are added separately, chat by chat.</span></div>
        </div>
      </div>
      {!ok && (s.canConnectMicrosoft
        ? <div><a className="btn primary" href="/api/auth/microsoft/start?mode=link&next=/get-started">Connect with Microsoft</a></div>
        : <div className="callout info"><Icon n="lock" /><div>Only the Org Owner can connect Microsoft 365. Ask them to open this setup, or skip this step for now.</div></div>)}
      <Foot onBack={onBack} onSkip={ok ? undefined : onSkip} onNext={onNext} disabled={!ok} />
    </>
  );
}

function Teams({ onNext, onSkip, onBack }: { onNext: () => void; onSkip: () => void; onBack: () => void }) {
  const [who, setWho] = useState<"leads" | "everyone">("leads");
  const choice = (v: "leads" | "everyone", title: string, desc: string) => (
    <button className="choice" role="radio" aria-checked={who === v} onClick={() => setWho(v)}>
      <span className="radio" /><span><b>{title}</b><br /><span className="muted" style={{ fontSize: 12.5 }}>{desc}</span></span>
    </button>
  );
  return (
    <>
      <header><span className="eyebrow">Step 3 of 5</span><h1>Add Sidekick to Teams</h1>
        <p>Your Teams admin makes the Sidekick app available. Sidekick never joins a chat on its own: someone adds it, and it stays silent until a Team Lead assigns that chat to a group here in the portal.</p></header>
      <div role="radiogroup" aria-label="Who gets Sidekick in Teams" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {choice("leads", "Only Team Leads and admins (recommended)", "Only they can add Sidekick to a chat, so it can't be pulled into chats it shouldn't be in. Everyone in an assigned chat still sees its answers and cards.")}
        {choice("everyone", "Everyone", "Anyone can add Sidekick to a chat. It still does nothing there until a Team Lead assigns the chat to a group.")}
      </div>
      <div className="panel">
        <div className="panel-h"><h3>What your Teams admin does</h3></div>
        <div className="panel-b">
          <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
            <li>In the <b>Teams admin center</b>, open <b>Teams apps → Manage apps</b> and allow <b>Sidekick</b>.</li>
            {who === "leads"
              ? <li>Under <b>Teams apps → Permission policies</b>, make Sidekick available only to a group with your Team Leads and admins (for example a Microsoft 365 group called “Sidekick Team Leads”).</li>
              : <li>Leave Sidekick available to everyone in the default permission policy.</li>}
            <li>Team Leads then add Sidekick to their team&apos;s chats and assign each chat to their group in the portal.</li>
          </ol>
        </div>
      </div>
      <Foot onBack={onBack} onSkip={onSkip} onNext={onNext} nextLabel="It's done" />
    </>
  );
}

function Rules({ s, reload, onNext, onSkip, onBack }: { s: Setup; reload: () => Promise<void>; onNext: () => void; onSkip: () => void; onBack: () => void }) {
  const toast = useToast();
  const [pick, setPick] = useState<Preset>(s.rules.current === "strict" ? "strict" : "standard");
  const [error, setError] = useState("");
  const keys = Object.keys(s.rules.labels);
  const apply = async () => {
    setError("");
    try {
      if (s.rules.canChange && s.rules.current !== pick) {
        await api("/api/guardrails", { method: "PUT", json: s.rules.presets[pick] });
        await reload();
        toast(`${pick === "strict" ? "Strict" : "Standard"} rules are on.`);
      }
      onNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change the rules.");
    }
  };
  const card = (v: Preset, title: string, desc: string) => (
    <button className="choice" role="radio" aria-checked={pick === v} onClick={() => setPick(v)} disabled={!s.rules.canChange}>
      <span className="radio" /><span><b>{title}</b><br /><span className="muted" style={{ fontSize: 12.5 }}>{desc}</span></span>
    </button>
  );
  const cell = (on: boolean) => (on ? <span style={{ color: "var(--good)" }}><Icon n="check" /></span> : <span className="faint">Off</span>);
  return (
    <>
      <header><span className="eyebrow">Step 4 of 5</span><h1>Rules</h1>
        <p>Pick a starting point for what Sidekick will and won&apos;t answer. You can change any of it later on the Guardrails page, and make one group stricter than the rest.</p></header>
      <div className="ng-two" role="radiogroup" aria-label="Starting rules">
        {card("standard", "Standard (recommended)", "Most teams. Sensible limits, nothing in the way.")}
        {card("strict", "Strict", "Regulated clients: banks, health, insurance, public sector.")}
      </div>
      {!s.rules.canChange && <div className="callout info"><Icon n="lock" /><div>Only the Org Owner can change these switches. Your organization uses <b>{s.rules.current === "custom" ? "its own mix" : s.rules.current === "strict" ? "Strict" : "Standard"}</b> today.</div></div>}
      <div className="panel"><div className="table-wrap"><table>
        <thead><tr><th>What Sidekick does</th><th style={{ textAlign: "center" }}>Standard</th><th style={{ textAlign: "center" }}>Strict</th></tr></thead>
        <tbody>
          <tr><td>Always on: no hate, harassment or harm; never crosses client walls; says “I don&apos;t know” instead of guessing</td><td style={{ textAlign: "center" }}><Icon n="lock" /></td><td style={{ textAlign: "center" }}><Icon n="lock" /></td></tr>
          {keys.map((k) => <tr key={k}><td>{s.rules.labels[k]}</td><td style={{ textAlign: "center" }}>{cell(s.rules.presets.standard[k])}</td><td style={{ textAlign: "center" }}>{cell(s.rules.presets.strict[k])}</td></tr>)}
        </tbody>
      </table></div></div>
      {error && <p className="err">{error}</p>}
      <Foot onBack={onBack} onSkip={onSkip} onNext={apply} nextLabel={s.rules.canChange ? `Use ${pick === "strict" ? "Strict" : "Standard"}` : "Continue"} />
    </>
  );
}

function Groups({ s, reload, onNext, onSkip, onBack }: { s: Setup; reload: () => Promise<void>; onNext: () => void; onSkip: () => void; onBack: () => void }) {
  const [rows, setRows] = useState<GroupRow[]>([emptyRow()]);
  const [created, setCreated] = useState<Created[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<GroupRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const ready = rows.filter((r) => r.name.trim());
  const valid = ready.length > 0 && ready.every((r) => r.lead && (r.lead !== NEW || (r.newName.trim() && r.newEmail.trim())));

  const create = async () => {
    setError("");
    setBusy(true);
    const done: Created[] = [];
    let failed = false;
    try {
      for (const r of ready) {
        let lead = r.lead;
        let extra: Partial<Created> = {};
        if (lead === NEW) {
          const u = await api<{ id: string; tempPassword?: string }>("/api/users", { method: "POST", json: { name: r.newName.trim(), email: r.newEmail.trim(), role: "Member", workspaces: [] } });
          lead = u.id;
          extra = { tempPassword: u.tempPassword, email: r.newEmail.trim() };
        }
        await api("/api/workspaces", { method: "POST", json: { name: r.name.trim(), client: r.client.trim(), lead } });
        done.push({ group: r.client.trim() ? `${r.client.trim()} – ${r.name.trim()}` : r.name.trim(), lead: lead === r.lead ? s.people.find((p) => p.id === lead)?.name ?? "" : r.newName.trim(), ...extra });
        setRows((cur) => cur.filter((x) => x !== r));
      }
    } catch (e) {
      failed = true;
      setError(e instanceof Error ? e.message : "Couldn't create that group.");
    }
    setCreated((c) => [...c, ...done]);
    setBusy(false);
    await reload();
    // Created rows are gone from the form; keep one empty row to add more (a failed row stays to fix).
    if (!failed) setRows((cur) => (cur.length ? cur : [emptyRow()]));
  };

  return (
    <>
      <header><span className="eyebrow">Step 5 of 5</span><h1>Create your first groups</h1>
        <p>A group is one client team: its people, its Teams chats and its documents. Add one for each client team you work with now. Each needs a name and a Team Lead; the lead adds their own people later.</p></header>
      {created.length > 0 && (
        <div className="callout good"><Icon n="check" /><div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <b>Created {created.length} group{created.length === 1 ? "" : "s"}.</b>
          {created.map((c) => (
            <span key={c.group}>{c.group}, led by {c.lead}{c.tempPassword && <> · temporary password for {c.email}: <span className="mono">{c.tempPassword}</span> (shown once; share it privately)</>}</span>
          ))}
        </div></div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {rows.map((r, i) => (
          <div key={i} className="panel"><div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="wiz-row">
              <div className="field"><label htmlFor={`g-name-${i}`}>Group name</label><input id={`g-name-${i}`} className="input" value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="e.g. Payments Platform" /></div>
              <div className="field"><label htmlFor={`g-client-${i}`}>Client</label><input id={`g-client-${i}`} className="input" value={r.client} onChange={(e) => set(i, { client: e.target.value })} placeholder="e.g. Northwind Bank" /></div>
              <div className="field"><label htmlFor={`g-lead-${i}`}>Team Lead</label>
                <select id={`g-lead-${i}`} className="input" value={r.lead} onChange={(e) => set(i, { lead: e.target.value })}>
                  <option value="">Pick someone…</option>
                  {s.people.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role})</option>)}
                  <option value={NEW}>Someone new…</option>
                </select></div>
              {rows.length > 1 && <button className="btn small ghost" aria-label="Remove this group" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon n="x" /></button>}
            </div>
            {r.lead === NEW && (
              <div className="ng-two">
                <div className="field"><label htmlFor={`g-nn-${i}`}>Their name</label><input id={`g-nn-${i}`} className="input" value={r.newName} onChange={(e) => set(i, { newName: e.target.value })} /></div>
                <div className="field"><label htmlFor={`g-ne-${i}`}>Their work email</label><input id={`g-ne-${i}`} className="input" type="email" value={r.newEmail} onChange={(e) => set(i, { newEmail: e.target.value })} /><span className="hint">They become a Team Lead. If you connected Microsoft 365 they can sign in with Microsoft; otherwise you&apos;ll get a temporary password to share.</span></div>
              </div>
            )}
          </div></div>
        ))}
        <div><button className="btn" onClick={() => setRows([...rows, emptyRow()])}><Icon n="plus" />Add another group</button></div>
      </div>
      {error && <p className="err">{error}</p>}
      <div className="wiz-foot">
        <button className="btn" onClick={onBack}><Icon n="back" />Back</button>
        <span style={{ flex: 1 }} />
        {!created.length && !s.facts.groups && <button className="btn ghost" onClick={onSkip}>Do this later</button>}
        {(created.length > 0 || s.facts.groups > 0) && <button className="btn" onClick={onNext}>Continue</button>}
        <button className="btn primary" disabled={!valid || busy} onClick={create}>{busy ? "Creating…" : `Create ${ready.length || ""} group${ready.length === 1 ? "" : "s"}`}</button>
      </div>
    </>
  );
}

function Done({ s, onFinish, onBack }: { s: Setup; onFinish: () => Promise<void>; onBack: () => void }) {
  const reportError = useReportError();
  const rows: [string, boolean, string][] = [
    ["Microsoft 365", s.facts.microsoftConnected, s.facts.microsoftConnected ? "Connected for work-account sign-in" : "Not connected yet (Settings → Microsoft sign-in)"],
    ["Teams", s.steps.teams === "done", s.steps.teams === "done" ? "Your Teams admin made Sidekick available" : "Still to do with your Teams admin"],
    ["Rules", s.steps.rules === "done", s.rules.current === "custom" ? "Your own mix (Guardrails page)" : `${s.rules.current === "strict" ? "Strict" : "Standard"} starting point`],
    ["Groups", s.facts.groups > 0, s.facts.groups ? `${s.facts.groups} group${s.facts.groups === 1 ? "" : "s"}` : "None yet (Groups → New group)"],
  ];
  return (
    <>
      <header><span className="eyebrow">Done</span><h1>{s.completedAt ? "You're set up" : "Almost there"}</h1><p>Here&apos;s where things stand. Anything not done yet can be finished later from the pages named below.</p></header>
      <ul className="check-list">
        {rows.map(([t, ok, d]) => <li key={t}><span className={`ck${ok ? " ok" : ""}`}>{ok && <Icon n="check" />}</span><span><b>{t}</b> <span className="muted">· {d}</span></span></li>)}
      </ul>
      <div className="callout info"><Icon n="users" /><div><b>Next, your Team Leads</b> add their people, add Sidekick to their team&apos;s Teams chats and assign those chats to their group, and upload the key documents. Each group&apos;s page shows its own checklist.</div></div>
      <div className="wiz-foot">
        <button className="btn" onClick={onBack}><Icon n="back" />Back</button>
        <span style={{ flex: 1 }} />
        {s.completedAt ? <><Pill kind="good">Setup finished</Pill><Link className="btn primary" href="/workspaces">Go to Groups</Link></>
          : <button className="btn primary" onClick={() => onFinish().catch(reportError)}>Finish setup</button>}
      </div>
    </>
  );
}
