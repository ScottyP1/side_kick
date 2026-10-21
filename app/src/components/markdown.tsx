/**
 * Renders a help-center guide (blocks from lib/markdown.ts) as plain React elements: headings with ids you
 * can link to, paragraphs, lists, tables (scroll sideways on a phone instead of widening the page), quotes
 * and code. No HTML strings anywhere, so guide text can never become markup. Server component; used by
 * /docs/[slug].
 */
import Link from "next/link";
import type { Block, Inline, ListItem } from "@/lib/markdown";

/** Inline text: bold, italic, code and links (help-center links stay in the app, web links open normally). */
export function InlineText({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.t === "text") return n.v;
        if (n.t === "code") return <code key={i}>{n.v}</code>;
        if (n.t === "b") return <b key={i}><InlineText nodes={n.c} /></b>;
        if (n.t === "i") return <em key={i}><InlineText nodes={n.c} /></em>;
        return n.href.startsWith("/") || n.href.startsWith("#")
          ? <Link key={i} href={n.href}><InlineText nodes={n.c} /></Link>
          : <a key={i} href={n.href} rel="noopener noreferrer"><InlineText nodes={n.c} /></a>;
      })}
    </>
  );
}

function List({ ordered, items }: { ordered: boolean; items: ListItem[] }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag>
      {items.map((it, i) => (
        <li key={i}>
          <InlineText nodes={it.c} />
          {it.sub && <List {...it.sub} />}
          {it.more?.map((p, j) => <p key={j}><InlineText nodes={p} /></p>)}
        </li>
      ))}
    </Tag>
  );
}

/** One guide's body. Headings below the page title start at h2, so the page keeps a single h1. */
export function MarkdownBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="site-prose">
      {blocks.map((b, i) => {
        if (b.t === "h") {
          const level = Math.min(Math.max(b.level, 2), 4);
          const H = `h${level}` as "h2" | "h3" | "h4";
          return <H key={i} id={b.id}><InlineText nodes={b.c} /></H>;
        }
        if (b.t === "p") return <p key={i}><InlineText nodes={b.c} /></p>;
        if (b.t === "list") return <List key={i} ordered={b.ordered} items={b.items} />;
        if (b.t === "quote") return <blockquote key={i}>{b.c.map((p, j) => <p key={j}><InlineText nodes={p} /></p>)}</blockquote>;
        if (b.t === "code") return <pre key={i}><code>{b.v}</code></pre>;
        return (
          <div key={i} className="table-wrap site-table">
            <table>
              <thead><tr>{b.head.map((c, j) => <th key={j} style={{ textAlign: b.align[j] ?? undefined }}><InlineText nodes={c} /></th>)}</tr></thead>
              <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} style={{ textAlign: b.align[k] ?? undefined }}><InlineText nodes={c} /></td>)}</tr>)}</tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
