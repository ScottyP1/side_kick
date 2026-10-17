# Sidekick in Teams

Sidekick works inside Microsoft Teams channels, group chats and 1:1 chats. It answers from **one client workspace** (the one the channel is linked to) and posts meeting notes after each meeting.

## Getting started in a channel
1. Add Sidekick to the team or chat (Apps → Sidekick → Add).
2. Mention it: `@Sidekick link`. If the channel isn't linked yet, Sidekick replies with an 8-character code.
3. Ask an Org Admin to enter that code in the Sidekick portal (**Workspaces → Link Teams channel**). Sidekick confirms in the channel when it's done.

## Asking questions
Mention Sidekick with your question:

> @Sidekick when is the wave 2 cutover and how many stores are in it?

In a 1:1 chat with Sidekick you don't need the mention. You get a card with:
- the answer, with citations like **[S1]**;
- each source: the document or meeting, the page or timestamp, and a short excerpt.

If the workspace doesn't contain the answer, Sidekick says so instead of guessing, and logs it as a knowledge gap for the team to fill.

## Meeting notes
After a meeting transcript is imported for the workspace, Sidekick posts:
1. a **notes card**: summary, decisions and questions still open, with **Open in Sidekick** for the full notes;
2. one **card per action item** (in channels, as replies in the notes thread).

On an action-item card:
- **Assign**: type a name, click Assign. Open items move to *In progress*.
- **Mark done**: closes it. **Reopen** brings it back.

Changes show on the card for everyone, in the portal's tracker, and in the audit log under your name.

## Who you are in Teams
Once you've signed in to the Sidekick portal with Microsoft, Sidekick recognises you in Teams too: your questions and card clicks count under your Sidekick name and role. A **Viewer** can ask questions but can't assign or close action items. People in a linked chat who don't have a Sidekick account can still ask and use the cards, for that chat's workspace only.

## Commands
| Type | Does |
|---|---|
| `@Sidekick <question>` | Answer with sources |
| `@Sidekick link` | Show the link code, or which workspace this chat is linked to |
| `@Sidekick help` | Show what Sidekick can do here |

## What Sidekick can and can't see
- It only reads messages that mention it (every message in a 1:1 chat with it). It doesn't read the rest of the channel.
- It only answers from the linked workspace. It never uses other workspaces or other clients' material.
- In channels marked as having **client guests**, it only uses documents tagged *Shareable*, and never posts notes from internal-only meetings there.
- If the channel is unlinked, Sidekick stops answering and posting there until it's linked again.
