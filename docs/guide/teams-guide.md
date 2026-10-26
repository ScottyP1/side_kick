# Sidekick in Teams

Sidekick works inside Microsoft Teams group chats, channels and 1:1 chats. It answers from **one client workspace** (the one the chat or channel is linked to), posts meeting notes after each meeting, and, where an admin turned it on, keeps track of the chat and reminds the team about what's still open.

## Getting started
1. Add Sidekick where your team works:
   - **Group chat**: open the chat, click **+** or **⋯ → Manage apps** at the top, add **Sidekick**.
   - **Channel**: on the team, **⋯ → Manage team → Apps**, add **Sidekick**.

   Teams asks the chat or team owner to let Sidekick **read messages** there. Accept it: that's what lets Sidekick follow the chat once it's assigned to a group (it reads nothing before that, and announces it when it starts).
2. Sidekick posts one notice: **"I'm not set up for this chat yet. A Team Lead needs to assign this chat to a group in the Sidekick portal."** Until then it doesn't read, save or answer anything there (mentioning it just repeats the notice).
3. The Team Lead (or an admin) assigns the chat to a group in the portal. Sidekick then says it's assigned and from then on reads every message in the chat. Assigning happens only in the portal; `@Sidekick link` just shows which group a chat belongs to.

**Who can add Sidekick:** only Team Leads and admins. If anyone else adds it, Sidekick posts "Only a Team Lead or admin can add me to a chat, so I'm leaving" and removes itself. A chat nobody assigns within 7 days is left too, with a short goodbye.

**"I don't know you in Sidekick yet."** Sidekick recognises you by your Microsoft account. If an admin added you on Users & access with your work email, Sidekick matches you by that email the first time you add it to a chat (when your organization approved Sidekick reading its directory). If it still can't place you, it says "I don't know you in Sidekick yet. Ask your Sidekick admin to add you, then sign in to the Sidekick portal with Microsoft once and add me again." It doesn't leave: once you're set up, mention @Sidekick in that chat (or remove it and add it again) and it continues as a normal add.

**Removed it and added it back?** Removing Sidekick from a chat in Teams makes it forget a chat that wasn't assigned yet; adding it again starts afresh, so the chat shows up under **Assign a chat** again.

**Assigning it in the portal:** on the group's page, **Teams chats → Assign a chat** lists the chats waiting to be assigned (the chat's name, who added Sidekick and when, and who's in it). Pick one and click **Assign**. Nothing listed? Add Sidekick to the chat in Teams first; it shows up there. A Team Lead sees the chats they added; Org Owners and Org Admins see all of them.

If your organization hasn't connected Microsoft sign-in to Sidekick yet (and in 1:1 chats, or a chat in another company's Microsoft 365), Sidekick shows an 8-character **link code** instead, which a Team Lead or admin enters on the group's page (**Teams chats → Assign a chat**; with Microsoft sign-in connected it's under **Linking a chat from another organization?**).

**Your organization isn't on Sidekick yet?** Sidekick replies "Sidekick isn't set up for your organization yet" with a link to sign up, and reads or keeps nothing from that chat.

### Group chat or channel?
Both work the same for Sidekick; use whatever your team already uses.
- **Group chat**: one running conversation. Sidekick's answers, notes, action-item cards and reminders appear in the chat in order.
- **Channel**: posts with replies. Meeting notes are a new post and their action items go in that post's thread; reminders are a new post; answers are replies to the post that mentioned Sidekick.
- **Meeting chats** (the chat of a scheduled Teams meeting): Teams doesn't offer Sidekick there yet (it needs a meeting tab). This is coming with **automatic meeting notes**; until then, use the team's group chat or channel for notes.
- **Names on a group's Teams chats tab**: a group chat shows its name if someone gave it one. A channel shows as "Team › Channel"; a team's first channel shows only the team name until it's renamed, because Teams doesn't tell apps that channel's name (it's "General" unless someone renamed it).

## Asking questions
Mention Sidekick with your question:

> @Sidekick when is the wave 2 cutover and how many stores are in it?

Pick **Sidekick** from the list Teams shows while you type `@Sidek…`, so the name turns into a highlighted mention. If you just type "@Sidekick" without picking it, Teams doesn't treat it as a mention: Sidekick usually still answers when the message *starts* with "@Sidekick" (it can read the chat's messages since version 1.1.0 of the app), but picking it from the list always works.

In a 1:1 chat with Sidekick you don't need the mention. You get a card with:
- the answer, with citations like **[S1]**;
- each source: the document or meeting, the page or timestamp, and a short excerpt.

