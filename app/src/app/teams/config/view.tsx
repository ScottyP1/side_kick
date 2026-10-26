"use client";

/**
 * /teams/config: the page Teams opens when someone adds Sidekick as a tab to a group chat, channel or meeting.
 * There's nothing to choose (the tab shows the group linked to that chat, or the person's own groups), so it only
 * explains and tells Teams what to show: the tab page (/teams/tab) and, outside Teams, the portal's Meetings page.
 * Adding the tab to a meeting also adds the Sidekick bot to the meeting chat, which a Team Lead or admin can then
 * assign to the group in the portal (lib/teams/tab.ts). Outside Teams it just says to open it in Teams.
 * Store rules: it explains the tab and what's needed first, links help and contact details, and follows Teams' theme.
 */
import { useEffect, useState } from "react";
import { BRAND } from "@/lib/brand";
import { followTeamsTheme } from "../teams-theme";

export default function TeamsTabConfig() {
  const [state, setState] = useState<"loading" | "ready" | "outside">("loading");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { app, pages } = await import("@microsoft/teams-js");
      const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 4000));
      // Outside Teams the SDK either rejects at once ("No Parent window found") or never answers.
      if ((await Promise.race([app.initialize().then(() => "ok" as const, () => "outside" as const), timer])) !== "ok") {
        if (!cancelled) setState("outside");
        return;
      }
      followTeamsTheme(app, await app.getContext());
      const origin = window.location.origin;
      pages.config.registerOnSaveHandler((save) => {
        pages.config
          .setConfig({ entityId: "sidekick-meetings", contentUrl: `${origin}/teams/tab`, websiteUrl: `${origin}/meetings`, suggestedDisplayName: BRAND.shortName })
          .then(() => save.notifySuccess(), (e) => save.notifyFailure(e instanceof Error ? e.message : "Couldn't add the tab."));
      });
      pages.config.setValidityState(true);
      if (!cancelled) setState("ready");
    })().catch(() => !cancelled && setState("outside"));
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <main style={{ padding: 24, maxWidth: 560, display: "flex", flexDirection: "column", gap: 10 }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>{BRAND.name}: meetings and notes</h1>
      {state === "outside" ? (
        <p>Open this from Microsoft Teams: add {BRAND.shortName} as a tab to a chat, channel or meeting.</p>
      ) : (
        <>
          <p style={{ margin: 0 }}>This tab shows the group&apos;s meetings, the notes {BRAND.name} wrote and the open action items. Each person sees only the groups they belong to.</p>
          <p style={{ margin: 0 }} className="muted">Adding it to a meeting also brings {BRAND.shortName} into the meeting chat. Once a Team Lead or admin assigns that chat to a group in {BRAND.name}, the meeting&apos;s notes go to that group automatically.</p>
          <p style={{ margin: 0 }} className="muted">Your organization needs a {BRAND.name} account, and you need to be in one of its groups to see anything here.</p>
          <p style={{ margin: 0 }} className="muted">{state === "loading" ? "Connecting to Teams…" : "Press Save to add the tab."}</p>
        </>
      )}
      <p style={{ margin: 0, fontSize: 13 }} className="muted">
        Questions? See the <a href="/docs/teams-guide" target="_blank" rel="noreferrer">help center</a> (opens in browser) or write to <a href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a>.
      </p>
    </main>
  );
}
