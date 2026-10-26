"use client";

/**
 * "Your sign-ins to tools" (Knowledge page, `#signins`): the group's connections in **each person signs in** mode
 * (Jira, Azure DevOps; docs/ARCHITECTURE.md → Connectors) and whether this person has connected their own account.
 * Answers only use those tools' items when the person's own sign-in can open them, so each row says so and offers
 * Connect / Reconnect / Disconnect. Hidden when the group has no such connection. Reads GET /api/connectors/mine;
 * Connect goes to /api/connectors/mine/start (the tool's sign-in, then back here with `?signedin=<tool>`, or
 * `?error=1` with the reason in a one-time cookie, lib/flash.ts). Also exports `AccessNotes`, the note under an
 * answer that left a tool's items out ("Connect your Jira to include its tickets").
 */

import { useCallback, useEffect, useState } from "react";
import { api, Pill, useReportError, useToast } from "@/components/ui";
import { takeFlash } from "@/lib/flash";

/** One row of GET /api/connectors/mine (lib/connector-access.ts `MySignIn`). */
export type MySignIn = {
  connectorId: string; kind: string; label: string; workspaceId: string; workspaceName: string;
  status: "none" | "connected" | "expired"; accountName: string | null; connectedAt: string | null; problem: string | null;
};
/** A note on an answer (lib/connector-access.ts `AccessNote`). */
export type AccessNote = { connectorId: string; kind: string; reason: "connect" | "reconnect" | "chat" | "unavailable"; text: string };

const connectHref = (connectorId: string) => `/api/connectors/mine/start?connector=${encodeURIComponent(connectorId)}`;
const TOOL: Record<string, string> = { ado: "Azure DevOps", jira: "Jira" };

/** The notes under an answer that left a tool's items out, each with its Connect / Reconnect button. */
export function AccessNotes({ notes }: { notes?: AccessNote[] }) {
  if (!notes?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {notes.map((n, i) => (
        <div key={i} className="callout" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
          <span className="grow">🔒 {n.text}</span>
          {(n.reason === "connect" || n.reason === "reconnect") && (
            <a className="btn small" href={connectHref(n.connectorId)}>{n.reason === "reconnect" ? "Reconnect" : "Connect"} your {TOOL[n.kind] ?? "tool"}</a>
          )}
        </div>
      ))}
    </div>
  );
}

/** The panel for one group (`ws`). Renders nothing until the group has a personal connection. */
export function MySignIns({ ws }: { ws: string }) {
  const toast = useToast();
  const reportError = useReportError();
  const [rows, setRows] = useState<MySignIn[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setRows((await api<{ signIns: MySignIn[] }>(`/api/connectors/mine?ws=${encodeURIComponent(ws)}`)).signIns);
  }, [ws]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the request resolves
    load().catch(reportError);
  }, [load, reportError]);
  // Back from the tool's sign-in: say how it went once, then tidy the address.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const signedIn = q.get("signedin");
    if (signedIn) toast(`Connected your ${TOOL[signedIn] ?? "tool"}. Answers can include what you can open there.`);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the one-time message after the redirect
    if (q.has("error")) setError(takeFlash("Connecting didn't finish. Try again."));
    if (signedIn || q.has("error")) {
      q.delete("signedin");
      q.delete("error");
      window.history.replaceState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}${window.location.hash}`);
    }
  }, [toast]);

  const disconnect = async (r: MySignIn) => {
    if (!window.confirm(`Disconnect your ${r.label}? Answers will leave out ${r.label} until you connect again.`)) return;
    try {
      await api(`/api/connectors/mine/${encodeURIComponent(r.connectorId)}`, { method: "DELETE" });
      toast(`Disconnected your ${r.label}`);
      await load();
    } catch (e) {
      reportError(e);
    }
  };

  if (!rows?.length && !error) return null;
  return (
    <div className="panel" id="signins">
      <div className="panel-h"><h2>Your sign-ins to tools</h2></div>
      <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          In this group, these tools show each person only what they can open there. Connect your own account (read-only) so answers can include it.
        </p>
        {error && <p className="err">{error}</p>}
        <div className="list">
          {(rows ?? []).map((r) => (
            <div key={r.connectorId} className="li">
              <div className="grow">
                <b>{r.label}</b>{" "}
                {r.status === "connected" ? <Pill kind="good">Connected{r.accountName ? ` as ${r.accountName}` : ""}</Pill>
                  : r.status === "expired" ? <Pill kind="bad">Sign-in expired</Pill>
                  : <Pill>Not connected</Pill>}
                {r.problem && <div className="muted" style={{ fontSize: 12.5 }}>{r.problem}</div>}
              </div>
              {r.status === "connected"
                ? <button className="btn small ghost" type="button" onClick={() => disconnect(r)}>Disconnect</button>
                : <a className="btn small primary" href={connectHref(r.connectorId)}>{r.status === "expired" ? "Reconnect" : "Connect"} your {r.label}</a>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
