/**
 * GET /api/live/bot/orb?session=<id>&sig=<signature>&known=<state>&wait=<seconds>: the state of the crystal ball
 * Sidekick's meeting bot shows as its camera (the page /live/orb asks; lib/live-meetings/orb.ts). Answers
 * `{ speaking, thinking, over }` and nothing else about the meeting. A long poll: while the state is still `known`
 * ("idle", "speaking", "thinking", "over") it waits up to `wait` seconds (at most 20) before answering.
 *
 * Who: the page as loaded by that session's bot container. `sig` is the HMAC the page's address carries (`orbSig`); a
 * wrong session or signature is 401 and says nothing.
 */
import { handle } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { orbState } from "@/lib/live-meetings/orb";

export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const wait = Math.min(20, Math.max(0, Number(q.get("wait")) || 0));
  const state = await orbState(q.get("session") ?? "", q.get("sig") ?? "", { waitMs: wait * 1000, known: q.get("known") });
  if (!state) throw new HttpError(401, "Not allowed.");
  return state;
}, { system: "Live meeting camera" });
