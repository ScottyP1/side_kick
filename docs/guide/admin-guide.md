# Admin guide

For **Org Owners** and **Org Admins**: everything needed to set Sidekick up for your organization and keep it running. New to the terms? Read [Concepts](concepts.md) first.

## 1. First sign-in
**Where to sign in.** Use **Sign in** at the top of the Sidekick website. Once you're signed in, opening the website's home page takes you straight to your portal home (**Overview**). These guides are also on the website, under **Help**.

**Signing up yourself.** When the Sidekick team has opened sign-up, a company can create its own organization at **/signup** (or **Start free trial** on the **/pricing** page): see [Sign-up, plan and billing](#15-sign-up-plan-and-billing) below.

The first person to open a new Sidekick install sets up the organization and becomes its **Org Owner**. If the Sidekick team onboarded you, sign in with the temporary password they gave you. Sidekick then shows only a **Pick your own password** screen until you choose a new one (at least 12 characters, and not one that has appeared in a known data breach); nothing else works with a temporary password. Signing in with Microsoft instead also counts.

**Signing in safely.** After 5 wrong passwords for one email (or 20 from one network address) within 15 minutes, password sign-in is paused for that email or address for 15 minutes, even with the right password. Wrong passwords on real accounts, the pause, sign-ins and sign-outs all appear on **Security & audit**. Org Owners and Org Admins see **Sign-in locked** next to a paused person on **Users & access** and can press **Unlock** to let them in straight away. Changing your password signs you out on every other browser and device. Forgot your password as the Org Owner? Ask the Sidekick team: they can issue a one-time password (it appears on Security & audit as "Reset … password", by "Sidekick operator"), and you pick a new one at sign-in. To sign out, use **Sign out** at the bottom of the sidebar, or tap your initials at the top right (the only way on a phone).

**Protect your own account (Settings).** Everyone can do these for their own account; nobody can do them for someone else.
- **Two-step sign-in**: **Add a passkey** (Face ID, Touch ID, Windows Hello or a security key) or **Add an authenticator app** (scan the QR code with Microsoft Authenticator, Google Authenticator, 1Password… and type the code it shows). From then on, sign-in asks for the passkey or a code after your password. The first time, Sidekick shows **10 backup codes once**: save them in your password manager; each works once if you lose your phone. Removing a method or making new backup codes asks for your password again. Signing in with Microsoft skips this step, because Microsoft runs its own checks.
- **Where you're signed in**: every browser signed in to your account, with its network address and when it was last used. **Sign out** one, or **Sign out everywhere else**. Changing your password also signs out everywhere else.
- Lost both your phone and your backup codes? The Sidekick team can remove two-step sign-in from your account (it shows on Security & audit).

**Require two-step sign-in for everyone (Org Owner).** **Settings → Two-step sign-in for everyone → Require two-step sign-in for everyone.** When it's on, everyone who signs in with an email and password must also use a passkey or an authenticator app. People who don't have one yet see only a **Set up two-step sign-in** screen the next time they open Sidekick (already signed-in browsers too) until they add one; then **Continue** opens the portal. While it's on, nobody can remove their last method (they add another one first). People who sign in with Microsoft are exempt: Microsoft runs its own checks, so if your organization requires Microsoft sign-in this switch isn't needed. Org Owners and Org Admins see how many people haven't set it up yet; only the Org Owner can flip the switch (an Org Owner who can't add a method right away also gets **Turn the requirement off** on the setup screen), and each change shows on **Security & audit**. Someone who lost their phone and backup codes: the Sidekick team removes their two-step sign-in, and they're asked to set it up again at their next sign-in.

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
**Settings → Microsoft sign-in → Connect with Microsoft**, then sign in with your work account. This connects your organization to your company's Microsoft directory (tenant). From then on, people you've added can use **Sign in with Microsoft**. When everyone is set, switch on **Require Microsoft sign-in**: passwords stop working and anyone signed in with a password is signed out. You must have signed in with Microsoft yourself first, so you can't lock yourself out. **This is the most secure setup** and Settings recommends it: Microsoft checks every sign-in with your company's own rules (multi-factor sign-in, Conditional Access, risky sign-in alerts), and there are no Sidekick passwords left to guess. For your Microsoft accounts, make sure multi-factor sign-in is on in Microsoft Entra (Security defaults or Conditional Access). If Microsoft sign-in ever breaks, the Sidekick team can turn passwords back on for you. **Disconnect** turns it off again (passwords work again).

