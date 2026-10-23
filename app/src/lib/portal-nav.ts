/**
 * @file The client portal's menu: which pages exist, how they are grouped, who may see each one, and which few
 * go in the phone tab bar. Plain data and pure functions (no React), so the rules are shared by the desktop
 * sidebar, the phone tab bar and the phone menu (components/shell.tsx) and can be unit-tested (tests/db.test.mjs).
 *
 * Concepts:
 * - **Menu items** carry a role check (`allow`). Hiding an item is only a convenience: every page and API checks
 *   the person's role again on the server (lib/auth.ts), so a hidden page typed by hand still refuses.
 * - **Phone tab bar**: on phones (under 860px) the sidebar is replaced by a floating pill bar at the bottom with
 *   up to four destinations (`phoneTabs`) plus the assistant button, and a menu button at the top that opens
 *   everything else. People in a group get Home, Groups, Knowledge and Meetings; someone with no group (a Billing
 *   Admin, or anyone not added to one yet) gets pages they can actually use instead (Usage, Settings, Help).
 *
 * Who may import it: client components (the portal shell) and tests. No secrets, no server-only code.
 */

/** The parts of the signed-in person the menu needs (a subset of `Me["user"]` in components/shell.tsx). */
export type NavUser = { role: string; admin: boolean; lead?: boolean };

/**
 * One menu entry. `label` is shown in the sidebar and phone menu, `short` in the phone tab bar (defaults to
 * `label`), `icon` is a components/ui.tsx `Icon` name, `allow` limits it to some roles (absent = everyone).
 */
export type NavItem = { href: string; label: string; icon: string; short?: string; allow?: (u: NavUser) => boolean };

/** A titled group of menu entries (Overview, Manage, Govern, Help). */
export type NavGroup = { group: string; items: NavItem[] };

const BILLING_ROLES = ["Org Owner", "Org Admin", "Billing Admin"];

/** Every portal page in the menu, in order, with its role rule (the same rules for desktop and phone). */
export const PORTAL_NAV: NavGroup[] = [
  {
    group: "Overview",
    items: [
      { href: "/home", label: "Overview", short: "Home", icon: "home" },
      { href: "/usage", label: "Usage & billing", short: "Usage", icon: "chart", allow: (u) => BILLING_ROLES.includes(u.role) },
      { href: "/agent", label: "AI models & agent", icon: "cpu" },
    ],
  },
  {
    group: "Manage",
    items: [
      { href: "/workspaces", label: "Groups", icon: "folder" },
      { href: "/knowledge", label: "Knowledge & docs", short: "Knowledge", icon: "doc" },
      { href: "/firm-library", label: "Firm library", icon: "library" },
      { href: "/meetings", label: "Meetings", icon: "video" },
      { href: "/memory", label: "Memory & gaps", icon: "brain" },
      { href: "/connectors", label: "Connectors", icon: "plug" },
      { href: "/users", label: "Users & access", icon: "users", allow: (u) => u.admin || Boolean(u.lead) },
    ],
  },
  {
    group: "Govern",
    items: [
      { href: "/guardrails", label: "Guardrails", icon: "shield" },
      { href: "/activity", label: "Activity", icon: "activity", allow: (u) => u.admin },
      { href: "/audit", label: "Security & audit", icon: "lock", allow: (u) => u.admin },
      { href: "/settings", label: "Settings", icon: "gear" },
    ],
  },
  { group: "Help", items: [{ href: "/help", label: "Help & support", short: "Help", icon: "chat" }] },
];

/** The menu this person may see: `PORTAL_NAV` with entries their role can't use removed (and empty groups dropped). */
export function navFor(u: NavUser): NavGroup[] {
  return PORTAL_NAV.map((g) => ({ group: g.group, items: g.items.filter((i) => !i.allow || i.allow(u)) })).filter((g) => g.items.length);
}

/** The most tabs the phone bar shows besides the assistant button (five buttons in all fit a 320px phone). */
export const MAX_PHONE_TABS = 4;

/**
 * The phone tab bar's destinations for this person, in order (at most `MAX_PHONE_TABS`), always a subset of
 * `navFor(u)`. `inGroup` says whether they belong to at least one group (workspace): without one, Knowledge and
 * Meetings would only say "No workspace yet", so they get Usage (if their role pays), Groups (admins, to create
 * one), Settings and Help instead.
 */
export function phoneTabs(u: NavUser, inGroup: boolean): NavItem[] {
  const allowed = new Map(navFor(u).flatMap((g) => g.items).map((i) => [i.href, i]));
  const wanted = inGroup ? ["/home", "/workspaces", "/knowledge", "/meetings"] : ["/home", "/usage", ...(u.admin ? ["/workspaces"] : []), "/settings", "/help"];
  return wanted.flatMap((h) => allowed.get(h) ?? []).slice(0, MAX_PHONE_TABS);
}

/** True when `path` is `href` or a page under it (e.g. /workspaces/abc counts as Groups). */
export function isActive(path: string, href: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}
