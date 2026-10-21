"use client";

/**
 * The help center's search box (/docs). Filters the guide sections it's given (lib/help.ts `helpSections`,
 * rendered into the page by the server) as you type, entirely in the browser: no request, no tracking. Each
 * hit links to the guide at that heading. Until something is typed, the page's list of guides shows instead.
 */
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { searchHelp, type HelpSection } from "@/lib/help-search";

/** Search over `sections`; `children` (the guide list) shows while the box is empty. */
export function HelpSearch({ sections, children }: { sections: HelpSection[]; children: React.ReactNode }) {
  const [q, setQ] = useState("");
  const id = useId();
  const hits = useMemo(() => searchHelp(sections, q), [sections, q]);
  const snippet = (s: HelpSection) => {
    const text = s.text;
    const at = text.toLowerCase().indexOf(q.trim().toLowerCase().split(/\s+/)[0] ?? "");
    const start = Math.max(0, at - 60);
    return (start ? "…" : "") + text.slice(start, start + 180) + (text.length > start + 180 ? "…" : "");
  };
  return (
    <div className="site-search">
      <label htmlFor={id} className="eyebrow">Search the guides</label>
      <input id={id} className="input" type="search" placeholder="e.g. Team Lead, link a chat, read-only" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {q.trim() ? (
        <>
          <p className="muted" style={{ margin: 0 }} role="status">{hits.length ? `${hits.length}${hits.length === 12 ? "+" : ""} result${hits.length === 1 ? "" : "s"}` : "Nothing found. Try fewer or different words, or ask Support."}</p>
          <ul className="site-results">
            {hits.map((s) => (
              <li key={`${s.slug}#${s.id}`}>
                <Link href={`/docs/${s.slug}${s.id ? `#${s.id}` : ""}`}>
                  <small>{s.guide}</small>
                  <b>{s.heading}</b>
                  {s.text && <span>{snippet(s)}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : children}
    </div>
  );
}
