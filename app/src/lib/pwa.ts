/**
 * @file The installable web app ("PWA"): what the customer portal tells browsers so people can install it with
 * its own window and icon (Chrome/Edge "Install app" on a computer, "Add to Home Screen" on iPhone and Android).
 * Guide: docs/guide/install-app.md.
 *
 * Concepts:
 * - The **manifest** (app/manifest.ts, served at /manifest.webmanifest) names the app, its icons and colors, the
 *   page it opens on (`start_url`, the portal home) and that it opens in its own window (`display: standalone`).
 * - The **scope** is the set of addresses that stay inside the installed window. The portal's pages live at the
 *   top level (/home, /workspaces, /settings…), with no shared folder, so the scope has to be the whole site
 *   ("/"). What we control instead is *where install is offered*: only portal and sign-in pages link the
 *   manifest (the root layout does, via Next's manifest file); the public website and the Owner Console turn
 *   it off with `NOT_INSTALLABLE`, so Chrome never offers to "install" the marketing site, and the Owner
 *   Console (operators only, its own sign-in) stays a normal browser tab. A website page opened from inside the
 *   app (e.g. the help center at /docs) simply shows in the app's window, which is harmless.
 * - **No service worker.** Chrome, Edge and Safari install a site with just a manifest and icons, so Sidekick
 *   registers none: nothing about signed-in pages or API answers is ever stored on the device (privacy between
 *   organizations and between client groups), and sign-in, passkeys and the security headers work exactly as in
 *   a browser tab. When offline, the window shows the browser's own "no connection" page.
 *
 * Who may import it: server layouts and app/manifest.ts. Plain data, no secrets.
 */
import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";

/** Where the installed app opens: the portal home (signed-out people are sent on to /login by proxy.ts). */
export const APP_START_URL = "/home";

/** The addresses that stay inside the installed window: the whole site (see the file comment for why). */
export const APP_SCOPE = "/";

/** The served folder with the app icons (drawn by app/scripts/app-icons.mjs from the brand mark). */
export const APP_ICONS_PATH = "/app-icons";

/**
 * The window colors. `theme` is the title bar (the brand Indigo, BRAND.accent); `background` is the splash screen
 * shown while the app starts on a phone (the portal's light page background, --bg in globals.css).
 */
export const APP_COLORS = { theme: BRAND.accent, background: "#f6f6f9" } as const;

/**
 * Page metadata for portal and sign-in pages: lets iPhone and iPad open a home-screen icon as a full-screen app
 * (`apple-mobile-web-app-capable`), with the short name under the icon and the 180×180 apple-touch-icon.
 * Safari on iOS reads these meta tags rather than the manifest's display/icon fields. Used by app/(app)/layout.tsx
 * and app/(auth)/layout.tsx.
 */
export const INSTALLABLE: Metadata = {
  appleWebApp: { capable: true, title: BRAND.shortName, statusBarStyle: "default" },
  icons: { apple: [{ url: `${APP_ICONS_PATH}/apple-touch-icon.png`, sizes: "180x180", type: "image/png" }] },
};

/**
 * Page metadata for pages that must not offer install (the public website and the Owner Console): drops the
 * manifest link the root layout adds, so browsers don't show "Install app" there. Used by app/(public)/layout.tsx
 * and app/owner/layout.tsx.
 */
export const NOT_INSTALLABLE: Metadata = { manifest: null };
