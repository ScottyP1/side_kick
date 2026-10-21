/**
 * @file The public website's map: which pages exist, what each is called, what search engines may see, and
 * the page metadata (title, description, Open Graph) they share. Pure data and small helpers with no I/O, so
 * the website pages, the header and footer (components/public-shell.tsx), `robots.txt`, `sitemap.xml` and the
 * tests all read the same list.
 *
 * Concepts
 * - **Public page**: needs no sign-in. Listed here, in the sitemap, and skipped by the sign-in check in
 *   `src/proxy.ts` (its `matcher` names the same paths; a test checks every page here answers without a session).
 * - **Private path**: the client portal, the Owner Console, checkout and the API. Never in the sitemap,
 *   disallowed in `robots.txt`, and the pages carry `noindex`.
 * - **Route split**: `/` is the website for visitors; anyone with a portal session cookie who opens `/` is
 *   sent to the portal home at `/home` by the proxy (docs/ARCHITECTURE.md → Routes).
 * - **Site address**: `SIDEKICK_PUBLIC_URL` (the same setting Microsoft sign-in and Teams links use), read
 *   at request time; the live address is never written in the repo.
 */
import type { Metadata } from "next";
import { BRAND } from "./brand";

/** One public page: its path and how it appears in search results and link previews. */
export type PublicPage = { path: string; title: string; description: string };

/** Every public page with fixed content, in sitemap order. Help-center guides are added by `lib/help.ts`. */
export const PUBLIC_PAGES: readonly PublicPage[] = [
  { path: "/", title: `${BRAND.name}: the AI teammate for your team in Microsoft Teams`, description: `${BRAND.name} answers your team's questions in Microsoft Teams with sources, writes meeting notes and reminds the chat about what's due. One walled-off group per client engagement.` },
  { path: "/features", title: `Features · ${BRAND.name}`, description: `Answers with sources, meeting notes and action items, reminders, guardrails, groups per client and an audit log: what ${BRAND.name} does for your team in Microsoft Teams.` },
  { path: "/how-it-works", title: `How it works · ${BRAND.name}`, description: `Sign up, approve ${BRAND.name} for Microsoft 365, install it in Teams, create a group per client with its Team Lead and pick the chats. The setup wizard walks you through it.` },
  { path: "/security", title: `Security & trust · ${BRAND.name}`, description: "Walls between companies and between client groups, guardrails on every answer, an audit log, hosting in Microsoft Azure and encryption in transit. Powered by Claude." },
  { path: "/pricing", title: `Plans and pricing · ${BRAND.name}`, description: `${BRAND.name}'s plans, priced per organization by groups (one per client engagement), each with a free trial.` },
  { path: "/faq", title: `FAQ · ${BRAND.name}`, description: `Plain answers to common questions: what ${BRAND.name} can see, where data lives, AI training, Microsoft 365 permissions, Teams setup, billing and cancelling.` },
  { path: "/docs", title: `Help center · ${BRAND.name}`, description: `Guides for using ${BRAND.name}: concepts, setting up your organization, ${BRAND.name} in Teams, and roles and permissions.` },
  { path: "/support", title: `Support · ${BRAND.name}`, description: `How to get help with ${BRAND.name} and answers to common questions.` },
  { path: "/changelog", title: `Changelog · ${BRAND.name}`, description: `What's new in ${BRAND.name}, release by release.` },
  { path: "/signup", title: `Sign up · ${BRAND.name}`, description: `Create your organization's ${BRAND.name} account and start a free trial.` },
  { path: "/privacy", title: `Privacy policy (draft) · ${BRAND.name}`, description: `How ${BRAND.name} handles your data. A plain-language draft for legal review.` },
  { path: "/terms", title: `Terms of use (draft) · ${BRAND.name}`, description: `The terms for using ${BRAND.name}. A plain-language draft for legal review.` },
];

/** The main links in the public header, in order (Sign in and Get started are separate buttons). */
export const SITE_NAV: readonly { href: string; label: string }[] = [
  { href: "/features", label: "Features" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/security", label: "Security" },
  { href: "/pricing", label: "Pricing" },
  { href: "/faq", label: "FAQ" },
  { href: "/docs", label: "Help" },
];

/**
 * Paths search engines are told to stay out of: every client-portal page (src/app/(app)/*), sign-in and
 * setup, checkout, the Owner Console and the API. A test checks every portal folder is listed here.
 */
export const PRIVATE_PATHS: readonly string[] = [
  "/home", "/activity", "/agent", "/audit", "/connectors", "/get-started", "/guardrails", "/help", "/knowledge",
  "/meetings", "/memory", "/settings", "/usage", "/users", "/workspaces",
  "/login", "/setup", "/checkout", "/owner", "/api/",
];

/** The page with this path from `PUBLIC_PAGES` (throws for a path that isn't there, to catch typos at build). */
export function publicPage(path: string): PublicPage {
  const page = PUBLIC_PAGES.find((p) => p.path === path);
  if (!page) throw new Error(`Not a public page: ${path}`);
  return page;
}

/**
 * Page metadata for a public page: title, description and the Open Graph basics for link previews (no
 * image yet, so no absolute address is needed). Use as `export const metadata = pageMetadata("/features")`.
 */
export function pageMetadata(path: string): Metadata {
  return metadataFor(publicPage(path));
}

/** The same metadata for any title and description (help-center guides use it with their own text). */
export function metadataFor({ title, description }: { title: string; description: string }): Metadata {
  return { title, description, openGraph: { title, description, siteName: BRAND.name, type: "website", locale: "en_US" } };
}

/** Metadata for pages search engines should skip (portal, Owner Console, sign-in, checkout). */
export const NOINDEX: Metadata = { robots: { index: false, follow: false } };

/** The site's own address for `path` (from SIDEKICK_PUBLIC_URL, or localhost on a laptop). Server only. */
export function siteUrl(path = "/"): string {
  return `${(process.env.SIDEKICK_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "")}${path}`;
}
