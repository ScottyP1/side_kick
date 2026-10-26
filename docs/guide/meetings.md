# Meetings and automatic notes

Sidekick writes the notes for your group's meetings: a short summary, the **decisions**, **action items** (with owners and dates as spoken), **open questions**, and lasting facts like requirements, risks and terms. Notes land in the right group in the portal, are posted to the group's notes chat in Teams, and answers can use them straight away.

**Action items are commitments, however they were said.** Nobody needs to say "action item". "I'll send it over", "let me check with finance", "leave it with me", or a "yes" / "on it" to someone's request all count, and the owner is the person who took it on. Ideas that were only floated ("maybe we could…") aren't action items unless someone then takes them on. A plan to look at something again ("let's review this again in two weeks") is an action item with its date (two weeks after the meeting), not a decision.

There are two ways meetings get to Sidekick:
- **Automatic notes after Teams meetings**: when a Teams meeting of a group's people ends, Sidekick reads its transcript and writes the notes by itself. That includes scheduled meetings and calls started with **Meet now** inside a group chat. No bot joins the call.
- **Add a past or outside meeting**: upload a transcript yourself, for meetings held before automatic notes were on, or outside Teams.

## Automatic notes after Teams meetings

### Turning it on (Org Owners and Org Admins)
1. Connect Sidekick to your Microsoft 365 organization: **Settings → Microsoft sign-in**.
2. A Microsoft admin of your organization approves Sidekick to read meeting and call transcripts, once for the whole organization, and allows Sidekick in Teams' meeting settings, including turning on **Transcript API access** (Microsoft Graph access to transcripts, off by default in new Microsoft 365 organizations). Your IT team has the exact steps from the Sidekick team.
3. Make sure Teams records transcripts for your meetings (Teams meeting policy: transcription on). Sidekick can only write notes for meetings that have a transcript. See [Getting a transcript every time](#getting-a-transcript-every-time) below.
4. On **Meetings**, press **Turn on** under *Automatic notes after Teams meetings*.

Sidekick then checks for new meetings straight away. With everything approved, new meetings usually arrive within minutes of ending (otherwise at the latest every 15 minutes). **Check now** looks again immediately. **Turn off** stops new meetings from being captured; meetings already captured stay.

If something is missing (for example the transcript permission isn't approved yet), the panel says so in plain words. Fix it and press **Check now**.

### Meet now in a group chat
Pressing **Meet now** (the camera button) inside a Teams group chat starts a call that Microsoft keeps apart from scheduled meetings. Sidekick picks those up too: turn on transcription during the call as usual (Sidekick reminds you if nobody has after two minutes: see [Getting a transcript every time](#getting-a-transcript-every-time)), and when it ends the notes land in the group that chat is linked to and are posted to the group's notes chat. A call started in a chat that isn't linked to a group goes to the group whose people spoke in it (at least two of them), like a scheduled meeting.

Microsoft needs a separate approval for these calls (*Read all call transcripts*). If your organization approved Sidekick before October 2026, the Meetings page says *"approve the new call transcripts permission"*: a Microsoft admin presses **Settings → Microsoft permissions → Approve Sidekick for your organization** once more (the checklist there shows which permissions are still missing). Scheduled meetings keep working meanwhile, and calls from the last day are still picked up once it's approved.

### Which group a meeting goes to
Sidekick never guesses: a meeting goes to a group only when that's clear. Anything unclear waits for a person to pick; it never lands in a client's group by default. Sidekick picks the group like this:
1. **The meeting's own chat**: if Sidekick was added to the meeting's chat (for example by adding the Sidekick tab to the meeting) and a Team Lead or admin assigned that chat to a group, the meeting goes to that group. For a **Meet now** call this is the group chat it was started from.
2. **Otherwise, the people**: the group with the most of its people in the meeting (the organizer and the invitees; for a Meet now call, who started it and who spoke), and at least two of them. If two groups have the same number, the organizer's group wins.
3. **Still unclear: the meeting title.** If groups tie, or no group has two of its people there, Sidekick looks at the meeting title. When it names exactly one of those groups, by its **client name**, **group name** or **engagement code** (as whole words, any capitals; names made only of everyday words like "Data Platform" and your organization's own name don't count), the meeting goes there, and the notes start with a line saying so, for example *"Picked Litware from the meeting title."* So "Litware weekly" or "Steering LIT-DATA-26" is enough.
4. **Otherwise it waits under Pick a group** on the Meetings page. That happens when people from several groups were there equally, or when Sidekick recognised fewer than two people from one group (often because someone is new to the group). Org Owners and Org Admins see every waiting meeting, and for one where too few people were recognised they can pick any group. A Team Lead sees the ones that include people from their own groups, and only those groups as choices. Until someone picks, Sidekick keeps only the meeting's title and time: nothing is written or posted.
5. **Nobody's meeting**: if no group's people were in it (or the person was alone), Sidekick skips it and keeps nothing about it (not even its title).

**Who counts as a group's person.** People count once Sidekick knows their Microsoft account: they've signed in with Microsoft, were imported from Microsoft 365, or were **added by email**. For people added by email, Sidekick looks their account up in your organization's own Microsoft 365 directory (it needs the directory permission your Microsoft admin approved) and matches their sign-in name or email. It saves the match once (the audit log says *"Microsoft account linked when Sidekick recognised them in a Teams meeting by their email"*), and also checks their own meetings from then on. Guests from other companies and people from another Microsoft organization are never matched, even when an email looks the same. If your Microsoft admin hasn't approved reading the directory yet, Sidekick can't do this matching, and the Meetings panel says so (for Org Owners, Org Admins and Team Leads) until it's approved: **Settings → Microsoft permissions → Approve Sidekick for your organization**.

**New people on the project.** After you pick a group for a waiting meeting, the notes are written and the Meetings page shows **People in this meeting who aren't in *group* yet**: people from your own Microsoft 365 organization only (never guests or other organizations). **Add to group** adds one of them to that group. Someone new to Sidekick gets an account that signs in with Microsoft and takes a seat on your plan (if the plan is full, Sidekick says so and adds nobody). An Org Owner, Org Admin or that group's Team Lead can do this (a Team Lead adds Members and Viewers). Each addition is in the group's audit log.

If anyone from another Microsoft organization (a client guest) was in the meeting, it's marked **Client guests present**: its notes count as shareable, and notes from internal meetings are never posted to chats with client guests.

### Plan limits
Each captured meeting's length counts toward your plan's **meeting hours** this month, like an uploaded transcript. When the month's hours are used up, a meeting is **Skipped** with the reason (shown on the Meetings page and in the audit log); nothing extra is ever charged. Skipped meetings can be tried again by an Org Owner or Org Admin with **Try again**, for example after adding hours. The same applies when the AI credit is used up (long meetings are skipped) or the plan is read-only.

### What you see on the Meetings page
- Captured meetings have a **Teams** tag, and the meeting page says *captured from Microsoft Teams*.
- The panel lists recent Teams meetings with their status: **Writing notes**, **Notes written**, **Pick a group**, **Skipped** (with the reason) or **Failed** (with **Try again**). Members see the meetings of their own groups; Org Owners, Org Admins and Team Leads also see skipped ones and the ones waiting for a group, and, after a pick, the meeting's people who aren't in the group yet with **Add to group**.

## Getting a transcript every time
Teams only makes a transcript when someone starts transcription, and people forget. These things help.

**Scheduled meetings: let them transcribe by themselves.** Your Microsoft admin turns on the **automatic recording option** in the Teams meeting policy (PowerShell: `Set-CsTeamsMeetingPolicy -Identity Global -AutoRecording Enabled`; transcription must be on too). Organizers then see **Record and transcribe automatically** in the meeting's **Meeting options**. They choose **Transcribe only** (a transcript, no video) or **Record and transcribe**. This doesn't need Teams Premium. It's **Off for each new meeting** until the organizer picks it: Microsoft has no setting that turns it on for everyone. With **Teams Premium**, your admin can make a meeting template that has it switched on and locked. Organizations that never want video recordings can also turn meeting recording off in the policy. From December 2026 Teams then offers organizers only **Transcribe only** or Off.

**Or let Sidekick switch it on for your groups' meetings (optional, records video too).** Once automatic notes are on, an Org Owner or Org Admin can turn on **Group meetings record and transcribe by themselves** on the Meetings page (it's off until someone does). Sidekick then looks at the scheduled Teams meetings your groups' people organize in the next seven days and turns on **Record and transcribe automatically** for the ones that are clearly one group's:

- the meeting's own chat is linked to a group, or at least half of the people invited (and at least two) are one group's people;
- never a meeting with anyone from outside your organization (guests or people from another Microsoft 365 organization), and never one that several groups share equally.

Things to know before turning it on:

- **Teams also saves a video recording**, not only the transcript, in the organizer's OneDrive, kept as your Teams policy says. Microsoft doesn't let apps choose *Transcribe only*. If you only want transcripts, leave this off and ask organizers to pick *Transcribe only* themselves.
- Everyone in the meeting sees that it's being recorded, as with any Teams recording.
- Each meeting is set **once**. If the organizer turns it off again in **Meeting options**, Sidekick leaves it off. A recurring meeting is set once for the whole series.
- A Microsoft admin approves two more permissions first: reading calendars (times, subject, invitees and the Teams link, never the invitation text) and changing Teams meetings. Until then the Meetings page says what to approve.
- Your Teams meeting policy must allow automatic recording (`AutoRecording Enabled`) and cloud recording. If it doesn't, the meeting is listed with *"Microsoft Teams didn't accept the change"*.
- Turning it off stops Sidekick setting new meetings. Meetings it already set keep recording until their organizer changes them.

Everyone in a group sees that group's upcoming meetings that will record, under the switch. Org Owners, Org Admins and Team Leads also see any problem, and how many upcoming meetings Sidekick left alone and why (without their titles). Sidekick looks at those again every hour, or at once when you press **Check now**. People count for their group whether or not they sign in to Sidekick with Microsoft, as long as the email in Sidekick is the one they're invited with. Each meeting Sidekick sets is in the audit log ("Turned on automatic recording and transcription for the Teams meeting …"), and so is each change to the switch.

**Calls in a chat (Meet now, or the call button): Sidekick reminds you.** These calls have no meeting options, so nothing can start transcription by itself. When a call starts in one of a group's Teams chats and nobody has started transcription after about **two minutes**, Sidekick posts one short card in that chat:

> **Turn on transcription?** This call isn't being transcribed yet. So I can write the meeting notes afterwards, turn it on: **More (…) → Record and transcribe → Start transcription**. If someone already started it, ignore this.

- Once per call, and at most once every 30 minutes per chat, so a call that's restarted doesn't get a second card.
- Not on the chat's **quiet days** when reminders are on there.
- Only while automatic notes are on for your organization, and only in group chats assigned to a group (not channels or 1:1 chats).
- The card is the same fixed text everywhere and says nothing about the group's work, so it's fine in chats with client guests.

**Switching them off:** reminders (for calls and scheduled meetings) are **on** for every group to start with. The group's **Team Lead** (or an Org Owner or Org Admin) can switch them off or on:
- in the portal: the group → **Teams chats** → **Transcription reminders**, or
- in one of the group's chats: `@Sidekick stop transcription reminders` (or `start transcription reminders`).

**Scheduled meetings: Sidekick reminds you too.** A scheduled Teams meeting that doesn't record by itself gets the same kind of reminder, about **two minutes after it starts**, so your team never finds out afterwards that nothing was captured:

- **Which meetings**: the scheduled Teams meetings your groups' people organize that are **clearly one group's** (its chat is linked to the group, or most of the people invited are one group's people, at least two). Meetings several groups share equally, and meetings of nobody's group, get nothing: Sidekick never guesses.
- **Where the card goes**: if Sidekick is in the meeting's own chat (for example someone added the Sidekick tab to the meeting), the card goes there, as soon as it sees the meeting's call running for two minutes with nobody transcribing or recording. If Sidekick isn't in the meeting's chat, it can't see the call, so it posts in the **group's notes chat** instead, naming the meeting: *"The Teams meeting “Weekly sync” started a few minutes ago and I can't see whether it's being transcribed…"* (only in a chat without client guests). If Teams already lists a transcript for the meeting, Sidekick says nothing.
- **Nothing is posted** when the meeting records by itself (an organizer chose *Record and transcribe automatically*, or Sidekick set it for you, above), when the group switched transcription reminders off, on the chat's quiet days, or more than 30 minutes after the start.
- **Once per meeting.** Each occurrence of a recurring meeting can get its own reminder.
- It uses the same switch as the call reminders (**Transcription reminders** on the group's **Teams chats** tab, or `@Sidekick stop transcription reminders`), and needs the same Microsoft approval as *Group meetings record and transcribe by themselves*: reading calendars and Teams meetings. Until a Microsoft admin approves that, the **Teams chats** tab says so under the switch. Sidekick reads only the next two hours of your groups' people's calendars (times, subject, invitees and the Teams link, never the invitation text).

Members and Viewers see the setting but can't change it. Each change is in the audit log, and so is each reminder Sidekick posts ("Reminded … to start transcription"). The **Teams chats** tab also shows the latest reminder. If Microsoft doesn't let Sidekick see the calls in a chat, the tab names that chat. This means Teams didn't grant Sidekick its chat-reading permission there (the *resource-specific consent* for chats). Your Microsoft admin checks the tenant's chat consent setting (`Set-MgBetaChatRscConfiguration`; the default `ManagedByMicrosoft` may not allow it, `EnabledForAllApps` does). Then remove Sidekick from that chat in Teams and add it again, because the permission is granted when Sidekick is added.

## Add a past or outside meeting
**Meetings → Add a past or outside meeting.** Upload the transcript (a Teams `.vtt` file, a Word file, or paste the text), give it a title and date, and tick **Client guests attended** if the client was there. Notes are usually ready in 20–60 seconds.

In Teams you download a past meeting's transcript from the meeting's **Recap → Transcript → Download**.

Limits: files up to 25 MB and up to 300,000 characters of transcript (about five hours of talk); split longer meetings into parts. If writing the notes fails, the meeting is still saved with **Try again**: don't add it twice.

## The notes chat in Teams
Many teams have more than one chat for an engagement (say, one for the core team and one with the client), so the group's **Team Lead** chooses where meeting notes go. Open the group (**Groups**, then its card) → **Teams chats** → **Meeting notes go to**:
- tick **one chat** (the usual choice) or several, or
- **Don't post notes in Teams**: notes then stay on the Meetings page in Sidekick.

Then **Save choice** (or **Save** once a choice exists). Org Owners and Org Admins can choose for any group; Members and Viewers see the same list read-only. Every change is in the audit log.

Only the group's own linked chats are listed, never anyone's other Teams chats. If a group has **six or more** chats, a search box appears and each chat shows how many people are in it and when it was last active, so similar chats are easy to tell apart.

**Send test message** (next to each chat, for the Team Lead and admins) posts a small card in that chat: "👋 This is where *group*'s meeting notes will go (sent from the Sidekick portal by *you*)". Use it to check you've picked the right chat. Each chat takes one test message a minute; if Teams refuses the post (for example, Sidekick was removed from that chat), the portal says why.

**From the chat itself**: in one of the group's chats, the Team Lead (or an Org Owner or Org Admin) can type:

> @Sidekick post meeting notes here
>
> @Sidekick stop posting notes here

Close variants work too ("notes here", "send meeting notes here", "don't post notes here"). Sidekick replies "Done ✓ Meeting notes for *group* will be posted here." **Post here** adds this chat to the chats already chosen; **stop** takes it off (if no chat is left, notes stay in the portal). Anyone else gets "Only the Team Lead or an admin can change where notes go." Sidekick has to recognise you: sign in to the portal with Microsoft once. Changes made in Teams are in the audit log with "(from Teams)".

Chats with **client guests** are marked: only notes from meetings the client attended go there. That holds when you choose the chat from Teams too: Sidekick accepts and explains that internal meetings' notes never go there. Notes from internal meetings never go to a chat with client guests, whatever is ticked.

**Before anyone chooses**, notes go to **one** chat only: a chat with "notes" in its name if there is one, otherwise the group's first chat without client guests. A group with two or more chats and no choice yet shows **Pick which chat gets meeting notes** under *Needs attention* for its Team Lead, with a button to the Teams chats tab. (Groups that had switched notes off in some chats before this choice existed keep that: the chats that still had notes on are the chosen ones.)

After each meeting Sidekick posts to the chosen chat(s):
1. a **notes card**: summary, the decisions and things to keep, and questions still open, with **Open in Sidekick**. Its last line says where the notes were posted ("Notes posted to Core team only."); in a chat with client guests it only names other client chats;
2. one **card per action item**, with **Assign** and **Mark done**.

The Teams chats tab also shows where the latest meeting's notes went. A group without any Teams chat shows up under *Needs attention* so its Team Lead can add one.

## Save to knowledge
Decisions, requirements, risks, facts and terms from a meeting can be **saved to the group's knowledge**:
- in Teams, with **Save to knowledge** next to each one on the notes card (the card then shows who saved it, with **Undo**);
- in the portal, on the meeting's page or in the Teams tab, with **Save to knowledge** next to each one.

A saved item becomes lasting knowledge: answers find it first, long after the meeting, and it's marked *Saved* with who saved it. **Remove from knowledge** undoes it. Members, Team Leads and admins can save; Viewers can't. Open questions and decisions still to make can't be saved (they're temporary).

## Sidekick in the Teams app bar and as a tab
Sidekick also works as a Teams app with a **Meetings** tab:
- **In the Teams app bar** (left side), open Sidekick → **Meetings**: your groups' recent meetings, their notes, and the open action items. Switch groups at the top.
- **As a tab in a chat, channel or meeting**: add Sidekick with **+** at the top of the chat or meeting. The tab opens on the group linked to that chat. Adding it to a meeting also brings Sidekick into the meeting's chat, so it can be assigned to the group and that group gets the meeting's notes.

You're signed in automatically with your Microsoft account (Teams single sign-on). You see only the groups you belong to, and can mark action items done and save things to knowledge with your own role. If the tab says you don't have an account yet, ask your Sidekick admin to add you, then sign in to the Sidekick portal with Microsoft once.

<!-- help-center:skip -->
For developers: lib/meetings-graph.ts (capture), lib/notes-chats.ts ("Meeting notes go to", the Teams command), lib/notes-chat-rules.ts (default chat, command words), /api/workspaces/:id/notes-chats/test (test message), lib/saved-items.ts (Save to knowledge), lib/teams/tab.ts (tab); tests in app/tests/meetings-graph.test.mjs. Microsoft setup steps for Cody: docs/RUNBOOKS.md → Automatic meeting notes.
<!-- /help-center:skip -->
