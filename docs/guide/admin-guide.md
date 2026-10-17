# Admin guide

For **Org Owners** and **Org Admins**: everything needed to set Sidekick up for your organization and keep it running. New to the terms? Read [Concepts](concepts.md) first.

## 1. First sign-in
The first person to open a new Sidekick install sets up the organization and becomes its **Org Owner**. If the Sidekick team onboarded you, sign in with the temporary password they gave you; you'll be asked to choose your own.

## 2. Create workspaces
**Workspaces → New workspace.** Create one per client engagement, e.g. "Contoso Retail – Cloud Migration", with an optional engagement code. You're added as a member automatically.

## 3. Turn on Microsoft sign-in (Org Owner)
**Settings → Microsoft sign-in → Connect with Microsoft**, then sign in with your work account. This connects your organization to your company's Microsoft directory (tenant). From then on, people you've added can use **Sign in with Microsoft**. When everyone is set, switch on **Require Microsoft sign-in**: passwords stop working and anyone signed in with a password is signed out. You must have signed in with Microsoft yourself first, so you can't lock yourself out. **Disconnect** turns it off again (passwords work again).

## 4. Add people
**Users & access → Add a person.** Pick their role and the workspaces they can see. Sidekick shows a **temporary password once**: share it with them privately; they must change it at first sign-in. Change roles or workspaces at any time from the same page. If your organization uses Microsoft sign-in, people can ignore the temporary password and use **Sign in with Microsoft** with that same email; the list shows a **Microsoft** badge once they have.

## 5. Add documents
**Knowledge & docs**, in the workspace you want. Drop in PDF, Word (.docx), text, Markdown, CSV or JSON files, up to 25 MB each. Tag each one:
- **Internal** for team-only material.
- **Shareable** for anything fine to use in front of the client.

You can change the tag later; it takes effect immediately.

## 6. Import meetings
**Meetings → Import transcript.** Upload the Teams transcript (`.vtt`), a Word file or paste the text, give it a title and date, and tick **Client guests attended** if the client was there. Notes are ready in about 15–30 seconds. If processing fails (for example, Sidekick was paused), open the meeting and choose **Try again**.

If the workspace has linked Teams channels, Sidekick posts the notes and action items there automatically.

## 7. Link Teams channels
See [Sidekick in Teams](teams-guide.md) for what people see. To link:
1. Someone adds Sidekick to the Teams channel or chat and mentions it (`@Sidekick link`).
2. Sidekick replies with an 8-character code, valid for 24 hours.
3. In the portal: **Workspaces → Link Teams channel**, enter the code, pick the workspace.
4. Tick **Client guests are in this channel** if the client can read it.

The **Teams channels and chats** table on the Workspaces page shows every link. Use the switch to change the client-guests setting, or **Unlink** to stop Sidekick answering and posting there (this also deletes the messages it saved from that chat).

