"use client";

/**
 * The screen shown when a page itself crashes while rendering (a bug, or data in an unexpected shape),
 * used by the Next.js error boundaries in app/(app)/error.tsx and app/owner/(console)/error.tsx.
 * Instead of a blank page it explains what happened, keeps the menu usable, and offers Try again.
 * `digest` is the code Next.js gives server-side errors; it matches the server log.
 */
import { useEffect, useState } from "react";
import { Icon } from "./ui";

export function CrashScreen({ error, retry, area }: { error: Error & { digest?: string }; retry: () => void; area: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    console.error(`${area} page crashed`, error);
  }, [error, area]);
  const details = [`Page: ${typeof location !== "undefined" ? location.pathname : ""}`, error.digest ? `Code: ${error.digest}` : "", `Message: ${error.message}`, `Time: ${new Date().toISOString()}`]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="panel" role="alert">
      <div className="empty" style={{ gap: 12 }}>
        <span style={{ color: "var(--bad)" }}>
          <Icon n="alert" />
        </span>
        <h2>This page hit a problem</h2>
        <span>Something on this page didn&apos;t load correctly. Your data is safe. Try again, or use the menu to go to another page.</span>
        {error.digest && (
          <span className="muted">
            Reference code: <b className="mono">{error.digest}</b>
          </span>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(details).then(() => setCopied(true))}>
            {copied ? "Copied" : "Copy details"}
          </button>
          <button className="btn primary" onClick={() => retry()}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
