/**
 * GET/DELETE /api/auth/sessions: where you're signed in (Settings → Where you're signed in).
 * - GET (anyone signed in): your own sessions: browser, network address, when started and last used, and
 *   which one is this browser. Only your own; nobody sees anyone else's.
 * - DELETE { id }: signs out that one session. DELETE {} (no id): signs out everywhere except this browser.
 *   Audited. Only ever touches the caller's own sessions.
 */
import { handle, readJson } from "@/lib/api";
import { audit, endOtherSessions, endSessionById, HttpError, listSessions, requireUser } from "@/lib/auth";

export const GET = handle(async () => {
  const user = await requireUser();
  return { sessions: await listSessions(user) };
});

export const DELETE = handle(async (req: Request) => {
  const user = await requireUser();
  const { id } = await readJson<{ id?: string }>(req);
  if (id) {
    if (!(await endSessionById(user.id, String(id)))) throw new HttpError(404, "That session has already ended.");
    await audit(user, "Signed out one of their other sessions", "Sign-in");
    return { ok: true, ended: 1 };
  }
  const ended = await endOtherSessions(user.id);
  await audit(user, `Signed out everywhere else (${ended} ${ended === 1 ? "session" : "sessions"})`, "Sign-in");
  return { ok: true, ended };
});
