"use client";

/**
 * The portal's bottom-left assistant button (rendered by components/shell.tsx on every portal page, never in
 * the Owner Console). Two tabs:
 * - **Assistant**: the in-app assistant (components/assistant.tsx), the same conversation as the home page's.
 * - **I need help**: the Help chat (components/support-chat.tsx), plus links to Contact support and My tickets.
 * The dot shows when one of the person's tickets has a reply they haven't read (GET /api/support/unread,
 * checked on load, on every page change and every two minutes); a reply opens the panel on "I need help".
 * The chosen tab is remembered for the session, so the conversation stays where it was across pages.
 * The shell owns whether the panel is open (`open`/`setOpen`), because on phones the tab bar's "Ask" button opens
 * it instead of the round button, and it hears about unread replies (`onUnread`) to show the same dot there.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Assistant } from "./assistant";
import { Dock } from "./dock";
import { SupportChat } from "./support-chat";
import { api, useReportError } from "./ui";
import { BRAND } from "@/lib/brand";

const TAB_KEY = "sidekick.dock.tab";

/** The id of the assistant panel, for the phone tab bar's Ask button (`aria-controls`). */
export const ASSISTANT_PANEL_ID = "assistant-panel";

/**
 * The portal's assistant button and panel. `open`/`setOpen` come from the shell (components/shell.tsx);
 * `onUnread` is told the number of unread support replies whenever it is checked; `returnRef` is the tab bar's
 * Ask button, which gets focus back when the panel closes on a phone.
 */
export function AssistantDock({ open, setOpen, onUnread, returnRef }: { open: boolean; setOpen: (v: boolean) => void; onUnread?: (n: number) => void; returnRef?: RefObject<HTMLElement | null> }) {
  const [tab, setTabState] = useState<"assist" | "help">("assist");
  const [unread, setUnread] = useState(0);
  const path = usePathname();
  const assistInput = useRef<HTMLInputElement>(null);
  const helpInput = useRef<HTMLInputElement>(null);
  const report = useReportError();

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(TAB_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved === "help" || saved === "assist") setTabState(saved);
    } catch {}
  }, []);
  const setTab = (t: "assist" | "help") => {
    setTabState(t);
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {}
    requestAnimationFrame(() => (t === "assist" ? assistInput : helpInput).current?.focus());
  };

  const check = useCallback(() => {
    api<{ unread: number }>("/api/support/unread")
      .then((r) => {
        setUnread(r.unread);
        onUnread?.(r.unread);
      })
      .catch(report);
  }, [report, onUnread]);
  useEffect(() => {
    check();
    const t = setInterval(check, 120_000);
    return () => clearInterval(t);
  }, [check, path]);

  return (
    <Dock
      id={ASSISTANT_PANEL_ID}
      returnRef={returnRef}
      open={open}
      setOpen={setOpen}
      label="Assistant and help"
      title={tab === "assist" ? `${BRAND.name} assistant` : "Help"}
      dot={unread > 0}
      dotLabel={`${unread} new support ${unread === 1 ? "reply" : "replies"}`}
      focusRef={tab === "assist" ? assistInput : helpInput}
    >
      <div className="dock-tabs" role="tablist" aria-label="Assistant or help">
        <button type="button" role="tab" aria-selected={tab === "assist"} className={tab === "assist" ? "on" : ""} onClick={() => setTab("assist")}>Assistant</button>
        <button type="button" role="tab" aria-selected={tab === "help"} className={tab === "help" ? "on" : ""} onClick={() => setTab("help")}>I need help{unread > 0 && <span className="dock-count">{unread}</span>}</button>
      </div>
      <div hidden={tab !== "assist"} role="tabpanel" aria-label="Assistant">
        <Assistant inputRef={assistInput} compact />
        <p className="muted chat-small" style={{ margin: "8px 0 0" }}>Something not working? <button type="button" className="linkish" onClick={() => setTab("help")}>I need help</button></p>
      </div>
      <div hidden={tab !== "help"} role="tabpanel" aria-label="Help">
        <SupportChat inputRef={helpInput} />
        <div className="dock-links">
          <Link href="/help" onClick={() => setOpen(false)}>Contact support</Link>
          <Link href="/help#tickets" onClick={() => setOpen(false)}>My tickets{unread > 0 ? ` (${unread} new)` : ""}</Link>
          <Link href="/docs" onClick={() => setOpen(false)}>Help center</Link>
        </div>
      </div>
    </Dock>
  );
}
