/**
 * @file What the help assistants may answer from: the "knowledge" of the public help bot and the signed-in
 * support assistant. Never client data: only Sidekick's own help content.
 *
 * Concepts
 * - **Public knowledge** (`knowledgeFor("public")`): the help-center guides (lib/help.ts, by section), the FAQ
 *   (lib/faq.ts), the plans and prices (lib/plans.ts) and **public** support articles. This is all the website's
 *   help bot ever sees, so it can't reveal internal notes or anything about a customer.
 * - **Customer knowledge** (`knowledgeFor("customer")`): the public knowledge plus support articles marked
 *   **customer** (shown to signed-in customers when relevant, never listed). Internal articles are never included.
 * - Each piece has a link where one exists (`/docs/<guide>#<section>`, `/faq#<id>`, `/pricing`,
 *   `/docs/articles/<slug>`), so answers can cite it. Ranking is `rankKnowledge` in lib/search.ts.
 */
import "server-only";
import { FAQ } from "./faq";
import { helpSections } from "./help";
import { PLANS } from "./plans";
import { publishedArticles, type ArticleLevel } from "./support-articles";
import type { KnowledgeDoc } from "./search";

let staticDocs: KnowledgeDoc[] | null = null;

/** The guides, FAQ and plans as knowledge (fixed for the life of the server, so built once). */
function fixedDocs(): KnowledgeDoc[] {
  if (staticDocs) return staticDocs;
  const guides: KnowledgeDoc[] = helpSections()
    .filter((s) => s.text.length > 40)
    .map((s) => ({ key: `guide:${s.slug}#${s.id}`, kind: "guide", title: s.heading === s.guide ? s.guide : `${s.guide}: ${s.heading}`, url: `/docs/${s.slug}${s.id ? `#${s.id}` : ""}`, text: s.text }));
  const faq: KnowledgeDoc[] = FAQ.map((f) => ({ key: `faq:${f.id}`, kind: "faq", title: f.q, url: `/faq#${f.id}`, text: f.a.join(" ") }));
  const plans: KnowledgeDoc[] = PLANS.map((p) => ({
    key: `plan:${p.id}`,
    kind: "pricing",
    title: `${p.name} plan: price and what's included`,
    url: "/pricing",
    text: `${p.name}: ${p.selfService ? `$${p.pricePerSeat} per person per month (test-mode prices, not final)` : "priced per contract by the Sidekick team"}. ${p.blurb} Includes: ${p.features.join("; ")}. Every self-service plan starts with a free trial. Monthly AI credit: ${p.aiCreditUsd === null ? "set per contract" : `$${p.aiCreditUsd}`}.`,
  }));
  staticDocs = [...guides, ...faq, ...plans];
  return staticDocs;
}

/**
 * The knowledge an assistant may use: `public` for the website's help bot, `customer` for the signed-in support
 * assistant (adds customer-level articles). Published articles are read fresh each time, so a newly published
 * article is used straight away.
 */
export async function knowledgeFor(audience: "public" | "customer"): Promise<KnowledgeDoc[]> {
  const levels: ArticleLevel[] = audience === "public" ? ["public"] : ["public", "customer"];
  const articles = (await publishedArticles(levels)).map<KnowledgeDoc>((a) => ({
    key: `article:${a.slug}`,
    kind: "article",
    title: a.title,
    url: a.level === "public" ? `/docs/articles/${a.slug}` : null,
    text: `${a.body} ${a.tags.join(" ")}`,
    articleId: a.id,
  }));
  return [...articles, ...fixedDocs()];
}

/** The numbered sources block for an answer prompt (K1, K2…), with text clipped to keep prompts small. */
export function sourcesBlock(docs: KnowledgeDoc[]): string {
  return docs
    .map((d, i) => `<source id="K${i + 1}" title="${d.title.replace(/["<>]/g, "")}">\n${d.text.replace(/<\/?source[^>]*>/gi, "").slice(0, 1800)}\n</source>`)
    .join("\n");
}