If the workspace doesn't contain the answer, Sidekick says so instead of guessing, and logs it as a knowledge gap for the team to fill.

Answers also use your organization's **firm library** (policies, standards, templates); those sources show as **Firm policy · <title>**. If sources disagree, the card says so and cites both. Each card has **👍 Helpful** and **👎 Not helpful** buttons: only your vote is recorded (no text), and your admins see the counts.

### Follow-up questions
Sidekick remembers your last few questions, so you can ask a short follow-up:

> @Sidekick when is the wave 2 cutover?
> @Sidekick and wave 3?

- **In a channel**: reply in the **same thread**. A new post starts a new conversation.
- **In a group chat or a 1:1 chat**: ask within **30 minutes** of the last answer. After that a message is treated as a new question.
- The card shows **Following up on: "…"** when it built on an earlier question.
- `@Sidekick new question` forgets the earlier questions; `@Sidekick new question <your question>` asks afresh straight away.

It's your conversation only (each person has their own), in that chat's group only, and it's forgotten after 24 hours. Guardrails check every follow-up, so a refused question stays refused however it's rephrased.

Your organization's **guardrails** apply in Teams exactly as in the portal. A question that breaks them (abuse, trying to get Sidekick to drop its rules, asking about another client, something your Org Owner switched off, or one of your organization's or workspace's custom rules) gets a short, polite refusal card instead of an answer.

## Meeting notes
With **automatic notes** on, Sidekick writes the notes after every Teams meeting of a group's people (from the meeting's transcript; no bot joins the call) and posts them to the group's **notes chat**. Meetings added in the portal (**Add a past or outside meeting**) are posted the same way. **Sidekick live in meetings** (Enterprise) is coming later. Details: [Meetings and automatic notes](meetings.md).

After each meeting, Sidekick posts:
1. a **notes card**: summary, the decisions and things to keep (each with **Save to knowledge**), and questions still open, with **Open in Sidekick** for the full notes;
2. one **card per action item** (in a group chat they follow the notes; in a channel they're replies in the notes post's thread).

On an action-item card:
- **Assign**: type a name, click Assign. Open items move to *In progress*.
- **Mark done**: closes it. **Reopen** brings it back.

On the notes card, **Save to knowledge** keeps a decision, requirement, risk, fact or term as lasting group knowledge (answers find it first from then on); the card shows who saved it, with **Undo**. Viewers can't save.

Changes show on the card for everyone, in the portal's tracker, and in the audit log under your name.

## The Sidekick tab
Open Sidekick in the Teams app bar → **Meetings**, or add it as a tab to a chat, channel or meeting (**+** at the top). It shows the group's meetings, their notes and open action items, signed in with your Microsoft account. Adding it to a meeting also brings Sidekick into the meeting chat, so its notes can go to the right group.

## Reminders
In chats where an Org Admin turned **Reminders** on, Sidekick posts a short **reminder card** once a day (at the chosen time, not on quiet days such as weekends). After a meeting there's no second card in the chat that got the notes: the notes card ends with one line such as "3 older items still open: Open in Sidekick" (leaving out what today's reminder already listed). A chat that doesn't get the group's notes gets a reminder card after each meeting instead, if *After meetings* is on. The reminder card lists up to six things that are still open:
- action items that are **overdue** or have **no owner**;
- **open questions** and **decisions still to make** that are due (or have been open for a week);
- documents that look **out of date** compared with newer meetings or chat messages (for example the runbook says Nov 5 but the cutover moved to Nov 12);
- **sources that disagree**.

Every point says where it comes from (the meeting, document or chat, with its date). Sidekick never posts a point it can't back up with a source, and it posts nothing when there's nothing to remind about.

Buttons on each point:
- **Assign** (action items): type a name. **Mark done**: closes the action item, answers the question or decision, or resolves the knowledge gap.
- **Snooze**: hides it from reminders for a week. **Not relevant**: hides it for good.

Changes show on the card for everyone and go in the audit log under your name. A Viewer can't change items.

## Chats Sidekick keeps track of
Chats assigned to a group in the portal (in an organization with Microsoft sign-in connected) are always tracked: assigned means full access, and Sidekick announces it when the chat is assigned. To stop it, a Team Lead or admin removes Sidekick from the chat. In chats linked with a code, an admin chooses:

