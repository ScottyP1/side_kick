/**
 * The place on every public page (rendered by components/public-shell.tsx after the footer) for "Ask about
 * Sidekick", the website's help bot (components/helpbot.tsx, rules in lib/helpbot.ts).
 *
 * Always shown: the pages are prerendered, so the slot can't ask the server whether the bot is switched on.
 * When the Owner Console's "Public help bot" switch is paused (or its daily budget is spent), the bot answers
 * with matching FAQ entries and "Talk to a human" instead of AI answers.
 */
import { HelpBotDock } from "./helpbot";

/** The help bot's button and panel. */
export function SiteChatSlot() {
  return <HelpBotDock />;
}
