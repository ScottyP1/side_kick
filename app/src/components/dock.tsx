"use client";

/**
 * The round assistant button in the bottom-left corner, and the panel it opens. Used on every portal page
 * (components/assistant-dock.tsx: the in-app assistant and "I need help") and every public page
 * (components/helpbot.tsx: "Ask about Sidekick"); not in the Owner Console.
 *
 * - **Placement**: bottom-left. In the portal on wide screens it sits over the sidebar's own bottom corner (the
 *   sidebar keeps room for it, `.has-dock`), so it never covers a page button; on phones and on the website the
 *   page keeps extra space at the bottom (`.dock-space`) so the last buttons can always be scrolled clear of it.
 * - **Panel**: a non-modal dialog above the button; full screen on phones. Esc or the close button closes it
 *   and puts focus back on the button; opening focuses the message box.
 * - **Dot**: `dot` shows a small badge on the button (e.g. a support reply nobody has read yet).
 * - Plain HTML, CSS and an inline SVG, nothing loaded from elsewhere, so it works under the enforced CSP.
 * - The panel's content stays mounted while closed, so a conversation in progress isn't lost.
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

/** The button and panel. `focusRef` is focused when the panel opens. */
export function Dock({ open, setOpen, label, title, dot, dotLabel, focusRef, headerExtra, children }: {
  open: boolean;
  setOpen: (v: boolean) => void;
  label: string;
  title: string;
  dot?: boolean;
  dotLabel?: string;
  focusRef?: RefObject<HTMLInputElement | null>;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      // Wait a frame so the panel is visible before focusing inside it.
      requestAnimationFrame(() => focusRef?.current?.focus());
    } else if (wasOpen.current) {
      button.current?.focus();
    }
    wasOpen.current = open;
  }, [open, focusRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  return (
    <>
      <div id={id} className="dock-panel" role="dialog" aria-label={title} hidden={!open}>
        <div className="dock-head">
          <b>{title}</b>
          {headerExtra}
          <button type="button" className="btn ghost small" onClick={() => setOpen(false)} aria-label="Close">
            <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="dock-body">{children}</div>
      </div>
      <button
        ref={button}
        type="button"
        className="dock-button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`${label}${dot && dotLabel ? ` (${dotLabel})` : ""}`}
        title={label}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={open ? "M18 6L6 18M6 6l12 12" : "M4 5h16v11H9l-5 4zM8 10h8M8 13h5"} /></svg>
        {dot && !open && <span className="dock-dot" aria-hidden="true" />}
      </button>
    </>
  );
}
