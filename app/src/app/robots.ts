/**
 * robots.txt: search engines may read the public website and must stay out of the portal, the Owner
 * Console, sign-in, checkout and the API (lib/site.ts `PRIVATE_PATHS`; those pages also say `noindex`).
 * Built per request so the sitemap address comes from SIDEKICK_PUBLIC_URL on the running server, not the build.
 */
import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { PRIVATE_PATHS, siteUrl } from "@/lib/site";

export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();
  return {
    rules: { userAgent: "*", allow: "/", disallow: [...PRIVATE_PATHS] },
    sitemap: siteUrl("/sitemap.xml"),
  };
}
