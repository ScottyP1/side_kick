# Owner Console guide

For the **Sidekick operator** (whoever runs Sidekick as a service), not for client users. The console lives at `/owner` and has its own sign-in, separate from every client account.

## Signing in
**Sign in with Microsoft** is the normal way in: on `/owner/login`, press the button and sign in with your
Microsoft work account (for Cody: CodyScott@SidekickLabs334). Only the Microsoft accounts the server lists in
`SIDEKICK_OWNER_MS_ACCOUNTS` get in, identified by their organization (tenant) id and account (object) id, never
by email. Anyone else sees "This Microsoft account can't sign in to the Owner Console." and the attempt goes in
the operator log (Releases & switches → log) with the account's email and ids.
- **The first time**, the owner account is made from your Microsoft name and email (or, if an owner account with
  that email already exists, it's linked to your Microsoft account). No setup code needed.
- **Strong sign-in**: Microsoft asks for your second step (MFA) itself (the Sidekick Labs tenant has security
  defaults on). If Microsoft's reply says the sign-in *didn't* use MFA, the console refuses it.
- **Passkey (optional)**: if you add a passkey under **Security**, the console asks for it after Microsoft too.
- The button only shows when the server is set up for it (RUNBOOKS → Owner Console sign-in with Microsoft).
  It never signs you in to the client portal, and a portal sign-in never opens the console.

**Other ways to sign in** (the small link under the button): email and password, for recovery and for a
laptop copy without Microsoft. When Microsoft sign-in isn't set up, the password form shows straight away.

### Password accounts (fallback)
The first password owner account is created once, at `/owner/setup` (only offered while Microsoft sign-in is off):
- **On a laptop:** open `http://localhost:3000/owner` on the machine running Sidekick.
- **On the live site:** setup is off until you give the server a one-time **setup code**. Put a long random
  value (at least 16 characters) in the Container App secret `SIDEKICK_SETUP_CODE`, open `/owner/setup`,
  enter the code with your details, then **remove the secret** again. Without it, production refuses setup
  outright (the old "only from localhost" check trusted an address the caller can fake).

After that, sign in at `/owner/login` (under **Other ways to sign in** when Microsoft is on). Owner sessions last 12 hours. 5 wrong passwords for one owner email
(or 20 from one network address) in 15 minutes pause owner sign-in for 15 minutes, even with the right
password; failed sign-ins on real owner accounts and the pause are in the operator log (Releases & switches).
Owner passwords need at least 12 characters and must not be one from a known data breach (use a different password from your client login).

**Security** (in the menu): change the owner password (signs out your other browsers) and turn on **two-step sign-in** with a passkey or an authenticator app, exactly like a client's Settings page. Strongly recommended: the console sees every client. Save the backup codes in your password manager.

An owner account made by Microsoft sign-in has no password anyone knows: to use the password way in, give it one with the reset command below (`--owner <email>`).

**Microsoft sign-in broken, lost the owner password, or a client's Org Owner is locked out?** Run the reset command on the Mac (`docs/RUNBOOKS.md` → Locked out). It prints a one-time password in your terminal only; signing in with it asks for a new password first. Lost the phone too? Add `--reset-2fa` to remove two-step sign-in from that account. (If there's no owner account on the live site yet, `--owner` creates one, as an alternative to the setup code.)

The portal's own first-run setup (the very first organization on an empty install) follows the same rule
(localhost on a laptop, the setup code in production). After that, organizations are created in two ways: **self-service sign-up** at `/signup` (a company signs itself up; **off until you open it**, see below), or **Add a client** here. Nobody inside a client organization can create another one, and the home assistant can't either.