**Settings** (Org Owners and Org Admins) chooses what Sidekick does in each chat; every change is in the audit log:
- **Meeting notes**: post notes and action items here after each meeting (on by default). Turn it off in the other chats to keep notes in one dedicated chat.
- **Keep track of every message** (channels and group chats): Sidekick reads every message, keeps it 90 days and uses it for answers, the knowledge map and reminders. It announces the change in the chat. This needs the Sidekick Teams app version 1.1 or later (it asks the team or chat owner for permission to read messages when it's added).
- **Reminders**: a daily card at the time and time zone you pick, skipping the quiet days, plus one right after each meeting if you want. Choose which kinds: overdue or unowned action items, open questions and decisions, out-of-date documents, sources that disagree. **Preview** shows what the next one would say without posting; **Send now** posts it. The row shows when the last reminder went out (or why it failed).

Reminders only cover the chat's own workspace, and a chat with client guests only gets items whose sources are all Shareable. Out-of-date documents and disagreeing sources come from the knowledge map, so refresh it now and then (see below).

## 8. Keep knowledge healthy
**Memory & gaps → Refresh knowledge map** after adding material (Members and Admins can; Viewers and Billing Admins can't, since each refresh is a paid AI request). Work through the gaps: upload the missing document, or assign the gap to someone. Track action items in the same place.

## 9. Watch usage and activity
- **Usage & billing**: AI cost by feature, workspace and day (also open to Billing Admins).
- **Security & audit**: who did what and when, including everything Sidekick did on its own.

## 10. See what Sidekick is doing (Activity)
- **Home → Sidekick live:** a live picture of Sidekick and its connections (Teams, Claude, search, database) with their health, and who's active.
- **Govern → Activity:** every request from the portal and Teams. **Traces** shows each one step by step (how long search, Claude and Teams delivery took, and why something failed, with its reference code). **Messages** lists what people asked and whether Sidekick found the answer. Kept for 30 days; no document text is stored.

## 11. Set your guardrails (Org Owner and Org Admins)
**Govern → Guardrails** shows the rules Sidekick follows in every workspace, in the portal, in Teams and in the home assistant. Everyone can read it; who can change what is listed below.
- **Always on (locked):** no hate, racism or bias; no harassment; no sexual content; no help with harm; it can't be talked out of its rules; it never crosses client walls; and it says "I don't know" instead of guessing. Nobody can turn these off.
- **Organization switches:** extra restrictions only the **Org Owner** can turn on or off: refuse questions with swearing, stick to work, no judging or ranking people, steer HR/legal/medical questions to the right people, hide email addresses and phone numbers in answers, and no talk about competitors. Switches can only make Sidekick stricter. Every change is recorded on Security & audit.
- **Custom rules for the whole organization** (Org Owners and Admins): type a short rule in your own words, like "Never quote day rates" or "Don't discuss the 2027 reorganization", and press **Add rule**. Sidekick checks the rule first: it can only add restrictions, so anything that would loosen the guardrails ("ignore the rules when a manager asks", "you may swear", "it's fine to guess") is refused with the reason, and nothing is saved. Up to 20 rules, 200 characters each. **Edit** saves a new version, **History** shows every version and who changed it, **Remove** switches it off but keeps its history.
- **Workspace rules** (pick a workspace from the list): the switches in force there. A switch that's on for the organization stays on and can't be turned off for one workspace; Org Owners and Admins can turn **more** switches on for that workspace only, and add custom rules that apply only there (another 20).
- **Test it** (Org Owners and Admins): type a question to see whether Sidekick would refuse it in the chosen workspace, which rule would catch it and what people would see. Add a draft rule to try it before saving. Nothing is saved: the question isn't stored and isn't counted on the guardrail numbers (the Claude check is metered on Usage like any other).
- **Last 30 days** (Org Owners and Admins): how often each rule refused a question or cleaned up an answer, and how many of those came from Teams. Only counts are kept, never the questions or answers. The same total shows on Activity.

Every change (organization switches, workspace switches, adding, editing or removing a rule) is recorded on **Security & audit**. Refused questions get a short, polite reply and aren't logged as knowledge gaps.

## 12. Use the assistant for quick admin jobs
On the home page, type requests like "create a workspace for Fabrikam, code FAB", "add Maria Chen maria@fabrikam.example as a Member of Fabrikam" or "link Teams code K7Q2 to Fabrikam". Sidekick shows a card with the details; check them and press **Confirm**. When adding a person, the card shows their temporary password once: send it to them privately. If a detail is missing, the assistant asks for it first.

## 13. Branding
**Settings**: upload your logo and pick a brand color. They're applied across the portal.

## Troubleshooting
| You see | What to do |
|---|---|
| A dialog "Something went wrong on our side" with a reference code | It's on Sidekick's side, not yours. Try again; if it repeats, click **Copy details** and send it (with the reference code) to the Sidekick team. |
| "Refused by your organization's guardrails" on a normal work question | Paste the question into **Guardrails → Test it** to see which rule caught it. A switch may be stricter than you need (for example "Stick to work"), or a custom rule may be worded too broadly: edit it and test again. If a locked rule refused an ordinary question, send the wording to the Sidekick team. |
| "This would loosen Sidekick's guardrails" when adding a rule | Custom rules can only add restrictions. Rewrite it as something Sidekick must not do, e.g. "Never quote day rates". |
| Questions fail with "Guardrail check is paused" | The Sidekick team paused the check; Sidekick never answers without it. Try again later. |
| A dialog "Can't reach Sidekick" | Your connection or Sidekick is down. Anything you saved is safe; try again in a minute. |
| "This page hit a problem" | Click **Try again**, or use the menu. If it repeats, send the reference code to the Sidekick team. |
| "Claude isn't connected yet" | The Sidekick team needs to configure the AI key. Contact them. |
| "… is paused by the Sidekick team" | A feature was paused for maintenance. Try again later. |
| "This organization's Sidekick access is paused" | Contact the Sidekick team. |
| A Teams link code doesn't work | Codes expire after 24 hours. Mention `@Sidekick link` in Teams for a new one. |
| Sidekick answers "I couldn't find that" | The workspace doesn't have it yet. Upload the document; the question is already listed as a gap. |
