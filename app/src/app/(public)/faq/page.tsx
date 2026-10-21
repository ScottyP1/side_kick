/**
 * FAQ (/faq): every common question about Sidekick in plain words, from lib/faq.ts (the same answers the
 * Pricing, Security & trust and How it works pages show in part). Public and static.
 */
import Link from "next/link";
import type { Metadata } from "next";
import { FaqList } from "@/components/faq-list";
import { PublicShell } from "@/components/public-shell";
import { FAQ } from "@/lib/faq";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata("/faq");

export default function FaqPage() {
  return (
    <PublicShell layout="full" current="/faq">
      <div className="site-wrap site-narrow site-page-head">
        <span className="site-eyebrow">FAQ</span>
        <h1>Questions people ask before they start</h1>
        <p>What Sidekick sees, where your data lives, how setup works and what happens with billing. Click a question to open it.</p>
      </div>
      <div className="site-wrap site-narrow site-stack">
        <FaqList items={[...FAQ]} />
        <div className="callout info" role="note">
          <span>Something else? The <Link href="/docs">help center</Link> has the full guides, or <Link href="/support">contact support</Link>.</span>
        </div>
      </div>
    </PublicShell>
  );
}