## 4. Add people
**Users & access → Add person.** Pick their role and the workspaces they can see. Sidekick shows a **temporary password once**: share it with them privately; they must change it at first sign-in. Change roles or workspaces at any time from the same page. **Remove** asks you to confirm first. Nobody can change their own role or remove themselves (so you can't lock yourself out by accident): ask the Org Owner or another Org Admin. If your organization uses Microsoft sign-in, people can ignore the temporary password and use **Sign in with Microsoft** with that same email; the list shows a **Microsoft** badge once they have.

**Import from Microsoft 365** (being added to each group's **People** tab). Once Microsoft sign-in is connected (step 3), you search your company's directory by name or email, tick the people, pick their role and groups, and import them. They're created as people who **sign in with Microsoft** (no temporary password); anyone already in Sidekick is just added to the groups you picked. Guests from other companies aren't listed. Team Leads can import too, as Member or Viewer into the groups they lead.

**Approve Sidekick for your organization (once).** A **Microsoft admin of your company** (Global Administrator, Privileged Role Administrator or Cloud Application Administrator) approves Sidekick once: an Org Owner or Org Admin starts it from Sidekick, signs in on Microsoft's page as (or hands the link to) that admin, and approves. Until then importing and removing Sidekick from chats say Sidekick isn't approved yet. What the approval allows:
- **Sign in and read user profile**: people sign in to Sidekick with their work account.
- **Read all users' full profiles** (an *application* permission): Sidekick can search your directory when someone imports people or types `@Sidekick add` in Teams. It reads names, work emails, job titles and account ids only and never changes anything in Microsoft 365. It's an application permission (Sidekick reads as itself, not as you) because `@Sidekick add` happens in Teams, where nobody is signed in to the portal.
- **Manage its own installation in chats and teams**: Sidekick can remove *itself* from a chat (never other apps): when someone who isn't a Team Lead or admin adds it, when nobody assigns a chat within 7 days, or when you remove it from a chat.
- Reading Teams messages is **not** part of it: that's asked per chat or team when Sidekick is added there.
The approval is recorded on Security & audit; your Microsoft admin can withdraw it any time in the Microsoft Entra admin center (Enterprise applications → Sidekick).

**Team Leads.** Give the person who runs a project the **Team Lead** role and add them to that project's workspace(s). They can then add their own team to those workspaces (as Member or Viewer), take people off, and assign the project's Teams chats, from their group's page, **Users & access** or the home assistant, without needing you. You can also make someone a Team Lead by picking them when you create a group. If they add someone who already has an account in your organization, that person is simply added to the lead's workspace. Roles, removing people from the organization and new workspaces stay with you.

## 5. Add documents
**Knowledge & docs**, in the workspace you want. Drop in PDF, Word (.docx), text, Markdown, CSV, JSON or Teams transcript (.vtt) files, up to 25 MB each and 20 at a time. Other file types and empty files are refused straight away with the reason, and aren't added to the list. A file with more than 2 million characters of text (about a 1,000-page book), a PDF over 2,000 pages, or a Word file that unpacks to far more than a real document holds is saved as **Failed** with the reason: split it into smaller files. Tag each one:
- **Internal** for team-only material.
- **Shareable** for anything fine to use in front of the client.

You can change the tag later; it takes effect immediately. **Delete** asks you to confirm first, then removes the document from search, so Sidekick can no longer use it.

## 6. Import meetings
**Meetings → Import transcript.** Upload the Teams transcript (`.vtt`), a Word file or paste the text, give it a title and date, and tick **Client guests attended** if the client was there. Notes are usually ready in 20–60 seconds.
- **Limits:** files up to 25 MB, and the transcript text (pasted or from the file) up to 300,000 characters, about five hours of talk. The whole transcript goes to the AI in one request, so this keeps each import within what it can read at once and its cost predictable. Split a longer meeting into parts. Each meeting's length (from its timestamps, or its length without them) counts toward your plan's **meeting hours** this month (see section 16).
- **If writing the notes fails** (for example, the AI was busy), the meeting is still saved: the dialog closes and the meeting opens with a **Failed** label and the reason. Choose **Try again** there; don't import it again.
- **On the meeting's page:** the summary, decisions, open questions and facts, plus the **action items**, which you can edit right there like on Memory & gaps: tick them done, set the owner, pick a due date and change the status. The **Transcript** tab shows a long transcript in pieces (**Show more**).
- **Delete** asks first: it removes the meeting together with its notes, action items and transcript.

If the workspace has linked Teams chats or channels, Sidekick posts the notes and action items there automatically.

## 7. Link Teams chats and channels
See [Sidekick in Teams](teams-guide.md) for what people see. Once Microsoft sign-in is connected (step 3):
1. **Only Team Leads and admins add Sidekick to a chat.** If anyone else adds it, Sidekick says so and leaves. (Recommended: in the Teams admin center, make the Sidekick app available only to your Team Leads and admins.)
2. Sidekick posts one notice ("I'm not set up for this chat yet") and then reads, saves and answers **nothing** there until the chat is assigned.
3. The chat shows as **waiting to be assigned** in the portal: on the group page of the Team Lead who added it, and for Org Owners and Org Admins. Pick the group (a Team Lead only their own groups), tick client guests if the client can read the chat, and assign it. Chats are assigned **only in the portal**, never from Teams.
4. Once assigned, Sidekick reads **every message** in that chat (assigned means full access) and says so in the chat. Meeting notes and reminders stay switchable per chat.
5. A chat nobody assigns within **7 days** is left automatically. **Remove Sidekick from this chat** on the group page makes Sidekick leave straight away and forget what it saved there.

**With a code instead** (only where the above doesn't apply: before Microsoft sign-in is connected, and for 1:1 chats): Sidekick's card shows an 8-character code, valid for 24 hours (mention `@Sidekick link` for a new one). Open the group (**Groups**, then its card) → **Teams chats → Assign a chat**, enter the code, and tick **Client guests are in this chat or channel** if the client can read it.

The group's **Teams chats** tab lists its chats. Use the switch to change the client-guests setting, or **Unassign** to stop Sidekick answering and posting there (this also deletes the messages it saved from that chat).

The **Settings** button on each row of that list (Org Owners and Org Admins, and Team Leads for the workspaces they lead) chooses what Sidekick does in that chat; every change is in the audit log:
- **Meeting notes**: post notes and action items here after each meeting (on by default). Turn it off in the other chats to keep notes in one dedicated chat.
- **Keep track of every message** (channels and group chats linked with a code; chats assigned from the waiting list always track and can't switch it off): Sidekick reads every message, keeps it 90 days and uses it for answers, the knowledge map and reminders. It announces the change in the chat. This needs the Sidekick Teams app version 1.1 or later (it asks the team or chat owner for permission to read messages when it's added).
- **Reminders**: a daily card at the time and time zone you pick, skipping the quiet days, plus one right after each meeting if you want. Choose which kinds: overdue or unowned action items, open questions and decisions, out-of-date documents, sources that disagree. **Preview** shows what the next one would say without posting; **Send now** posts it. The row shows when the last reminder went out (or why it failed).

Reminders only cover the chat's own workspace, and a chat with client guests only gets items whose sources are all Shareable. Out-of-date documents and disagreeing sources come from the knowledge map, so refresh it now and then (see below).

## 8. Keep knowledge healthy
**Memory & gaps → Refresh knowledge map** after adding material (Members and Admins can; Viewers and Billing Admins can't, since each refresh is a paid AI request). Work through the gaps: upload the missing document, or assign the gap to someone. Track action items in the same place: tick them done, set the owner, the due date (pick a date; a due date said in the meeting, like "next Friday", shows underneath until you do) and the status. Every change is in the audit log with what changed. The same edits work on the meeting's own page.

## 9. Watch usage and activity
- **Usage & billing**: your **plan** and its limits at the top (see sections 15 and 16), the **AI credit this month**, then AI cost by feature, group and day for the whole month (also open to Billing Admins). Work that isn't tied to a group, such as the home assistant, shows as **Organization-wide**. **Export CSV** downloads the cost per group (see section 16).
- **Security & audit**: who did what and when, including everything Sidekick did on its own.

## 10. See what Sidekick is doing (Activity)
- **Home → Sidekick live:** a live picture of Sidekick and its connections (Teams, AI answers, search, database) with their health, and who's active.
- **Govern → Activity:** every request from the portal and Teams. **Traces** shows each one step by step (how long search, the AI and Teams delivery took, and why something failed, with its reference code). **Messages** lists what people asked and whether Sidekick found the answer. Kept for 30 days; no document text is stored. Teams steps after a meeting import only appear when there's a linked chat to post to, and a feature the Sidekick team paused or turned off counts as refused, not as a Sidekick or AI error.

## 11. Set your guardrails (Org Owner and Org Admins)
**Govern → Guardrails** shows the rules Sidekick follows in every workspace, in the portal, in Teams and in the home assistant. Everyone can read it; who can change what is listed below.
- **Always on (locked):** no hate, racism or bias; no harassment; no sexual content; no help with harm; it can't be talked out of its rules; it never crosses client walls; and it says "I don't know" instead of guessing. Nobody can turn these off.
- **Organization switches:** extra restrictions only the **Org Owner** can turn on or off: refuse questions with swearing, stick to work, no judging or ranking people, steer HR/legal/medical questions to the right people, hide email addresses and phone numbers in answers, and no talk about competitors. Switches can only make Sidekick stricter. Every change is recorded on Security & audit.
- **Custom rules for the whole organization** (Org Owners and Admins): type a short rule in your own words, like "Never quote day rates" or "Don't discuss the 2027 reorganization", and press **Add rule**. Sidekick checks the rule first: it can only add restrictions, so anything that would loosen the guardrails ("ignore the rules when a manager asks", "you may swear", "it's fine to guess") is refused with the reason, and nothing is saved. Up to 20 rules, 200 characters each. **Edit** saves a new version, **History** shows every version and who changed it, **Remove** switches it off but keeps its history. A rule only refuses a question when there's no useful answer that keeps to it: with "Don't share budget figures", "Is the project on budget?" still gets a yes or no, just without the figures. Rules about how to answer ("Keep answers short") are accepted too and only shape the answers. A rule so broad it would refuse every ordinary work question ("Don't answer any questions", "Never discuss the project") is refused as **too broad**: name the topic to avoid instead. A question refused by a custom rule gets the reply "Your organization has a rule that stops me from answering this here", with a pointer to an Org Owner or Admin; it never quotes the rule.
- **Workspace rules** (pick a workspace from the list): the switches in force there. A switch that's on for the organization stays on and can't be turned off for one workspace; Org Owners and Admins can turn **more** switches on for that workspace only, and add custom rules that apply only there (another 20).
- **Test it** (Org Owners and Admins): type a question to see whether Sidekick would refuse it in the chosen workspace, which rule would catch it and what people would see. Add a draft rule to try it before saving. Nothing is saved: the question isn't stored and isn't counted on the guardrail numbers (the AI check is metered on Usage like any other).
- **Last 30 days** (Org Owners and Admins): how often each rule refused a question or cleaned up an answer, and how many of those came from Teams. Only counts are kept, never the questions or answers. The same total shows on Activity.

Every change (organization switches, workspace switches, adding, editing or removing a rule) is recorded on **Security & audit**. Refused questions get a short, polite reply and aren't logged as knowledge gaps.

## 12. Use the assistant for quick admin jobs
The assistant is under the crystal ball on the home page and behind the **round button in the bottom-left corner** of every portal page (both show the same conversation). Type requests like "create a workspace for Fabrikam, code FAB", "add Maria Chen maria@fabrikam.example as a Member of Fabrikam" or "link Teams code K7Q2 to Fabrikam". Sidekick shows a card with the details; check them and press **Confirm**. When adding a person, the card shows their temporary password once: send it to them privately. If a detail is missing, the assistant asks for it first.

**Follow-ups build on the conversation.** After "create a workspace for Fabrikam" you can say "call it Fabrikam Bank instead"; after a question, "and for the Team plan?" is understood as the full question (the reply shows "Following up on …"). Your conversation is yours alone, kept for 24 hours after your last message, and works across pages. **New conversation** starts over. The guardrails check every message, follow-ups included.

## 12a. Get help: the Help chat, support tickets and My tickets
Open the round button (bottom left) → **I need help**, or **Help & support** in the menu.
- **Help chat**: describe what isn't working ("Sidekick doesn't answer in our Teams chat", "I saw error K7Q2-9XM4"). It answers from the help guides and Sidekick's support articles, and **checks your own setup**: Teams chats linked to your groups (and waiting to be assigned), whether message tracking is on in each, anything paused or turned off for your organization, plan limits close to full, the AI credit (amounts only for Org Owners, Org Admins and Billing Admins) and recent errors with reference codes (all of your organization's for admins, your own for everyone else). Open **What I checked** under a reply to see the results. It can offer a safe fix within your role (for example, an admin or Team Lead can turn on message tracking in a chat; an admin can unlock someone's sign-in); nothing changes until you press **Confirm**. **Turn this into a ticket** sends the conversation and what was checked to the Sidekick team. The Help chat never uses your organization's AI credit; it has its own limit of 30 messages per person an hour.
- **Contact support** (Help & support): subject, category (question, something's broken, billing, sign-in or access, feature request), priority, what happened, an optional phone number and one attachment (PNG, JPEG, GIF, WebP, PDF, TXT, LOG or CSV, up to 5 MB). Your name, email and the page you came from are added for you. Never send passwords or payment details.
- **My tickets**: your tickets with their status (**Open**, **Waiting on you**, **Resolved**). Org Owners and Org Admins see every ticket from the organization; everyone else sees their own. When the Sidekick team replies, the round button shows a **dot** until you open the ticket. Replying to a waiting or resolved ticket reopens it; **Mark resolved** closes it. Contacting support keeps working even when your plan is read-only.

## 13. Branding
**Settings**: upload your logo and pick a brand color. They're applied across the portal.

## 14. AI models & agent, and Connectors
- **AI models & agent** (everyone can read it): what each AI feature does (answers, meeting notes, knowledge map, assistant, guardrail check, reminders) and whether it's **Working**, on **Essentials only** or **Paused (AI credit)**, plus what's ready versus planned. The Sidekick team picks and runs the AI behind them (Sidekick is powered by Claude); your documents and meetings are never used to train a model.
- **Connectors**: the sources Sidekick can use. The page says how many connectors to other tools your plan includes (Starter none, Team one, Business all). Available now: document upload, Teams transcripts and Teams chats and channels (assigned on each group's page). Outlook, SharePoint, Jira and the others are planned; each will connect with its own sign-in, without storing passwords.

## 15. Sign-up, plan and billing
Payments are in **test mode** for now: no money moves, prices are made up, and Sidekick **never asks for card or bank details** (a blue "Test mode" note shows wherever billing appears).

**Signing up.** On **/signup** enter your organization's name, your name, work email, a password (at least 12 characters, and not one from a known data breach) and a plan (Starter, Team or Business; compare them on **/pricing**). Plans are priced **per organization per month by groups** (one group per client engagement), not per person. You become the **Org Owner**, are signed in straight away and land on **checkout**. Each email can only have one Sidekick account, in any organization. Sign-up is **off until the Sidekick team opens it**: until then **/signup** says "Sign-up isn't open yet" and **/pricing** shows **Contact us** instead of **Start free trial**; contact them to get an organization set up. Too many sign-up attempts from one network (5 an hour) are paused for an hour.

**Free trial and paying.** Every new organization gets a **14-day free trial**. On checkout you pick the plan and any **extra groups** ($129 each a month) and see the plan's price, the extra groups' price, the total every 30 days and how many groups and people that covers, and one **Pay (test mode)** button. **Not now** keeps the trial; everyone sees a "Free trial: N days left" note at the top until you pay.

**Setup wizard.** After checkout (paying or **Not now**) a new organization lands on **Get started** (**/get-started**), which walks you through first-time setup one step at a time:
1. **Welcome**: your plan and trial, and how groups and Team Leads work.
2. **Connect Microsoft 365** (Org Owner): sign in once with your work account so your people can use **Sign in with Microsoft** (the same as Settings → Microsoft sign-in). The page lists, in plain words, what Microsoft asks you to allow.
3. **Add to Teams**: who should get the Sidekick app (recommended: only Team Leads and admins) and what your Teams admin does in the Teams admin center.
4. **Rules**: a guardrails starting point. **Standard** is the usual defaults; **Strict** turns every switch on, for regulated clients. Only the Org Owner can change it; it's the same as the Guardrails page.
5. **First groups**: a name, client and Team Lead for each client team. Pick the Team Lead from your organization or choose **Someone new…** to add them (they become a Team Lead and you get their temporary password once, to share privately).

Then **Done** shows what's set and what's left, and **Finish setup** ends it. Any step can be skipped (**Do this later**) and you can come back: until setup is finished, Org Owners and Org Admins see a **Finish setting up Sidekick** banner with a **Continue setup** link. Finishing is in the audit log. Organizations set up by the Sidekick team don't get the banner.

**Plan on Usage & billing** (Org Owners, Org Admins and Billing Admins see it; **only the Org Owner and Billing Admins** can change it):
- **Current plan** (with any extra groups, e.g. "Starter + 2 extra groups"), the **monthly price for the organization**, its status (Free trial, Active, Payment failed, Canceled) and dates, groups used (ending groups aren't counted), people, and a table of **every limit** with how much you use (see section 16). A person is anyone with an account, any role.
- **Extra groups**: set the number and press **Update** ($129 each a month; each also adds 15 people, 30 meeting hours, $40 of AI credit, 5 tracked chats and 500 documents). Fewer than your groups need is refused; nothing is deleted.
- **Pay now** (when not active) opens checkout. **Change plan…** switches straight away (the paid-until date stays; extra groups stay); a plan you've outgrown (more people or groups than it allows, with its extra groups) is refused with the numbers.
- **Cancel plan** asks first. Sidekick stays fully usable until the end of what you paid for (or the trial), then turns read-only for 30 days so you can export, then everything is deleted (section 17). Paying again before then keeps everything.
- **Simulate a failed payment** (test mode only) shows what your team would see when a payment fails.
- Every change is on **Security & audit** (kind "Billing").

**When the plan isn't active.**
| Status | What happens |
|---|---|
| Free trial | Full use until the trial ends, with a note at the top saying how many days are left. |
| Payment failed | Full use for a **7-day grace period**, with a warning to fix it. |
| Canceled | Full use until the end of what was paid for, with a note that gives the deletion date (30 days later). |
| Any of these after its date | **Read-only**: everyone can still sign in and see everything; nothing can be added or changed (refused with "Sidekick is read-only for your organization because…"), and Sidekick doesn't answer in the portal, Teams or the assistant, write meeting notes or send reminders. Paying on Usage & billing turns everything back on at once. A free trial or failed payment that isn't fixed deletes nothing; a canceled plan is deleted after its 30 read-only days (section 17). |

Organizations set up by the Sidekick team (or the very first one on an install) have no self-service plan: Usage & billing says the plan is managed by the Sidekick team, and still shows any limits the team set. **Enterprise** is the same: set up with the Sidekick team, with limits and a price agreed for your organization.

## 16. Plan limits, AI credit and the usage export
**Limits.** Each plan includes a number of each of these (placeholder prices while pricing is decided). The price is **per organization per month**, whatever the number of people:

| | Starter | Team | Business | Enterprise | Each extra group |
|---|---|---|---|---|---|
| **Price per month** | $199 | $699 | $1,999 | From about $5,000, agreed with you | +$129 |
| **Groups** (client engagements) | 1 | 5 | 20 | Unlimited | +1 |
| People | 15 | 75 | 300 | Agreed with you | +15 |
| Meeting hours per month (imported transcripts) | 30 | 150 | 600 | Agreed with you | +30 |
| **AI credit per month** | $40 | $200 | $800 | Agreed with you | +$40 |
| Tracked Teams chats (chats assigned to a group) | 5 | 25 | 100 | Agreed with you | +5 |
| Documents | 500 | 2,500 | 10,000 | Agreed with you | +500 |
| Connectors to other tools | None | 1 | All | All | |
| Live meeting hours per month (Sidekick joining calls; coming later) | Not included | Not included | Not included | Included (100 by default) | |
| Also included | Answers, notes, guardrails, audit log | + reminders, Team Leads, custom rules | + require Microsoft sign-in, priority support | + live in meetings, dedicated database option | |

**More groups.** When you create a group past your plan, Sidekick says which limit and the cheaper way to make room, with the monthly price of each, for example on Starter with 1 group: "add 1 extra group (Starter + 1 extra group for $328 a month), or move to Team for $699 a month". With 3 groups on Starter, extra groups ($457) beat Team ($699); from 5 groups, Team is cheaper. **See both options on Usage & billing** opens the plan with one button for each (Org Owner and Billing Admins). Groups that are **ending** (section 17) don't count toward the limit.

When any other limit is reached, adding another one is refused with a message saying which limit, the numbers, and how to get more. Meeting hours start again on the 1st of each month (UTC). **Nothing is ever deleted** because of a limit: if you move to a smaller plan (or the Sidekick team lowers a limit) while using more, everything stays, the limit shows **Over limit** on Usage & billing, and you just can't add more until you're under it. **Near limit** shows from 80%. Organizations that were on the earlier per-person plans keep their plan name and get these numbers; if they have more groups than that now includes, their groups keep working and only new ones are refused.

**AI credit.** Your plan includes a monthly amount of AI use, measured in dollars of AI cost (shown on Usage & billing → **AI credit this month**):
- **At 80%** the Org Owner, Org Admins and Billing Admins see a notice at the top of every page, and it's recorded once on **Security & audit**.
- **At 100% ("essentials only")** Sidekick **keeps answering questions** (portal and Teams) and checking them against your guardrails, on a lighter AI model, and shorter meetings still get notes. These pause until the 1st, each with a plain message: automatic reminders in Teams, knowledge map updates, the home assistant, and notes for long meetings (over about an hour; such an import is refused before it's saved, so there's nothing to clean up). The header says **AI answers: essentials only**, and it's recorded on Security & audit.
- **More credit:** move to a bigger plan, or ask the Sidekick team: they can raise your credit or add a one-off top-up for the month (it shows as "includes a top-up"). Both are recorded on Security & audit as "Sidekick team".

**Questions per person.** Each person can ask up to 60 questions an hour (portal and Teams together). Past that, Sidekick says "You've asked 60 questions in the last hour… ask again in a few minutes". The Sidekick team can change the number for your organization.

**Usage export (CSV, for chargeback).** On Usage & billing, pick **This month**, **Last 3 months** or **Last 12 months** and press **Export CSV** (Org Owners, Org Admins and Billing Admins). One row per group per month with: month, group, **engagement code**, **client**, AI requests, **AI cost (USD)**, questions asked, meetings imported, meeting hours and documents added. AI work not tied to a group is one "Organization-wide" row. Set each group's engagement code and client on its **Settings** tab so the file lines up with your WBS codes. Only your own organization's groups are ever in the file.

## 17. When an engagement ends: roll-off, export and deletion
**Ending one group** (Org Owners and Org Admins): open the group → **Settings** → **When the engagement ends**.
- **Export everything (zip)** downloads the group at any time: each document's text as Sidekick extracted it (the original files aren't kept), one file per meeting with notes, decisions, action items and the transcript, spreadsheets (CSV) of decisions and notes, action items, and questions with the knowledge gaps, a summary of the tracked Teams chats with their saved messages, the people in the group, and an **index.html** to open first. Exports are recorded on Security & audit.
- **End this group…** asks for a deletion date (**30 days** by default, at least 7, at most a year). From then on the group shows **Ending** with the date: it's **read-only** for everyone (nothing can be uploaded, imported, asked or renamed; reading still works), its Teams chats get a short notice and are unlinked (Sidekick stops answering there), and it **no longer counts** toward your plan's groups.
- **Cancel the ending** (until the date) makes it a normal group again and relinks its Teams chats where nobody linked them elsewhere.
- **On the date** Sidekick deletes everything in the group (documents and their search entries, meetings and notes, action items, questions, saved chat messages, rules and members) and writes a **deletion certificate**: which kinds of data were deleted and how many, when, who asked, and that deleted data leaves the database backups within 35 days. It holds **no content**. It's in the audit log and on **Settings → Your data → Roll-offs and certificates**, as a PDF or text file. **Delete group now…** deletes at once, also with a certificate.

**When your whole organization leaves.** After you cancel (or the Sidekick team ends the service), Sidekick stays usable until the end of what you paid for, then everything is **read-only for 30 days** with a banner giving the deletion date. Org Owners and Org Admins can download everything on **Settings → Your data → Export your data** (every group in its own folder, everyone in the organization, the audit log). Then all of it is deleted: groups, people and their sign-ins, Teams links, settings, usage details and the audit log. Paying again before the date keeps everything. Only a minimal record of the deletion (organization name, dates, who asked, the certificate's counts) is kept by the Sidekick team; they can send you the certificate, since nobody can sign in afterwards.

## Troubleshooting
| You see | What to do |
|---|---|
| "This group is ending: it's read-only…" | The group is scheduled for deletion. An Org Owner or Org Admin can export it or **Cancel the ending** on its Settings tab. |
| A dialog "Something went wrong on our side" with a reference code | It's on Sidekick's side, not yours. Try again; if it repeats, click **Copy details** and send it (with the reference code) to the Sidekick team. |
| "Refused by your organization's guardrails" (or "Your organization has a rule that stops me…") on a normal work question | Paste the question into **Guardrails → Test it** to see which rule caught it. A switch may be stricter than you need (for example "Stick to work"), or a custom rule may be worded too broadly: edit it and test again. If a locked rule refused an ordinary question, send the wording to the Sidekick team. |
| "This would loosen Sidekick's guardrails" when adding a rule | Custom rules can only add restrictions. Rewrite it as something Sidekick must not do, e.g. "Never quote day rates". |
| "This rule is too broad" when adding a rule | The rule would refuse every work question. Name the topic, figure or document to avoid instead. To stop Sidekick answering altogether, ask the Sidekick team to pause it. |
| Questions fail with "Guardrail check is paused" | The Sidekick team paused the check; Sidekick never answers without it. Try again later. |
| A dialog "Can't reach Sidekick" | Your connection or Sidekick is down. Anything you saved is safe; try again in a minute. |
| "This page hit a problem" | Click **Try again**, or use the menu. If it repeats, send the reference code to the Sidekick team. |
| "AI answers aren't set up yet" | The Sidekick team needs to finish setting up the AI. Contact them. |
| "Your … plan allows … and you have …" | You've reached a plan limit (section 16). Move to a bigger plan on Usage & billing, remove something you no longer need, or ask the Sidekick team. |
| "… is paused because your organization has used this month's AI credit" | Answers still work; the extras come back on the 1st, with a bigger plan, or with a top-up from the Sidekick team (section 16). |
| "You've asked … questions in the last hour" | The per-person limit. Wait a few minutes. |
| "Sidekick's AI is very busy right now. Try again in a minute." | The AI service was overloaded even after Sidekick retried a few times. Try again shortly; nothing is lost (a meeting import is kept with **Try again**). |
| "… is paused by the Sidekick team" | A feature was paused for maintenance. Try again later. |
| "… is turned off for your organization by the Sidekick team" | Not an error: the Sidekick team switched that feature off for your organization. Org Owners: contact the Sidekick team to have it turned back on. Everyone else: ask your Org Owner. |
| "This organization's Sidekick access is paused" | Contact the Sidekick team. |
| "That password has appeared in a known data breach" | Attackers try those first. Pick another (a password manager can make one). Sidekick checks this against Have I Been Pwned without sending your password anywhere: only the first 5 characters of a scrambled version (its hash) leave Sidekick, and the match is made on Sidekick's side. If that service is down, the password is accepted on length alone. |
| "Authenticator apps aren't available on this server yet" | The Sidekick team still needs to set the server's encryption key. Add a passkey instead, or ask them. |
| "That code doesn't match" at sign-in | Type the newest code from your authenticator app (check your phone's clock is set automatically), or a backup code. After 5 wrong codes, sign in again with your password. |
| "Sidekick is read-only for your organization because…" | The free trial ended, a failed payment wasn't fixed, or the plan was canceled. The Org Owner or a Billing Admin pays on **Usage & billing** to turn everything back on. |
| "Self-service sign-up isn't open yet" | Sign-up is off until the Sidekick team opens it. Contact them (see Support) to get an organization set up. |
| "You've sent 30 messages to the Help chat in the last hour" | Use **Contact support** to reach a person, or wait a few minutes. |
| The Help chat says "I don't know" | It only answers what the help guides, support articles or your setup checks back up. Press **Turn this into a ticket**. |
| A Teams link code doesn't work | Codes expire after 24 hours. Mention `@Sidekick link` in Teams for a new one. A code from another company's Teams never works in your organization. |
| A chat doesn't appear under *Waiting to be assigned* | Microsoft sign-in must be connected (Settings), and the chat must be in your company's Microsoft 365. 1:1 chats never wait; use their link code. |
| "Sidekick isn't approved for your Microsoft 365 organization yet" when importing | A Microsoft admin of your company approves it once: **Approve Sidekick for your organization** (Org Owner or Org Admin). |
| "Sidekick isn't set up for your organization yet" in Teams | Your company hasn't signed up, or Microsoft sign-in isn't connected yet (Settings). |
| Sidekick answers "I couldn't find that" | The workspace doesn't have it yet. Upload the document; the question is already listed as a gap. |
