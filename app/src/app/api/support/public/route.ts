/**
 * POST /api/support/public: a support request from the website, no sign-in: the /support form, or the help
 * bot's "Talk to a human" (`conversation` = the visitor's help bot conversation, added to the ticket already
 * masked). Body: { name, email, subject, description, category?, phone?, page?, website (honeypot, leave
 * empty), conversation? } → { ok: true, ref } (ref is missing when the honeypot caught a bot).
 * Limited per network address (lib/support.ts `PUBLIC_PER_HOUR`).
 */
import { handle, readJson } from "@/lib/api";
import { clientIp } from "@/lib/login-limit";
import { createPublicTicket } from "@/lib/support";
import { visitorTranscript } from "@/lib/helpbot";

export const POST = handle(async (req: Request) => {
  const body = await readJson<Record<string, unknown>>(req);
  const transcript = body.conversation ? await visitorTranscript(body.conversation) : "";
  const out = await createPublicTicket(body, await clientIp(), { source: transcript ? "helpbot" : "public", transcript: transcript || undefined });
  return { ok: true, ref: out?.ref };
}, { system: "public support form" });
