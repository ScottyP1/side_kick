"use client";

/**
 * Last-resort crash screen, for when the whole app frame (root layout) fails. It replaces the page
 * entirely, so it carries its own minimal styles (the app's stylesheet isn't loaded here).
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0f1416", color: "#e8eceb", display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <title>Sidekick – something went wrong</title>
        <div role="alert" style={{ maxWidth: 440, padding: 28, textAlign: "center", lineHeight: 1.5 }}>
          <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Sidekick hit a problem</h1>
          <p style={{ margin: "0 0 16px", opacity: 0.85 }}>The app couldn&apos;t load. Your data is safe. Try again in a moment; if it keeps happening, contact the Sidekick team.</p>
          {error.digest && (
            <p style={{ margin: "0 0 16px", fontSize: 13, opacity: 0.75 }}>
              Reference code: <b style={{ fontFamily: "ui-monospace, monospace" }}>{error.digest}</b>
            </p>
          )}
          <button onClick={() => retry()} style={{ background: "#0f6b5c", color: "#fff", border: 0, borderRadius: 8, padding: "10px 18px", fontSize: 15, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
