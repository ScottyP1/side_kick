/**
 * Changelog (/changelog): what's new in Sidekick, newest first, from lib/changelog.ts. Public and static.
 */
import type { Metadata } from "next";
import { PublicShell } from "@/components/public-shell";
import { CHANGELOG } from "@/lib/changelog";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata("/changelog");

export default function ChangelogPage() {
  return (
    <PublicShell layout="full" current="/changelog">
      <div className="site-wrap site-narrow site-page-head">
        <span className="site-eyebrow">Changelog</span>
        <h1>What&apos;s new in Sidekick</h1>
        <p>Every customer-visible change, newest first.</p>
      </div>
      <div className="site-wrap site-narrow site-stack">
        <ol className="site-log">
          {CHANGELOG.map((e) => (
            <li key={e.date}>
              <time dateTime={e.date}>{e.label}</time>
              <div className="site-card">
                <h2 style={{ fontSize: 18 }}>{e.title}</h2>
                <ul>{e.changes.map((c) => <li key={c}>{c}</li>)}</ul>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </PublicShell>
  );
}