## Pages
| Page | Shows |
|---|---|
| **Overview** | Alerts to act on at the top (today: **Search is almost full**, below), AI spend (today, this month, projected), number of clients, error rate, response time, spend per day and per client, latest errors |
| **Business** | Your one place to watch the business (no Azure dashboard needed): **MRR**, AI cost and **margin** (plan revenue minus AI cost) this month, **plan mix**, **trials ending** in the next 7 days, **failed payments**, **sign-ups per week** (12 weeks, labelled by the Monday each week starts, with the count on each bar; darker = self-service), a table of every client with plan, **partner**, people, revenue, AI cost, margin, AI credit used and **Near / Over limit** flags, **infrastructure health** (database, AI key, search, Teams bot, the running commit and release time, recent deploys seen, app errors in the last 24 hours with their reference codes), and **Search capacity** (Azure AI Search only: storage and indexes used against the tier's limits with percentages, the tier, when it was last checked) |
| **Clients** | Every client organization: its **plan** and subscription status ("Managed" = no self-service plan), users, workspaces, meetings, documents, monthly spend, errors. **Add a client** creates the organization and its Org Owner with a one-time password (shown once). **Pause / Resume** turns a client's access off or on. Click a client's name for its own page (below) |
| **Performance & errors** | Typical and slowest response times, error rates and prompt-cache savings per feature (by name: Reminders, Document checks, …) and model; failed AI requests; processing health per client; **App errors**: every unexpected problem with the **reference code** the person saw, so you can look up a code a client sends you |
| **Roll-offs** | Every group that is ending and every client in its grace period (deletion date, who asked, why, read-only from), and done deletions with their **deletion certificate** (PDF or text). **Extend** (a new date 1–365 days from today), **Delete now** (the job queue deletes it within 5 minutes, e.g. when a client asks for prompt deletion) or **Cancel**. A failed deletion shows its error and is retried every 5 minutes |
| **Support inbox** | Every customer ticket (portal, Help chat, website form, help bot) with filters and the ticket view; see "Support" below |
| **Support articles** | Sidekick's knowledge base of known issues and fixes, at three levels; see "Support" below |
| **Help bot** | How the website's "Ask about Sidekick" bot is doing, its budget and the questions it couldn't answer; see "Support" below |
| **Job queue** | The background work's health: **backlog** (jobs due now and how long the oldest waited), running and **stuck** jobs (lease ran out), finished and failed in the last 24 hours, **dead letters** (gave up after every attempt, with their error: **Retry** or **Cancel**), counts per kind of job and per client, and open **Needs attention** findings per kind across clients (counts only). **Run all now** queues every recurring job (reminders, watchers, roll-offs, clean-up) for the next heartbeat. When it's stuck: `docs/RUNBOOKS.md` → Job queue stuck |
| **Releases & switches** | Running version and commit, models in use, **kill switches** (including **Self-service sign-up**), operator log |

**Search capacity.** The live site's Azure AI Search runs on the **Free** tier (50 MB of storage, 3 indexes, no uptime guarantee). Every hour Sidekick reads how full it is (job `search.capacity`) and shows it on **Business → Search capacity**. At **70% of storage, or with only one index left**, the Overview and Business pages say **"Search is almost full: upgrade to Basic (about $75/month) before uploads fail"**, and the operator log gets one line; at **90% (or no index left)** it says so again. It clears by itself after an upgrade. How to upgrade: `docs/RUNBOOKS.md` → Search almost full. Customers never see any of this. Copies running on the local keyword index (no Azure AI Search) show nothing.

The console has its own dark graphite look with the Indigo accent (whatever your device's light/dark setting), so you never mistake it for a client's portal.

## Kill switches
Each switch pauses one AI feature **for every client at once**: answering questions, meeting notes, knowledge map, the in-app assistant, the **guardrail check**, document uploads, **reminders in Teams** (daily and after-meeting reminder cards), the **support assistant** (Help chat), the **public help bot**, **follow-up questions** and the **watchers' AI checks** (only the "document may be out of date" check; the other Needs attention checks keep running). Pausing the guardrail check also stops answers (Sidekick never answers a question it hasn't checked). Use it during an incident or a cost spike. Clients see a friendly "paused by the Sidekick team" message, and Sidekick stops answering in Teams for that feature. A pause is a deliberate refusal: it isn't listed under App errors and doesn't count as a Claude error. Every flip is recorded in the operator log.

## Self-service sign-up and plans
- **Sign-up switch (off by default)**: a fresh install or deploy **refuses self-service sign-up**, so strangers can't create organizations that use real Claude credit. `/signup` then shows "Sign-up isn't open yet" with a **Contact us** button, and `/pricing` shows the same note with **Contact us** instead of **Start free trial**. Open it with **Releases & switches → Self-service sign-up** (and close it the same way), or set `SIDEKICK_SIGNUP_OPEN=true` on the deploy. Once you've flipped the switch in the console, your choice wins over the setting. It's platform-wide only, so it doesn't appear among a client's restrictions. Each new sign-up is written to the operator log ("New organization … on the … plan").
- **Plans** (Starter $199, Team $699, Business $1,999 a month per organization, by groups: 1, 5 and 20; **extra groups** $129 each on any of them; Enterprise from about $5,000, set by you; all placeholders defined in `app/src/lib/plans.ts`) and **payments are in test mode**: no money moves and no card details are ever collected. Revenue in **Business** is the plan price plus extra groups (contract price for Enterprise and managed clients), not people × price any more. Subscriptions from the earlier per-person plans kept their plan ids and simply got the new limits; nothing was deleted (clients with more groups than their plan now includes see "Over limit" and can't add new groups).
- **Setting a client's plan**: on the client's page, **Plan** shows plan with extra groups, monthly price, status, people and groups against the limits (ending groups shown separately), and who changed it last. Pick a plan, a status and/or **Extra groups** and **Save plan**. Statuses restart their dates: **Active** = paid for 30 days from now, **Free trial** = a new 14-day trial, **Payment failed** = the 7-day grace period starts now, **Canceled** = read-only at once **and the client's data is deleted after 30 days** (any other status stops that).
- **End client…** (on the client's page): read-only now with a banner, export for their admins, everything deleted after 30 days. Manage it on **Roll-offs**. Paying again also stops it. Use it to extend a trial, mark an invoice paid, or end access. Every change goes to the operator log and the client's audit log ("Sidekick team: Set the plan to …"). Setting a plan for a managed client (no plan yet) creates one.
- A client whose plan lapsed is **read-only** (they see everything, change nothing, Sidekick doesn't answer). That's different from **Pause**, which locks them out entirely.

## Plan limits, AI credit and plan terms
Plans and their limits live in one file, `app/src/lib/plans.ts` (Starter, Team, Business, **Enterprise**; numbers are placeholders): people, groups, tracked Teams chats, meeting hours per month, documents, connectors and a **monthly AI credit** in dollars. Clients hit a limit with a clear "your plan allows…" message; nothing is ever deleted when a limit is lowered (they see **Over limit**). See the admin guide, section 16, for what clients see.

**AI credit.** Each client's Claude cost this month is compared with its credit before every AI call. At 80% their Org Owner and Org Admins get a banner (and one audit entry); at 100% the client goes to **essentials only**: answers and guardrail checks keep working on cheaper models (`SIDEKICK_MODEL_ESSENTIAL_ASK/_GUARD/_EXTRACT`, default Sonnet for answers and notes, Haiku for the check), shorter meetings still get notes, and reminders, knowledge map, assistant and long-meeting notes pause. You get an operator-log line ("… used up its AI credit"). Managed clients (no plan) have no credit limit unless you set one.

**On a client's page:**
- **Limits this month**: every limit with its use and Near / Over flags.
- **AI credit**: used of included (with top-ups), and **Add top-up**: a one-off amount for this month, with an optional note. The table below shows their AI use by feature **and model**: model names are shown only here, never in the client portal (clients see "AI answers: working").
- **AI use this month**: what the client's own Usage page showed until October 2026: AI cost and cost on pace, requests and failures, tokens in and out, average response time, cost per group and per day, and **Export CSV with cost** (their usage export plus AI requests and AI cost per group and month; the export is recorded in the operator log). **Clients never see cost, tokens, response times or models**: their Usage & billing shows activity counts and their AI allowance as a percentage, their audit log says "Added extra AI" without the amount, and their Activity steps keep timings only (`app/src/lib/firm-usage.ts`).
- **Plan terms**: custom limits (leave empty for the plan's number, type "unlimited" for none), the **AI credit per month** override, the **contract price per month** (Enterprise and managed clients; it's their revenue in MRR and margin), the **partner or referrer** who brought them, and **questions per person per hour** (default 60). **Save plan terms**.
- **Plan**: you can also put a client on **Enterprise** (not offered to buyers). Enterprise starts from its own defaults (unlimited groups, 1,000 people, 2,400 meeting hours, $3,200 AI credit, 100 live meeting hours) until you set terms.
- **AI use by model** includes **Cached**: the share of input read from the prompt cache (cheaper). The stable part of each prompt (instructions and the client's guardrail rules) is cached; short prompts are below the model's minimum and won't show cache reads.

**AI running costs and resilience** (all in `app/src/lib/claude.ts`): busy or overloaded answers from Claude are retried with backoff (`SIDEKICK_CLAUDE_RETRIES`, default 3); after that people see "Sidekick's AI is very busy right now. Try again in a minute." Daily reminder digests go through Claude's **Batch API** at half price and are posted a few minutes later than before (`SIDEKICK_BATCH=off` makes them live again). Each feature's model stays configurable (`SIDEKICK_MODEL_*`); change one only after comparing answers. Claude Haiku 5.5 is the candidate for cheap jobs such as the guardrail check and reminder wording. Live meeting hours are an Enterprise-only limit, ready for when Sidekick can join calls.

Top-ups and terms are recorded in the operator log and the client's own audit log ("Sidekick team").

**Revenue rules (test-mode prices):** an active Starter/Team/Business plan = the plan price plus $129 per extra group (whatever the number of people); Enterprise and managed = the contract price you set; trials, failed payments and canceled plans = $0. Margin = revenue − this month's AI cost.

## One client's page
Click a client on **Clients** to see:
- **People**: everyone in that organization with their role, the workspaces they can use ("All groups" for Org Owners and Org Admins), whether they sign in with Microsoft or a password, and when they were last active.
- **Plan**: plan, status and the controls to change them (see above).
- **Limits this month**, **AI credit** (with top-ups and AI use by model), **AI use this month** and **Plan terms** (see "Plan limits, AI credit and plan terms").
- **Workspaces**: each one with its number of members, documents and meetings.
- **Restrictions for this client**: the same switches as the kill switches, but for **this client only**, for example turning off the in-app assistant or document uploads for one organization. Their people see a calm notice (not an error dialog): "… is turned off for your organization by the Sidekick team", with "contact the Sidekick team" for their Org Owner and "ask your Org Owner" for everyone else. It isn't listed under App errors and doesn't count as a Claude error. A feature paused for everyone stays off whatever this switch says.

Opening the page is recorded in the operator log once per visit ("Viewed the people and workspaces of …"; flipping switches on the page doesn't add more), and each restriction is recorded in both the operator log and the client's own audit log. The page shows names and counts only, never document or meeting content.

People, roles and workspace access are still managed by the client's own Org Owner or Org Admin on **Users & access**.

## Roll-offs: deletion and certificates
- **Group roll-off**: a client's Org Owner/Admin ends a group (engagement over); it's read-only, unlinked from Teams and out of the group count until its date, then deleted by the job queue (`rolloffs.run`, every 5 minutes) with `deleteWorkspace`, search entries included.
- **Organization roll-off**: starts when a client cancels (deleted 30 days after the paid period ends), when you set **Canceled**, or with **End client…** (deleted 30 days from now). Deletion removes every row with the organization's id (groups, content, people and their sign-ins and two-step factors, Teams links and waiting chats in their tenant, settings, subscription, terms, usage and AI records, traces, the audit log) and then the organization. A test reads the real schema and fails if a table with `org_id` is missed (`ORG_TABLES` in `lib/rolloff.ts`). Activity traces that finish while the deletion runs (including the deletion's own steps) are dropped rather than saved, so nothing with the organization's id appears afterwards; only the roll-off record with its certificate and your operator log line remain.
- **What's kept**: only the `rolloffs` row (organization and group names, dates, who asked, the certificate's counts) and the operator-log line. That's your proof of deletion and billing record; Stripe would keep its own billing history later. Database backups age out within 35 days (Azure PostgreSQL retention).
- **Certificates** never contain content: kinds of data and counts, dates, who asked and who ran it, and the backup sentence. After an organization is deleted nobody there can sign in, so send them the certificate from **Roll-offs** if they ask.

## Support
**Support inbox.** Tickets arrive from the portal (**Help & support → Contact support**), the Help chat (**Turn this into a ticket**, with what it checked), the public **/support** form and the website help bot (**Talk to a human**, with the visitor's conversation, already masked). Filter by status (**Open**, **Waiting on customer**, **Resolved**, All, with counts), priority, client ("Website" = no organization), category and search (subject, reference, name, email). A dot marks new customer activity. Tickets from clients whose plan includes **priority support** (Business, Enterprise, and managed clients without a subscription) are listed first with a **Priority support** label: answer those first. Open a ticket to see:
- the thread, attachments (always downloaded, never opened in the browser) and **internal notes** (yellow; never shown to the customer or written in their audit log);
- the contact details and the page they were on; who it's assigned to (**Assign to me**);
- the **client**: plan and status, its **recent errors by reference code** (14 days, from its own requests, with the error log's message) and any reference code quoted in the thread;
- **What the Help chat checked**, when the ticket came from it.

Actions: **Send reply to customer** (status becomes *waiting on customer*, and they get a dot on their assistant button), **Add internal note**, assign, priority, **Resolve** / **Reopen**. A customer reply reopens a waiting or resolved ticket. Every action is in the operator log and, for a client's ticket, in that client's audit log ("Sidekick team replied…"). Notifications are in the app only for now; email notifications will be added later (the hook is `notify` in `app/src/lib/support.ts`).

**Support articles.** Three levels: **Public** (help center under "Known issues and fixes", the help bot and the Help chat), **Customers, when relevant** (only the Help chat uses them, when they fit a customer's question; never listed) and **Internal** (only you; never reach any assistant or customer). Drafts are used nowhere until published. Six known issues are seeded (group-chat consent setting, plain-text @Sidekick vs a real mention, temporary passwords, a team's first channel name, the authenticator server key (internal), essentials-only AI credit); deleting a seed unpublishes it instead. On a **resolved** ticket, **Draft an article** has Claude write a draft (customer level, contact details removed) for you to review, edit and publish. Each article shows how often the assistants cited it, how many tickets followed and how many of those were resolved.

**Help bot.** The website's "Ask about Sidekick" (round button on every public page): last 30 days by outcome (answered, "I don't know", refused by rule, hit a limit, budget spent or paused), today's spend against its **daily budget** (`SIDEKICK_HELPBOT_DAILY_USD`, default $3; after that it shows FAQ answers), its limits (20 questions per visitor and 60 per network an hour) and the **questions it couldn't answer** (masked, kept 30 days): add an FAQ entry or a public article, then **Mark done**. Its rules: public help content only; cited answers or "I don't know"; on-topic only; no legal, HR, medical or financial advice; jailbreak, prompt-injection, hate and swearing checks (on follow-ups too); it never asks for personal data and masks it before storing; it says it's an AI. It runs on the cheapest model by default (`SIDEKICK_MODEL_HELPBOT`, Haiku); `npm --prefix app run helpbot:check` asks the real Claude a few questions to confirm quality before and after a model change. Sidekick pays for it (no client's AI credit). Switches on **Releases & switches**: **Public help bot** (paused = FAQ only), **Support assistant** (the Help chat, also restrictable per client) and **Follow-up questions** (paused = follow-ups treated as new questions).

## Pausing a client
A paused organization can't use the portal or any feature, and Sidekick stops answering in its Teams channels. Its data is kept and comes back as it was on **Resume**.

## What owners can't do
Owners see usage, health, counts and who belongs to each client, but the console has no way to sign in as a client user or read a client's documents.

## When Sidekick grows (scale)
The numbers behind these are in `docs/SCALE.md`; the costed Azure steps in `docs/HOSTING.md` → Scaling up.
- **Fair shares.** Each app copy runs at most 24 Claude calls at once and at most 6 for one client
  (`SIDEKICK_CLAUDE_CONCURRENCY`, `SIDEKICK_CLAUDE_ORG_CONCURRENCY`); a client asking hundreds of questions at
  once waits its turn instead of slowing everyone. Background jobs: 4 at once per copy, at most 2 per client.
  Time spent waiting for a turn shows on the AI steps of a trace (`queued_ms`).
- **Job queue page.** The oldest wait should stay under 15 minutes. Longer: add an app copy (step 3 of
  Scaling up) or raise `SIDEKICK_JOB_CONCURRENCY`.
- **Clean-up.** An hourly job (`data.retention`) deletes old traces (30 days), AI usage details and audit
  entries (13 months), guardrail counts (6 months), errors (90 days) and expired sign-in rows. Client content
  is never touched by it.
- **Slow queries.** Set `SIDEKICK_SLOW_QUERY_MS=300` on the Container App for a day to log slow queries (SQL
  only, no values). Runbook: "Slow pages or AI is very busy".

