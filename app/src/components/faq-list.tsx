/**
 * Questions and answers from lib/faq.ts as native <details> elements (open and close without JavaScript, so
 * they work under the Content-Security-Policy and with a keyboard). Used by /faq and by the short FAQ
 * sections on Pricing, Security & trust and How it works.
 */
import Link from "next/link";
import type { FaqItem } from "@/lib/faq";

/** The list of questions; each has an id so /faq#<id> links work. `title` adds a heading above it. */
export function FaqList({ items, title }: { items: FaqItem[]; title?: string }) {
  return (
    <section className="site-faq" aria-label={title ?? "Frequently asked questions"}>
      {title && <h2>{title}</h2>}
      {items.map((f) => (
        <details key={f.id} id={f.id}>
          <summary>{f.q}</summary>
          <div>
            {f.a.map((p) => <p key={p}>{p}</p>)}
            {f.legalReview && <p className="site-faq-note">Draft wording, pending legal review.</p>}
            {f.guide && <p><Link href={f.guide}>More in the help center →</Link></p>}
          </div>
        </details>
      ))}
    </section>
  );
}
