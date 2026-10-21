/**
 * sitemap.xml: every public page (lib/site.ts `PUBLIC_PAGES`) and every public help-center guide
 * (lib/help.ts), and nothing else: never the portal, Owner Console, checkout or API. Built per request so
 * the addresses use SIDEKICK_PUBLIC_URL from the running server (the live address is never in the repo).
 */
import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { guides } from "@/lib/help";
import { PUBLIC_PAGES, siteUrl } from "@/lib/site";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  return [
    ...PUBLIC_PAGES.map((p) => ({ url: siteUrl(p.path), changeFrequency: "weekly" as const, priority: p.path === "/" ? 1 : 0.7 })),
    ...guides().map((g) => ({ url: siteUrl(`/docs/${g.slug}`), changeFrequency: "weekly" as const, priority: 0.5 })),
  ];
}
