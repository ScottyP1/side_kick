/**
 * Reserved place for the public "Ask about Sidekick" chat on the website. Rendered by components/public-shell.tsx
 * on every public page, after the footer; it draws nothing today.
 *
 * For the session that builds the chat (docs/ARCHITECTURE.md → Routes): put the widget here, keep it hidden
 * unless it's switched on, answer only from public content (lib/faq.ts, the help-center guides in lib/help.ts,
 * the public pages), and send every question and answer through lib/guardrails.ts like any other answer.
 */

/** The chat widget's slot. Returns nothing until the public chat exists and is switched on. */
export function SiteChatSlot() {
  return null;
}
