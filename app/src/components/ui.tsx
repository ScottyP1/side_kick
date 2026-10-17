"use client";

/**
 * Small shared UI pieces used by every page: the `api()` fetch helper, toasts, icons, pills, switches,
 * modals, date/money formatting and `CitedText` (shows [S1] citations as small source badges).
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/* ---------- API helper: JSON in/out, readable errors, nothing fails silently ---------- */

/**
 * What kind of failure this was, so the UI can say the right thing:
 * - "network": the browser couldn't reach Sidekick at all (offline, server down, tunnel stopped)
 * - "server":  Sidekick hit an unexpected problem (5xx); comes with a reference code (`ref`)
 * - "paused":  a feature or the whole organization is paused by the Sidekick team (503 "paused")
 * - "request": the request itself was refused (4xx: not allowed, not found, invalid input)
 */
export type ProblemKind = "network" | "server" | "paused" | "request";

export class ApiError extends Error {
  constructor(public status: number, message: string, public kind: ProblemKind = "request", public ref?: string) {
    super(message);
  }
}

/** Event the app raises for problems the person must know about; ProblemProvider shows them as a modal. */
const PROBLEM_EVENT = "sidekick:problem";
function raiseProblem(e: ApiError) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PROBLEM_EVENT, { detail: e }));
}

/**
 * Calls one of Sidekick's API routes and returns the JSON. `json` sends a JSON body.
 * Throws `ApiError` with the server's plain-language message on failure, and never fails silently:
 * - 401 sends the browser to sign-in;
 * - "network", "server" and "paused" problems also open the problem modal automatically, so the person
 *   sees them even if the page that made the call doesn't handle errors;
 * - "request" problems (4xx) are left to the page, which shows them next to the thing that failed.
 */
export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: json !== undefined ? { "Content-Type": "application/json", ...(rest.headers ?? {}) } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    const e = new ApiError(0, "Can't reach Sidekick. Check your internet connection; if it's fine, Sidekick may be restarting. Try again in a minute.", "network");
    raiseProblem(e);
    throw e;
  }
  const data = (await res.json().catch(() => null)) as { error?: string; ref?: string } | null;
  if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth") && !url.startsWith("/api/owner/auth")) {
    window.location.href = url.startsWith("/api/owner") ? "/owner/login" : "/login";
  }
  if (!res.ok) {
    const message = data?.error ?? (res.status >= 500 ? `Sidekick had a problem answering (error ${res.status}). Try again in a minute.` : `Request failed (${res.status}).`);
    const kind: ProblemKind = res.status === 503 && /paused/i.test(message) ? "paused" : res.status >= 500 ? "server" : "request";
    const e = new ApiError(res.status, message, kind, data?.ref);
    if (kind !== "request") raiseProblem(e);
    throw e;
  }
  return (data ?? {}) as T;
}

/* ---------- Toasts ---------- */
type ToastKind = "info" | "error";
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});
/**
 * Returns `toast(message, kind?)`, which shows a short note at the bottom of the screen.
 * `kind: "error"` shows it in red and keeps it up longer, for something that didn't work.
 */
export const useToast = () => useContext(ToastCtx);

/**
 * Returns a function to pass to `.catch()` when loading data: problems that already opened the modal
 * (network, server, paused) are left to it; anything else is shown as an error toast. Use it instead of
 * `.catch(() => {})`, so a failed load is never silent.
 */
export function useReportError() {
  const toast = useToast();
  return useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.kind !== "request") return;
      toast(e instanceof Error ? e.message : "Something didn't work. Try again.", "error");
    },
    [toast],
  );
}

/** Shows toasts and the problem modal. Wraps every signed-in page (see shell.tsx and owner-shell.tsx). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
  const toast = useCallback((msg: string, kind: ToastKind = "info") => {
    const id = Math.random();
    // The same message twice in a row (e.g. a retried load) shows once.
    setToasts((t) => (t.some((x) => x.msg === msg) ? t : [...t.slice(-3), { id, msg, kind }]));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4200);
  }, []);

  // Anything that throws without being handled (a forgotten .catch) still reaches the person.
  useEffect(() => {
    const onUnhandled = (ev: PromiseRejectionEvent) => {
      const e = ev.reason;
      if (e instanceof ApiError && e.kind !== "request") return; // already shown in the modal
      toast(e instanceof Error && e.message ? e.message : "Something didn't work. Try again.", "error");
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    return () => window.removeEventListener("unhandledrejection", onUnhandled);
  }, [toast]);

  return (
    <ToastCtx.Provider value={toast}>
      <ProblemProvider>{children}</ProblemProvider>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === "error" ? " error" : ""}`} role={t.kind === "error" ? "alert" : undefined}>
            {t.kind === "error" && <Icon n="alert" />}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

const PROBLEM_TITLES: Record<Exclude<ProblemKind, "request">, string> = {
  network: "Can't reach Sidekick",
  server: "Something went wrong on our side",
  paused: "Paused by the Sidekick team",
};

/**
 * The problem modal: explains what broke in plain language and what to do next, with a reference code
 * the Sidekick team can look up (Owner Console → Performance & errors). Repeats of the same problem
 * while it's open are counted instead of stacking more dialogs.
 */
