/**
 * Sidekick's brand mark: the crystal ball (a white ring and one lavender swirl) on the brand Indigo tile, drawn
 * inline so it costs no request and stays sharp at any size. Same artwork as app/public/brand/tile.svg, the Teams
 * icon and the app icons (scripts/app-icons.mjs). Used in the portal, Owner Console, website and sign-in frames
 * wherever the old "S" letter was. Decorative: the product name always sits next to it, so it's hidden from
 * screen readers. Server or client components may use it (no state, no imports).
 */

/** The mark in a `.brand-mark` tile (30 px by default, from globals.css); `className` adds e.g. "owner-mark". */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={`brand-mark${className ? ` ${className}` : ""}`} aria-hidden="true">
      <svg viewBox="0 0 256 256" width="100%" height="100%" focusable="false">
        <circle cx="128" cy="128" r="96" fill="none" stroke="#FFFFFF" strokeWidth="18" />
        <path d="M44 150 C72 184 101 184 128 160 C155 138 179 125 213 137" fill="none" stroke="#A7A3FF" strokeWidth="28" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
