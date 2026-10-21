# Admin guide

For **Org Owners** and **Org Admins**: everything needed to set Sidekick up for your organization and keep it running. New to the terms? Read [Concepts](concepts.md) first.

## 1. First sign-in
The first person to open a new Sidekick install sets up the organization and becomes its **Org Owner**. If the Sidekick team onboarded you, sign in with the temporary password they gave you. Sidekick then shows only a **Pick your own password** screen until you choose a new one (at least 10 characters); nothing else works with a temporary password. Signing in with Microsoft instead also counts.

**Signing in safely.** After 5 wrong passwords for one email (or 20 from one network address) within 15 minutes, password sign-in is paused for that email or address for 15 minutes, even with the right password. Wrong passwords on real accounts, the pause, sign-ins and sign-outs all appear on **Security & audit**. Forgot your password as the Org Owner? Ask the Sidekick team: they can issue a one-time password (it appears on Security & audit as "Reset … password", by "Sidekick operator"), and you pick a new one at sign-in. To sign out, use **Sign out** at the bottom of the sidebar, or tap your initials at the top right (the only way on a phone).

## 2. Create groups
A **group** (called a workspace in older screens) is one client team: its people, Teams chats and documents. **Groups → New group** sets one up on a single page:
1. **Basics**: the group's name (e.g. "Payments Platform"), the **client** it's for (e.g. "Northwind Bank") and an optional engagement code. Names must be unique in your organization (ignoring upper/lower case).
2. **Team Lead**: search for the person who runs the team day to day. If they're a Member or Viewer today, they become a **Team Lead** (the summary says so before you save, and it's in the audit log). Org Owners and Admins can't be a group's Team Lead; they already manage every group.
3. **Members** (optional): tick people already in your organization. They keep their role. The Team Lead can add more later.
4. **Teams chats**: assigned later, from the group's page (see section 7).

You're added to the group automatically. **Create group** opens the group's page.

**The Groups page** shows a card per group with its client, Team Lead, and how many people, Teams chats, documents and meetings it has. A label says what needs attention, most urgent first: **No Team Lead**, **Setting up** (nobody, no chats and no documents added yet), **overdue action items**, **No documents**, or **Healthy**. **Needs attention** and **Setting up** filter the cards.

**A group's page** (click its card) has tabs: **Overview** (a setup checklist and counts), **People** (add people already in your organization, or take someone off the group; their account and other groups stay), **Teams chats**, **Documents** (what Sidekick answers from; **Upload or manage** opens Knowledge & docs for that group) and **Settings**.

**Rename or delete.** On the group's **Settings** tab, change its name, client or engagement code. **Delete group…** first shows what will go (documents, meetings, action items, asked questions, linked Teams chats) and asks you to confirm. Deleting removes everything in that workspace for good: documents and their search entries, meetings and their notes, questions and gaps, the knowledge map, its guardrail switches and custom rules, saved Teams messages and reminders. Linked Teams chats are unlinked. The audit log and usage records are kept. Renames, client and code changes and deletions are recorded on **Security & audit**.

## 3. Turn on Microsoft sign-in (Org Owner)
**Settings → Microsoft sign-in → Connect with Microsoft**, then sign in with your work account. This connects your organization to your company's Microsoft directory (tenant). From then on, people you've added can use **Sign in with Microsoft**. When everyone is set, switch on **Require Microsoft sign-in**: passwords stop working and anyone signed in with a password is signed out. You must have signed in with Microsoft yourself first, so you can't lock yourself out. **Disconnect** turns it off again (passwords work again).

