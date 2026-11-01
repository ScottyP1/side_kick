/**
 * /live/orb?session=…&sig=…: Sidekick's face in a Teams meeting. Sidekick's meeting bot loads this page in a local browser
 * inside its container and shows it as its camera (lib/live-meetings/orb.ts, docs/LIVE-MEETINGS.md → "Sidekick's
 * camera"). Public (no sign-in: the bot has none) and shows no data, only the crystal ball; the ball's state comes from
 * the signed GET /api/live/bot/orb. Not for people: search engines are told to skip it.
 */
import type { Metadata } from "next";
import { BRAND } from "@/lib/brand";
import OrbCamera from "./view";

export const metadata: Metadata = { title: BRAND.name, robots: { index: false, follow: false } };

export default function Page() {
  return <OrbCamera />;
}