An Org Admin can switch **Keep track of every message** on for a channel or group chat. Sidekick then posts a notice in that chat, reads every message there (not only @mentions) and remembers them for 90 days, so it can answer from them and notice when plans change. It doesn't reply to messages that don't mention it. Only the linked workspace's team can search what it learned; in a chat with client guests, what's said there counts as Shareable. When the switch is turned off, Sidekick says so in the chat; when the chat is unlinked, the saved messages are deleted.

## Who you are in Teams
Once you've signed in to the Sidekick portal with Microsoft, Sidekick recognises you in Teams too: your questions and card clicks count under your Sidekick name and role. A **Viewer** can ask questions but can't assign or close action items. People in a linked chat who don't have a Sidekick account can still ask and use the cards, for that chat's workspace only.

## Adding people from the chat
In a chat linked to a workspace, the workspace's **Team Lead** or an **Org Admin** can manage who's in it without leaving Teams:

> @Sidekick add @Maria Lopez
>
> @Sidekick remove @Maria Lopez

Pick each person from Teams' mention list (so they become real mentions). Sidekick replies with a card saying what it did for each person:
- **add**: puts them in this chat's workspace. Someone who isn't in Sidekick yet gets an account as a **Member** who signs in with their Microsoft work account (no password to hand out). Guests from other companies can't be added (they can still ask questions in the chat), and Org Owners and Org Admins already see every workspace.
- **remove**: takes them off this workspace only; their Sidekick account stays (an Org Admin removes accounts on Users & access). Nobody can take themselves off, and a Team Lead only adds or removes Members and Viewers.

Sidekick needs to know who's asking: sign in to the Sidekick portal with Microsoft once. Anyone else gets a polite "only this group's Team Lead or an Org Admin can…". Every change is in the audit log ("… from Teams").

## Choosing where meeting notes go, from the chat
In one of a group's chats, its **Team Lead** (or an **Org Owner/Admin**) can type `@Sidekick post meeting notes here` (or "notes here", "send meeting notes here") to send the group's meeting notes to this chat, or `@Sidekick stop posting notes here` to stop. Sidekick replies "Done ✓ Meeting notes for *group* will be posted here." Anyone else gets "Only the Team Lead or an admin can change where notes go." In a chat with client guests it works too, but notes of internal-only meetings never go there (Sidekick says so). It's the same choice as **Meeting notes go to** in the portal, and it's in the audit log. Details: [Meetings and automatic notes](meetings.md#the-notes-chat-in-teams).

**Reminders to start transcription.** When someone starts a call in one of a group's chats (**Meet now** or the call button) and nobody has started transcription after about two minutes, Sidekick posts one short card: "Turn on transcription? … **More (…) → Record and transcribe → Start transcription** …". Without a transcript there are no notes. The Team Lead can type `@Sidekick stop transcription reminders` to switch these off for the group (or switch them off on the group's **Teams chats** tab). Details: [Getting a transcript every time](meetings.md#getting-a-transcript-every-time).

## Commands
| Type | Does |
|---|---|
| `@Sidekick <question>` | Answer with sources (a follow-up builds on your last question: same thread in a channel, within 30 minutes in a chat) |
| `@Sidekick new question` | Start afresh: forget your earlier questions here (add a question to ask it straight away) |
| `@Sidekick link` | Show the link code, or which workspace this chat is linked to |
| `@Sidekick add @name` | Add someone to this chat's workspace (Team Lead or Org Admin) |
| `@Sidekick remove @name` | Take someone off this chat's workspace (Team Lead or Org Admin) |
| `@Sidekick post meeting notes here` | Send this group's meeting notes to this chat (Team Lead or admin) |
| `@Sidekick stop posting notes here` | Stop sending meeting notes to this chat (Team Lead or admin) |
| `@Sidekick stop transcription reminders` | No more "Turn on transcription?" reminders in this group's calls (Team Lead or admin; `start transcription reminders` turns them back on) |
| `@Sidekick help` | Show what Sidekick can do here |

## What Sidekick can and can't see
- It only reads messages that mention it (every message in a 1:1 chat with it), unless an admin turned on **Keep track of every message** for that chat (Sidekick announces it there).
- Meeting notes go only to the chat(s) the group's Team Lead chose under **Meeting notes go to** (one chat until someone chooses); the notes card says where it was posted.
- It only answers from the linked workspace and your organization's firm library. It never uses other workspaces or other clients' material.
- In chats and channels marked as having **client guests**, it only uses documents tagged *Shareable* (group and firm library), never posts notes from internal-only meetings there, and only reminds about items whose every source is Shareable.
- If the chat or channel is unlinked, Sidekick stops answering and posting there until it's linked again.