## 4. Add people
**Users & access → Add person.** Pick their role and the workspaces they can see. Sidekick shows a **temporary password once**: share it with them privately; they must change it at first sign-in. Change roles or workspaces at any time from the same page. **Remove** asks you to confirm first. Nobody can change their own role or remove themselves (so you can't lock yourself out by accident): ask the Org Owner or another Org Admin. If your organization uses Microsoft sign-in, people can ignore the temporary password and use **Sign in with Microsoft** with that same email; the list shows a **Microsoft** badge once they have.

**Team Leads.** Give the person who runs a project the **Team Lead** role and add them to that project's workspace(s). They can then add their own team to those workspaces (as Member or Viewer), take people off, and assign the project's Teams chats, from their group's page, **Users & access** or the home assistant, without needing you. You can also make someone a Team Lead by picking them when you create a group. If they add someone who already has an account in your organization, that person is simply added to the lead's workspace. Roles, removing people from the organization and new workspaces stay with you.

## 5. Add documents
**Knowledge & docs**, in the workspace you want. Drop in PDF, Word (.docx), text, Markdown, CSV, JSON or Teams transcript (.vtt) files, up to 25 MB each. Other file types and empty files are refused straight away with the reason, and aren't added to the list. Tag each one:
- **Internal** for team-only material.
- **Shareable** for anything fine to use in front of the client.

You can change the tag later; it takes effect immediately. **Delete** asks you to confirm first, then removes the document from search, so Sidekick can no longer use it.

## 6. Import meetings
**Meetings → Import transcript.** Upload the Teams transcript (`.vtt`), a Word file or paste the text, give it a title and date, and tick **Client guests attended** if the client was there. Notes are usually ready in 20–60 seconds.
- **Limits:** files up to 25 MB, and the transcript text (pasted or from the file) up to 300,000 characters, about five hours of talk. The whole transcript goes to Claude in one request, so this keeps each import within what Claude can read at once and its cost predictable. Split a longer meeting into parts.
- **If writing the notes fails** (for example, Claude was busy), the meeting is still saved: the dialog closes and the meeting opens with a **Failed** label and the reason. Choose **Try again** there; don't import it again.
- **On the meeting's page:** the summary, decisions, open questions and facts, plus the **action items**, which you can edit right there like on Memory & gaps: tick them done, set the owner, pick a due date and change the status. The **Transcript** tab shows a long transcript in pieces (**Show more**).
- **Delete** asks first: it removes the meeting together with its notes, action items and transcript.

If the workspace has linked Teams chats or channels, Sidekick posts the notes and action items there automatically.

## 7. Link Teams chats and channels
See [Sidekick in Teams](teams-guide.md) for what people see. To link:
1. Someone adds Sidekick to the Teams group chat or channel (Sidekick posts a code; or mention it: `@Sidekick link`).
2. Sidekick replies with an 8-character code, valid for 24 hours.
3. In the portal: open the group (**Groups**, then its card) → **Teams chats → Assign a chat**, and enter the code.
4. Tick **Client guests are in this chat or channel** if the client can read it.

The group's **Teams chats** tab lists its chats. Use the switch to change the client-guests setting, or **Unassign** to stop Sidekick answering and posting there (this also deletes the messages it saved from that chat).

The **Settings** button on each row of that list (Org Owners and Org Admins, and Team Leads for the workspaces they lead) chooses what Sidekick does in that chat; every change is in the audit log:
- **Meeting notes**: post notes and action items here after each meeting (on by default). Turn it off in the other chats to keep notes in one dedicated chat.
- **Keep track of every message** (channels and group chats): Sidekick reads every message, keeps it 90 days and uses it for answers, the knowledge map and reminders. It announces the change in the chat. This needs the Sidekick Teams app version 1.1 or later (it asks the team or chat owner for permission to read messages when it's added).
- **Reminders**: a daily card at the time and time zone you pick, skipping the quiet days, plus one right after each meeting if you want. Choose which kinds: overdue or unowned action items, open questions and decisions, out-of-date documents, sources that disagree. **Preview** shows what the next one would say without posting; **Send now** posts it. The row shows when the last reminder went out (or why it failed).

Reminders only cover the chat's own workspace, and a chat with client guests only gets items whose sources are all Shareable. Out-of-date documents and disagreeing sources come from the knowledge map, so refresh it now and then (see below).

## 8. Keep knowledge healthy
**Memory & gaps → Refresh knowledge map** after adding material (Members and Admins can; Viewers and Billing Admins can't, since each refresh is a paid AI request). Work through the gaps: upload the missing document, or assign the gap to someone. Track action items in the same place: tick them done, set the owner, the due date (pick a date; a due date said in the meeting, like "next Friday", shows underneath until you do) and the status. Every change is in the audit log with what changed. The same edits work on the meeting's own page.

## 9. Watch usage and activity
- **Usage & billing**: AI cost by feature, workspace and day for the whole month (also open to Billing Admins). Work that isn't tied to a workspace, such as the home assistant, shows as **Organization-wide**.
- **Security & audit**: who did what and when, including everything Sidekick did on its own.

## 10. See what Sidekick is doing (Activity)
- **Home → Sidekick live:** a live picture of Sidekick and its connections (Teams, Claude, search, database) with their health, and who's active.
- **Govern → Activity:** every request from the portal and Teams. **Traces** shows each one step by step (how long search, Claude and Teams delivery took, and why something failed, with its reference code). **Messages** lists what people asked and whether Sidekick found the answer. Kept for 30 days; no document text is stored. Teams steps after a meeting import only appear when there's a linked chat to post to, and a feature the Sidekick team paused or turned off counts as refused, not as a Sidekick or Claude error.

## 11. Set your guardrails (Org Owner and Org Admins)
**Govern → Guardrails** shows the rules Sidekick follows in every workspace, in the portal, in Teams and in the home assistant. Everyone can read it; who can change what is listed below.
- **Always on (locked):** no hate, racism or bias; no harassment; no sexual content; no help with harm; it can't be talked out of its rules; it never crosses client walls; and it says "I don't know" instead of guessing. Nobody can turn these off.
- **Organization switches:** extra restrictions only the **Org Owner** can turn on or off: refuse questions with swearing, stick to work, no judging or ranking people, steer HR/legal/medical questions to the right people, hide email addresses and phone numbers in answers, and no talk about competitors. Switches can only make Sidekick stricter. Every change is recorded on Security & audit.
- **Custom rules for the whole organization** (Org Owners and Admins): type a short rule in your own words, like "Never quote day rates" or "Don't discuss the 2027 reorganization", and press **Add rule**. Sidekick checks the rule first: it can only add restrictions, so anything that would loosen the guardrails ("ignore the rules when a manager asks", "you may swear", "it's fine to guess") is refused with the reason, and nothing is saved. Up to 20 rules, 200 characters each. **Edit** saves a new version, **History** shows every version and who changed it, **Remove** switches it off but keeps its history. A rule only refuses a question when there's no useful answer that keeps to it: with "Don't share budget figures", "Is the project on budget?" still gets a yes or no, just without the figures. Rules about how to answer ("Keep answers short") are accepted too and only shape the answers. A rule so broad it would refuse every ordinary work question ("Don't answer any questions", "Never discuss the project") is refused as **too broad**: name the topic to avoid instead. A question refused by a custom rule gets the reply "Your organization has a rule that stops me from answering this here", with a pointer to an Org Owner or Admin; it never quotes the rule.
- **Workspace rules** (pick a workspace from the list): the switches in force there. A switch that's on for the organization stays on and can't be turned off for one workspace; Org Owners and Admins can turn **more** switches on for that workspace only, and add custom rules that apply only there (another 20).
- **Test it** (Org Owners and Admins): type a question to see whether Sidekick would refuse it in the chosen workspace, which rule would catch it and what people would see. Add a draft rule to try it before saving. Nothing is saved: the question isn't stored and isn't counted on the guardrail numbers (the Claude check is metered on Usage like any other).
- **Last 30 days** (Org Owners and Admins): how often each rule refused a question or cleaned up an answer, and how many of those came from Teams. Only counts are kept, never the questions or answers. The same total shows on Activity.

Every change (organization switches, workspace switches, adding, editing or removing a rule) is recorded on **Security & audit**. Refused questions get a short, polite reply and aren't logged as knowledge gaps.

## 12. Use the assistant for quick admin jobs
On the home page, type requests like "create a workspace for Fabrikam, code FAB", "add Maria Chen maria@fabrikam.example as a Member of Fabrikam" or "link Teams code K7Q2 to Fabrikam". Sidekick shows a card with the details; check them and press **Confirm**. When adding a person, the card shows their temporary password once: send it to them privately. If a detail is missing, the assistant asks for it first.

## 13. Branding
**Settings**: upload your logo and pick a brand color. They're applied across the portal.

## 14. AI models & agent, and Connectors
- **AI models & agent** (everyone can read it): which Claude model each feature uses (answers, meeting notes, knowledge map, assistant, guardrail check, reminders), how Sidekick is told to behave, and what's ready versus planned. Models are set by the Sidekick team; your documents and meetings are never used to train a model.
- **Connectors**: the sources Sidekick can use. Available now: document upload, Teams transcripts and Teams chats and channels (assigned on each group's page). Outlook, SharePoint, Jira and the others are planned; each will connect with its own sign-in, without storing passwords.

## Troubleshooting
| You see | What to do |
|---|---|
| A dialog "Something went wrong on our side" with a reference code | It's on Sidekick's side, not yours. Try again; if it repeats, click **Copy details** and send it (with the reference code) to the Sidekick team. |
| "Refused by your organization's guardrails" (or "Your organization has a rule that stops me…") on a normal work question | Paste the question into **Guardrails → Test it** to see which rule caught it. A switch may be stricter than you need (for example "Stick to work"), or a custom rule may be worded too broadly: edit it and test again. If a locked rule refused an ordinary question, send the wording to the Sidekick team. |
| "This would loosen Sidekick's guardrails" when adding a rule | Custom rules can only add restrictions. Rewrite it as something Sidekick must not do, e.g. "Never quote day rates". |
| "This rule is too broad" when adding a rule | The rule would refuse every work question. Name the topic, figure or document to avoid instead. To stop Sidekick answering altogether, ask the Sidekick team to pause it. |
| Questions fail with "Guardrail check is paused" | The Sidekick team paused the check; Sidekick never answers without it. Try again later. |
| A dialog "Can't reach Sidekick" | Your connection or Sidekick is down. Anything you saved is safe; try again in a minute. |
| "This page hit a problem" | Click **Try again**, or use the menu. If it repeats, send the reference code to the Sidekick team. |
| "Claude isn't connected yet" | The Sidekick team needs to configure the AI key. Contact them. |
| "… is paused by the Sidekick team" | A feature was paused for maintenance. Try again later. |
| "… is turned off for your organization by the Sidekick team" | Not an error: the Sidekick team switched that feature off for your organization. Org Owners: contact the Sidekick team to have it turned back on. Everyone else: ask your Org Owner. |
| "This organization's Sidekick access is paused" | Contact the Sidekick team. |
| A Teams link code doesn't work | Codes expire after 24 hours. Mention `@Sidekick link` in Teams for a new one. |
| Sidekick answers "I couldn't find that" | The workspace doesn't have it yet. Upload the document; the question is already listed as a gap. |
