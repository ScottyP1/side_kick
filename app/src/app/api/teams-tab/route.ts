/**
 * /api/teams-tab: data for Sidekick's tab and personal app inside Microsoft Teams (lib/teams/tab.ts).
 *
 * - GET `?ws=&chat=&meeting=`: the person, their groups, the chosen group's recent meetings and open action items,
 *   and one meeting's notes when `meeting` is given. `chat` (the Teams chat or meeting chat the tab sits in) picks
 *   that chat's linked group by default.
 * - POST `{ action: "done" | "reopen" | "save" | "unsave", id, ws }`: mark an action item done / open, or save a
 *   meeting item to knowledge.
 *
 * Who: a Sidekick user signed in through Teams single sign-on: every request carries the Teams SSO token as
 * `Authorization: Bearer …` (no cookies), checked each time. Walls and roles as in the portal (`requireWorkspace`).
 */
import { handle, readJson } from "@/lib/api";
import { tabAction, tabUser, tabView } from "@/lib/teams/tab";

export const GET = handle(async (req: Request) => {
  const user = await tabUser(req);
  const q = new URL(req.url).searchParams;
  return tabView(user, { ws: q.get("ws"), chat: q.get("chat"), meeting: q.get("meeting") });
});

export const POST = handle(async (req: Request) => {
  const user = await tabUser(req);
  return tabAction(user, await readJson(req));
});