function ProblemProvider({ children }: { children: ReactNode }) {
  const [problem, setProblem] = useState<{ e: ApiError; count: number } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const on = (ev: Event) => {
      const e = (ev as CustomEvent<ApiError>).detail;
      setProblem((cur) => (cur && cur.e.kind === e.kind && cur.e.message === e.message ? { e, count: cur.count + 1 } : cur ?? { e, count: 1 }));
    };
    window.addEventListener(PROBLEM_EVENT, on);
    return () => window.removeEventListener(PROBLEM_EVENT, on);
  }, []);
  const close = useCallback(() => {
    setProblem(null);
    setCopied(false);
  }, []);
  const kind = problem?.e.kind as Exclude<ProblemKind, "request"> | undefined;
  const details = problem
    ? [`What happened: ${problem.e.message}`, problem.e.ref ? `Reference: ${problem.e.ref}` : "", `Page: ${typeof location !== "undefined" ? location.pathname : ""}`, `Time: ${new Date().toISOString()}`].filter(Boolean).join("\n")
    : "";
  return (
    <>
      {children}
      {problem && kind && (
        <Modal
          title={PROBLEM_TITLES[kind]}
          onClose={close}
          footer={
            <>
              <button
                className="btn"
                onClick={() =>
                  navigator.clipboard
                    ?.writeText(details)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false))
                }
              >
                {copied ? "Copied" : "Copy details"}
              </button>
              <button className="btn" onClick={close}>Close</button>
              <button className="btn primary" onClick={() => location.reload()}>Try again</button>
            </>
          }
        >
          <div className={`callout ${kind === "paused" ? "warn" : "bad"}`} role="alert">
            <Icon n="alert" />
            <div>{problem.e.ref ? problem.e.message.replace(/\s*\(Reference [^)]*\)\s*$/, "") : problem.e.message}</div>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {kind === "network" && "Your work isn't lost: anything you saved before this is safe. Check your connection, then try again."}
            {kind === "server" && "This is on our side, not something you did. Try again; if it keeps happening, send the details below to your Sidekick contact."}
            {kind === "paused" && "This is temporary and intentional, for example during maintenance. Your data is safe. Try again later."}
          </p>
          {problem.e.ref && (
            <p style={{ margin: 0 }}>
              Reference code: <b className="mono">{problem.e.ref}</b>
            </p>
          )}
          {problem.count > 1 && <p className="muted" style={{ margin: 0 }}>This happened {problem.count} times.</p>}
        </Modal>
      )}
    </>
  );
}

/* ---------- Icons ---------- */
const ICONS: Record<string, string> = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  cpu: "M7 7h10v10H7zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  doc: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6",
  brain: "M12 5a3 3 0 0 0-5.6-1.5A3 3 0 0 0 4 8a3 3 0 0 0 0 6 3 3 0 0 0 3 5 3 3 0 0 0 5-1zM12 5a3 3 0 0 1 5.6-1.5A3 3 0 0 1 20 8a3 3 0 0 1 0 6 3 3 0 0 1-3 5 3 3 0 0 1-5-1zM12 5v13",
  video: "M15 10l5-3v10l-5-3zM3 7h12v10H3z",
  plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  plus: "M12 5v14M5 12h14",
  x: "M18 6L6 18M6 6l12 12",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  back: "M15 18l-6-6 6-6",
  alert: "M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
};
export const Icon = ({ n }: { n: string }) => (
  <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
    <path d={ICONS[n]} />
  </svg>
);

export const Pill = ({ kind = "", children, nodot }: { kind?: string; children: ReactNode; nodot?: boolean }) => (
  <span className={`pill ${kind}${nodot ? " nodot" : ""}`}>{children}</span>
);

export const Spinner = () => <span className="spinner" aria-hidden="true" />;

/** An on/off switch. `label` is read out by screen readers. */
export const Switch = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button className="switch" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />
);

/** A dialog over the page with a title, body and footer buttons. Escape or the X closes it. `wide` for charts/tables. */
export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-h">
          <h2>{title}</h2>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">
            <Icon n="x" />
          </button>
        </div>
        <div className="panel-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {children}
        </div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

export const fmtDate = (s?: string | null) => {
  if (!s) return "—";
  const d = new Date(s.length === 10 ? s + "T12:00:00" : s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
};
export const fmtTime = (s?: string | null) => (s ? new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
export const usd = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
export const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Renders an answer with [S1] markers styled as citation chips.
/** Renders answer text with each [S1]-style citation shown as a small badge matching the source list. */
export function CitedText({ text }: { text: string }) {
  const parts = text.split(/(\[S\d+\])/g);
  return (
    <span>
      {parts.map((p, i) => (/^\[S\d+\]$/.test(p) ? <span key={i} className="cite">{p.slice(1, -1)}</span> : <span key={i}>{p}</span>))}
    </span>
  );
}
