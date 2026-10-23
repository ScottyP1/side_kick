/**
 * The web app manifest, served at /manifest.webmanifest (Next's manifest file convention): what lets people install
 * the customer portal as an app with its own window and icon. Names come from lib/brand.ts, the start page, scope,
 * colors and icons from lib/pwa.ts (which explains the scope and why there is no service worker). Next links it
 * from every page's <head>; the public website and Owner Console layouts remove that link (`NOT_INSTALLABLE`).
 *
 * Public: browsers fetch it without cookies, so proxy.ts lets it (and /app-icons/) through without a session.
 * Static: built once at `next build`; it holds no per-user or per-organization data.
 */
import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";
import { APP_COLORS, APP_ICONS_PATH, APP_SCOPE, APP_START_URL } from "@/lib/pwa";

/** The manifest object (MetadataRoute.Manifest, the Web App Manifest spec). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: APP_START_URL,
    name: BRAND.name,
    short_name: BRAND.shortName,
    description: BRAND.tagline,
    start_url: APP_START_URL,
    scope: APP_SCOPE,
    display: "standalone",
    theme_color: APP_COLORS.theme,
    background_color: APP_COLORS.background,
    categories: ["business", "productivity"],
    icons: [
      { src: `${APP_ICONS_PATH}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `${APP_ICONS_PATH}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `${APP_ICONS_PATH}/maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
