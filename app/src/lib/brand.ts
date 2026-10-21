/**
 * @file The product's name and brand, in one place, so a rename is one edit here.
 *
 * Everything people read uses these values: page titles and site metadata (app/layout.tsx and each page's
 * `metadata`), the portal, Owner Console and website frames, Teams cards and the help bot, notices and
 * certificates, and the Teams app package (scripts/teams-package.mjs reads this file directly, which works
 * because it's plain data with erasable types only and no imports).
 *
 * Not renamed by changing this: code identifiers, table and cookie names (`sk_session`), Azure resource
 * names (`sidekick-app`), environment variables (`SIDEKICK_*`) and the docs' history. A test checks that
 * the Teams manifest and page titles use `BRAND.name`.
 *
 * Who may import it: anyone (server, client components, scripts). Keep it free of imports and secrets.
 */

/** The brand: names, the one-line pitch, contact and logo files. */
export const BRAND = {
  /** The product's name, as in sentences and titles ("Sidekick"). */
  name: "Sidekick",
  /** Short name where space is tight (Teams app short name, phone home screen); at most 30 characters. */
  shortName: "Sidekick",
  /** One line about what it is, for page descriptions and the Teams app's full name. */
  tagline: "AI teammate for client teams",
  /** Where customers write for help (placeholder until there's a real mailbox). */
  supportEmail: "support@sidekick.example",
  /** The Teams app icons (repo-relative, used by the Teams package) and the site favicon (served path). */
  logo: { teamsColor: "teams/color.png", teamsOutline: "teams/outline.png", favicon: "/favicon.ico" },
  /** The brand color (Indigo, approved Oct 20, 2026): Teams accent color; the portal's tokens are in globals.css. */
  accent: "#4F46E5",
} as const;

/** "Usage & billing · Sidekick": a page title with the product's name. */
export const pageTitle = (page?: string) => (page ? `${page} · ${BRAND.name}` : `${BRAND.name}: ${BRAND.tagline}`);

/** "Sidekick team": how the people who run the service sign changes they make for a client. */
export const TEAM_NAME = `${BRAND.name} team`;
