/**
 * Support articles in the Owner Console (lib/support-articles.ts). Operators only; every change goes to the
 * operator log.
 * GET → { articles (with uses, tickets, resolved), levels }
 * POST { title, body, level, status?, tags? } → { article }   (create)
 * POST { draftFrom: ticket id } → { article }                  (Claude drafts one from a resolved ticket, saved as a draft)
 * PUT { id, ...fields } → { article }                           (edit, publish or unpublish)
 * DELETE ?id= → { ok }                                         (a seed article is unpublished instead)
 */
import { handle, readJson } from "@/lib/api";
import { platformLog, requireOwner } from "@/lib/owner";
import { createArticle, deleteArticle, draftFromTicket, LEVEL_LABELS, listArticles, updateArticle } from "@/lib/support-articles";

export const GET = handle(async () => {
  await requireOwner();
  return { articles: await listArticles(), levels: LEVEL_LABELS };
});

export const POST = handle(async (req: Request) => {
  const owner = await requireOwner();
  const body = await readJson<Record<string, unknown>>(req);
  if (body.draftFrom !== undefined) {
    const article = await draftFromTicket(body.draftFrom, owner.name);
    await platformLog(owner.name, `Drafted support article “${article.title}” from a resolved ticket`);
    return { article };
  }
  const article = await createArticle(body, owner.name);
  await platformLog(owner.name, `Added support article “${article.title}” (${article.level}, ${article.status})`);
  return { article };
});

export const PUT = handle(async (req: Request) => {
  const owner = await requireOwner();
  const body = await readJson<Record<string, unknown>>(req);
  const { before, after } = await updateArticle(body.id, body, owner.name);
  const changed = (["title", "body", "level", "status"] as const).filter((k) => before[k] !== after[k]);
  await platformLog(owner.name, `Changed support article “${after.title}”${changed.length ? `: ${changed.join(", ")}` : ""}${before.status !== after.status ? ` (now ${after.status})` : ""}`);
  return { article: after };
});

export const DELETE = handle(async (req: Request) => {
  const owner = await requireOwner();
  const article = await deleteArticle(new URL(req.url).searchParams.get("id"));
  await platformLog(owner.name, `${article.seed ? "Unpublished" : "Deleted"} support article “${article.title}”`);
  return { ok: true };
});
