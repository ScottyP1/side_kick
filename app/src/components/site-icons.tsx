/**
 * Small line icons for the public website's feature cards (inline SVG, no image files, so nothing for the
 * Content-Security-Policy to block). Decorative: always hidden from screen readers.
 */

const PATHS: Record<string, string> = {
  answer: "M4 5h16v11H8l-4 4zM8 9h8M8 12h5",
  notes: "M6 3h9l3 3v15H6zM9 9h6M9 13h6M9 17h4",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4",
  groups: "M3 7h7v7H3zM14 7h7v7h-7zM8 17h8",
  audit: "M5 4h14v16H5zM8 8h8M8 12h8M8 16h5",
  lock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3",
  cloud: "M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-1 9z",
  teams: "M4 6h11v12H4zM8 10h3M9.5 10v5M17 9h3v7a3 3 0 0 1-3 3",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  people: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 6",
  map: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14",
};

/** One icon by name (see PATHS), in the accent-tinted square used on the feature cards. */
export function SiteIcon({ name }: { name: keyof typeof PATHS | string }) {
  return (
    <span className="site-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d={PATHS[name] ?? PATHS.spark} /></svg>
    </span>
  );
}
