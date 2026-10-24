"use client";

/**
 * "Rules Sidekick follows" (Help & support, /help#rules): a read-only, plain-words list everyone can see, from
 * GET /api/rules (lib/guardrails.ts `rulesInForce`): the locked rules that can never be turned off, each organization
 * switch as On or Off, and how many extra rules the organization and the current group have, without their text.
 * Changing any of it is on the Guardrails page, for Org Owners and Org Admins (who also get a link to it here).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useApp } from "./shell";
import { api, Pill, useReportError } from "./ui";
import { BRAND } from "@/lib/brand";

type Rules = {
  locked: { label: string; help: string }[];
  switches: { label: string; help: string; on: boolean }[];
  orgRules: number;
  group: { extraRules: number } | null;
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The panel. Uses the workspace picked in the top bar (if any) for the group line. */
export function RulesSummary() {
  const { me, ws } = useApp();
  const reportError = useReportError();
  const [r, setR] = useState<Rules | null>(null);
  const group = me.workspaces.find((w) => w.id === ws);
  useEffect(() => {
    api<Rules>(`/api/rules${group ? `?ws=${encodeURIComponent(group.id)}` : ""}`).then(setR).catch(reportError);
  }, [group, reportError]);
  return (
    <div className="panel" id="rules">
      <div className="panel-h"><h2>Rules {BRAND.name} follows</h2>{me.user.admin && <Link className="btn small" href="/guardrails">Manage guardrails</Link>}</div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {!r ? <span className="muted">Loading…</span> : (
          <>
            <div>
              <b>Always, in every organization</b>
              <ul className="rule-list" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {r.locked.map((x) => <li key={x.label}><span>{x.label}:</span> <span className="muted">{x.help}</span></li>)}
              </ul>
            </div>
            <div>
              <b>Set by your organization</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, listStyle: "none" }}>
                {r.switches.map((x) => <li key={x.label} style={{ display: "flex", gap: 8, alignItems: "baseline" }}><Pill kind={x.on ? "good" : undefined}>{x.on ? "On" : "Off"}</Pill><span>{x.label}</span></li>)}
              </ul>
              {r.orgRules > 0 && <p className="muted" style={{ margin: "6px 0 0" }}>Your organization also has {plural(r.orgRules, "extra rule")} set by your admins.</p>}
            </div>
            {group && r.group && (
              <p style={{ margin: 0 }}>
                <b>{group.name}:</b>{" "}
                {r.group.extraRules ? `this group has ${plural(r.group.extraRules, "extra rule")} set by your admins.` : "no extra rules for this group."}
              </p>
            )}
            <span className="muted">Only Org Owners and Org Admins can change these. Ask one of them if a rule gets in the way of your work.</span>
          </>
        )}
      </div>
    </div>
  );
}
