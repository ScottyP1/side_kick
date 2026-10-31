# Sidekick live in Teams meetings

> Oct 29, 2026. Cody: *"this is the main feature of the whole application: a bot inside a Teams meeting that listens,
> analyses the chat, the live meeting, previous meetings, the database, everything about that client. It can raise its
> hand, answer questions, ask questions: it's a real meeting member."*
>
> Part 1 is the research: which meeting bot, self-hosted options first. Part 2 is the design, built in
> `app/src/lib/live-meetings/` and tested against fake bots. Part 3 covers the stages and the pricing options for Cody.
> Part 4 is what Cody must sign up for or approve.
>
> **Nothing has been paid for, signed up for or deployed.** Updated Oct 31, 2026 (stage 2 in code): the bot now runs
> **only during meetings**, as one Azure Container Apps job execution per meeting, with a cost meter and a platform
> cap ("Runs only during meetings", "Spending controls" in Part 2). The AKS design below is kept as the comparison.

## Why a browser-based meeting bot

Sidekick already writes notes **after** a Teams meeting, from Microsoft Graph transcripts (`lib/meetings-graph.ts`).
To take part **during** the meeting, it has to hear the meeting as it happens.

Microsoft's own way is the real-time media platform. It only runs as a Windows/.NET bot hosted in Azure, and Graph has
no raise-hand API (docs/PROGRESS.md → Gotchas).

The alternative is a **browser-based bot**. It opens the Teams web client in a headless Chrome and joins like a
person, so it can hear the meeting and read its chat. It can also post in the chat, click buttons (Raise hand) and play
audio into its microphone. It runs as a Linux container.

---

## Part 1: research (Oct 29, 2026)

### Cody's must-haves, per option

Each cell says **yes**, **no** or **partly**, with the source.

| Must-have | **Attendee** (self-host) | **Vexa** (self-host) | **Recall.ai** (hosted) | **Meeting BaaS** (hosted) | **Nylas Notetaker** (hosted) |
|---|---|---|---|---|---|
| 1. Hear a spoken question addressed to Sidekick | **yes**: `transcript.update` per utterance, from Teams' own captions or a speech provider [^att-tr][^att-wh] | **yes**: real-time Whisper transcripts [^vexa] | **yes**: `transcript.data` in 1–3 s [^rc-rt][^rc-lat] | **partly**: streams raw audio only, so we'd run speech-to-text ourselves [^mb] | **no**: transcripts only after the call [^nylas] |
| 2. Answer in the meeting chat with sources | **yes**: `send_chat_message`, Teams accepts basic HTML [^att-api] | **no**: Teams chat isn't wired up (v0.12: reads return an empty list, writes 405) [^vexa-st] | **yes**: `send_chat_message`, Teams, 4,096 chars, not channel meetings [^rc-chat] | **yes**: send chat message [^mb] | **no**: one automatic intro message only [^nylas] |
| 3. Raise its hand in Teams | **partly**: no endpoint in Attendee; we add a small patch that clicks Teams' Raise button, as Attendee already clicks Join and Leave [^att-ui] | **no** | **no**: no API (checked the full docs index) [^rc-idx] | **no** | **no** |
| 4. Speak the answer aloud | **yes**: `output_audio` plays an MP3 we make with Azure AI Speech [^att-api] | **no**: `speak` answers 404 in v0.12 (audio path built, not exposed) [^vexa-st] | **yes**: Output Audio / Output Media [^rc-idx] | **yes**: speaking bots / output audio websocket [^mb] | **no** |
| 5. Answer questions typed in the chat | **yes**: `chat_messages.update` webhook [^att-wh] | **no**: Teams chat reader not in production [^vexa-st] | **yes**: chat message events [^rc-idx] | **yes**: `bot.chat_message` webhook [^mb] | **no** |

Microsoft Graph itself has no raise-hand API, and no hosted vendor offers one. A **browser bot we run ourselves** is
the only route to a real Teams hand, through a patch we own.

### Self-hostable options (first choice: meeting audio stays with Microsoft and in our Azure)

#### Attendee (recommended)
Attendee is open source under the Elastic License 2.0. We may run and change it for our own product; we may not resell it as a hosted service.
- **How it joins Teams:**
  - By default as a guest through the Teams web client: Chrome driven by Selenium, which fills in the name and clicks Join.
  - Optionally signed in with a dedicated Microsoft 365 account (`teams_settings.use_login`), for meetings that require sign-in [^att-si].
  - Like any guest it waits in the lobby unless the meeting lets everyone in.
  - Reliability: it depends on the Teams web client's UI. Attendee's maintainers track Teams' changes, and its code
    copes with lobby time-outs, "we couldn't connect you", sign-in walls and captchas [^att-ui].
- **Transcription without a new vendor:** it can use **Teams' own live captions**. Microsoft makes them inside Teams;
  they're free, low latency, and identify speakers. The audio never leaves Microsoft and our Azure [^att-tr].
  - The alternative is raw audio over a websocket [^att-rta] to **Azure AI Speech** in our subscription: better quality,
    $1 per audio hour. That needs a small streaming service of ours (stage 2).
  - Attendee's built-in providers (Deepgram, OpenAI, Gladia and others) would add a vendor, so we don't use them.
- **Speaking:** `POST /bots/:id/output_audio` with an MP3. We make the MP3 with **Azure AI Speech** text-to-speech in our
  subscription: neural voices at $15 per million characters, 0.5 million free a month [^az-speech]. A spoken answer is
  about 200 characters, so this costs nothing to speak of.
- **Raising its hand:** Attendee has no endpoint. Our patch adds `POST /bots/:id/raise_hand {raised}`, which clicks
  Teams' Raise/Lower hand control in the meeting toolbar, through the same path Attendee uses for chat messages
  (`meetbot/patches/README.md`). It is designed but **not written yet**: the Teams button's selector has to be read in a
  real meeting on the trial. We maintain it ourselves; Sidekick only uses it when `ATTENDEE_RAISE_HAND=1`, and
  otherwise falls back to "✋" in the chat.
- **Hosting in our Azure, as first planned (superseded):** Linux only, no Windows.
  - The pieces: Attendee's Django app with a Celery worker, Redis, and a Postgres database (a new database on our
    existing server).
  - Production runs **each bot in its own Kubernetes pod**, so we'd use AKS; its control plane is free on the Free tier.
  - Estimates, to measure on the trial:
    - one small node (2 vCPU / 8 GB) for the app and worker: ~$70/month;
    - Azure Cache for Redis Basic: ~$16/month;
    - a bot node pool of 4 vCPU / 16 GB nodes at ~$0.19/hour each, holding about 3 Chrome bots per node, so about $0.07 per bot-hour;
    - no GPU (captions and Azure AI Speech do the speech work).
  - **Always-on vs on demand:** a node pool scaled from zero takes minutes to start, too slow for a meeting starting now.
    So we keep one bot node warm in business hours (~$40/month) and let more scale up for busy hours.
- **Maintenance risk (the real cost):**
  - A Teams web UI change can break joining, captions or our raise-hand click until it's patched. Upstream patches
    joining and captions (it's their product); the raise-hand patch is ours.
  - Mitigations: pin a tested Attendee version; a daily synthetic join of a Sidekick Labs test meeting that alerts on
    failure; on any failure the session shows the reason, Sidekick falls back to "✋" in the chat and to chat-only
    answers, and the notes still come from Graph afterwards.

#### Vexa
Open source (Apache 2.0) and self-hosted, with Whisper speech-to-text on our own GPU (or CPU, slower).
- Joining Teams works, and its transcripts are good.
- On its own status page (checked Aug 20, 2026, v0.12), the **chat in Teams isn't wired up** and **`speak` answers
  404**. It also has no raise hand. It fails must-haves 2–5 today [^vexa-st].
- Self-hosting Whisper well needs a GPU node (~$400+/month for a small NVIDIA T4 VM), all day.
- **Not recommended now**; worth a look again if its speak and chat ship.

#### Others
I found no other maintained, self-hostable Teams bot with chat, speech and an API comparable to Attendee's. Building
our own browser bot would mean re-doing what Attendee already maintains.

### Hosted options (second choice: another company receives the meeting audio)

#### Recall.ai (the hosted fallback, a per-organization opt-in)
- **Must-haves:** yes / yes / no / yes / yes. It has no raise hand, so Sidekick puts "✋" in the chat.
- **Price:** $0.50/hour for the bot plus $0.15/hour for its transcription. First 5 hours free, billed per second, no platform fee [^rc-price].
- **Data:** regions in the US, EU and Japan (data stays in the chosen region) [^rc-reg]. SOC 2, ISO 27001, GDPR and a
  DPA. Retention is configurable and media can be deleted by API [^rc-store].
- **Teams:** a guest bot by default. A signed-in bot needs a separate Microsoft 365 tenant with security defaults
  turned off [^rc-si]. Either way it waits in the lobby unless the meeting settings let it in [^rc-lobby].

#### Meeting BaaS
- **Price:** $0.35–0.50/hour in prepaid tokens, with plans from $0 to $299/month [^mb-price].
- It streams raw audio, so we'd add speech-to-text ourselves, and it has no hand.

#### Nylas Notetaker
- **Price:** $0.65–0.80/hour [^nylas-price].
- It works after the call only, so it fails the must-haves.

### Where meeting audio and text go

**Today, without live meetings:** Microsoft Teams makes the transcript, and Sidekick reads it through Microsoft Graph.
**Anthropic** (Claude) receives the transcript to write the notes; it doesn't train on it. That is already on the
sub-processor list.

| Option | Meeting audio | What was said (text) | Sidekick's answers and questions |
|---|---|---|---|
| **Attendee + Teams captions (default)** | Stays in Microsoft Teams. Our bot's container in **our Azure** receives the mixed audio stream as any participant does, but nothing records or sends it on | Teams captions → our bot → Sidekick (our Azure) → **Anthropic** (only what one answer or the running list needs) | Text: Sidekick → Teams chat. Speech: **Azure AI Speech (our subscription)** → our bot's microphone |
| Attendee + Azure AI Speech speech-to-text (stage 2 option) | Our bot → **Azure AI Speech in our subscription** (same Azure account, no new company) | Same as above | Same as above |
| **Recall.ai (opt-in)** | **Recall.ai** receives and transcribes it in the region we pick; recordings kept as briefly as Recall allows | Recall.ai → Sidekick → Anthropic | Recall.ai posts and plays them |
| Meeting BaaS | Meeting BaaS, then our speech-to-text | Same as above | Same as above |

### Expected latency (to measure on the first trial)

The targets are: hand up within about 2 s of the question, spoken answer within about 5–8 s. Every answer records
heard → hand, heard → spoken and heard → chat in its trace (Activity page), so the trial gives real numbers.

**Attendee + Teams captions, hand up:** about **1.5–3 s**.
- The caption is final about 1–2 s after the speaker pauses.
- The webhook takes about 0.1 s, and our raise-hand click about 0.3–0.7 s.
- Hand-raising happens *before* Claude runs.

**Attendee + Teams captions, spoken answer:** about **5–10 s** with the default model, about **4–7 s** with a faster one.
- The guardrail check, search and answer take about 4–8 s on the default model, or 2–4 s with `SIDEKICK_MODEL_ASK=claude-sonnet-5-5`.
- Azure AI Speech takes about 0.3–0.8 s for 1–2 sentences, and audio starts playing about 0.3 s later.
- To reach 5–8 s reliably, stage 2 streams the answer: it speaks the first sentence as soon as Claude has written it,
  while the full sourced answer follows in the chat.

**Recall.ai:** hand is "✋ in the chat" about 2–4 s after the question; the spoken answer is about the same as Attendee's.

**A question to the room:** a deliberate wait of about 5 s comes first, to let a person answer.

### Recommendation

1. **Default:** **Attendee, self-hosted in our Azure (AKS)**, with Teams captions, Azure AI Speech for the spoken
   answers and our raise-hand patch.
   - It is the only option that meets all five must-haves.
   - It keeps meeting audio away from any new company.
2. **Hosted alternative:** **Recall.ai**, as a per-organization opt-in for clients who prefer it. It shows on the
   sub-processor page as applying only to those clients.

### Monthly cost

**Now (Oct 31): one Container Apps job execution per meeting, nothing between meetings.** Azure retail prices, East US,
pay as you go (pulled Oct 31): container $0.000024 per vCPU-second and $0.000003 per GiB-second (the free grant is
already used by `sidekick-app`); Azure AI Speech speech-to-text $1.00 per audio hour, text-to-speech $15 per million
characters. Per meeting hour at 2 vCPU / 4 GiB: container $0.216 (×1.05 for the early start ≈ $0.23), speech-to-text up
to $1.00 (only the minutes captions don't cover; $0 when Teams captions work), voice ≈ $0.09.

| Meeting hours / month | Container | Speech-to-text (worst case: all minutes) | Voice | Azure total | + Claude |
|---|---|---|---|---|---|
| 5 | $1.15 | $5 | $0.45 | ≈ $6.60 | ≈ $8.35 |
| 20 | $4.55 | $20 | $1.80 | ≈ $26 | ≈ $33 |
| 100 | $23 | $100 | $9 | ≈ $132 | ≈ $167 |

Fixed monthly cost **$0**: no AKS, no Redis service, no warm node (Redis runs in the container; Attendee's database is a
new database on our existing Postgres server; the image fits the existing registry). If Chrome needs 4 vCPU / 8 GiB the
container part doubles. With Teams captions working, the hour costs ≈ $0.32 plus Claude. The table below is the
earlier AKS design, kept for comparison.

Claude's part (answers, the running list, its questions) goes through the organization's AI credit and is about
**$0.30–0.40 per meeting hour** on the default model.

| Meeting hours / month | Attendee self-hosted (our Azure) | Recall.ai | Claude (both) |
|---|---|---|---|
| 10 | ~$130 (mostly fixed: app node, Redis, warm bot node) | ~$6.50 | ~$4 |
| 100 | ~$140 | ~$65 | ~$35 |
| 1,000 | ~$200–250 (more bot nodes at busy hours) | ~$650 | ~$350 |

**Self-hosted costs more at low volume and much less at high volume**, plus our time to run it. Azure AI Speech is a
few cents a month at these volumes. These are East US list prices (Oct 2026); check them in the Azure calculator
before deploying.

---

## Part 2: design (built in `app/src/lib/live-meetings/`, tested against fake bots)

### Providers: self-hosted is the default
- **`provider.ts`:** the interface every bot implements:
  - `join`, `stop`, `sendChatMessage`, `raiseHand`, `speak`, `verify` (webhook signature), `parse` (events);
  - `can: { raiseHand, speak }`, what this bot can do.
- **`attendee.ts`:** our own bot (`ATTENDEE_BASE_URL`, `ATTENDEE_API_KEY`, `ATTENDEE_WEBHOOK_SECRET`,
  `ATTENDEE_RAISE_HAND=1` once the patch is deployed). Webhooks arrive at `/api/live/events/attendee`.
- **`recall.ts`:** Recall.ai (`RECALL_API_KEY`, `RECALL_REGION`, `SIDEKICK_LIVE_WEBHOOK_SECRET`). Webhooks arrive at
  `/api/live/events/recall`.
- **Per organization:** our own bot unless the **Org Owner** chooses the hosted one (`PUT /api/live/provider`,
  audited). That choice is shown on the group page, and the sub-processor page lists Recall.ai "only for organizations
  whose Org Owner chose the hosted meeting bot".
  - There is never a silent fallback to a hosted bot.
- **`speech.ts`:** Azure AI Speech text-to-speech (`AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION`). If it isn't set up,
  answers go to the chat only.

### How Sidekick is invited
- **Group switch** (group page → Teams chats → **Live in meetings**). It is set by the Team Lead or an Org Owner/Admin,
  and is Enterprise-only today:
  - **Off** (default);
  - **When someone asks**;
  - **Every group meeting**: joins at the start of each scheduled meeting that is clearly the group's, found by the
    transcription reminder's calendar read.
- **`@Sidekick join`** in the meeting chat (or `join <link>`), and **`@Sidekick leave`**.

### The live flow (a member of the meeting)

**Questions addressed to Sidekick** are always answered. They can come as:
- "Sidekick, …", said or typed;
- "…, Sidekick?";
- only "Sidekick?" followed by the question in the speaker's next line.

The answer goes like this:
1. **Hand up at once**, when the bot can.
2. **A short spoken answer**: the first sentence or two, no citations read aloud, never over anyone. This needs the
   group to allow speaking, the meeting not to be in quiet mode, and a confident answer.
3. **The full answer with sources** in the chat.
4. Hand down.

A refusal from the guardrails goes to the chat only.

**Questions to the room** (when the group's setting is "Also questions nobody answers", the default):
1. Sidekick waits about 5 s. If someone answers, it stays out.
2. If the answer is silence, "not sure", "good question" and the like, it asks the group's knowledge.
3. It only steps in when the answer is **confident**: found, cited from the group's knowledge (not only from this
   meeting), no conflict, not refused. Low confidence means it stays quiet.
4. When it steps in, it **raises its hand** and:
   - speaks when **called on** ("go ahead, Sidekick", "yes, Sidekick?");
   - or, with "Also speak after a pause", after N seconds of silence;
   - or, if nobody calls on it within a minute, lowers its hand and puts the answer in the chat ("In case it helps…").
   - With spoken answers off, the answer goes straight to the chat, with no hand.

**Never talks over anyone:** it tracks who is speaking (the bot's speech start/stop events) and only speaks after
silence.

**Sidekick asks questions too:** when the running list has an action item with no owner or date, it asks once
("Quick check: by when should Lou do 'update the runbook'?"), with the same etiquette. The group can switch this off.

**Quiet mode for one meeting:** "Sidekick, quiet" means it only answers when asked, in the chat, with no hand and no
voice. "Sidekick, you can speak up" undoes it.

**Context** is everything about that client, within the group's walls:
- the live meeting so far, including its chat, as a cited source ("This meeting so far");
- past meetings and their notes, the group's documents, the firm library and connectors, through the normal Ask search.

The guardrails apply to every answer (`screenTurn` before; `checkGrounding` and `cleanOutput` after). **Judging
people is always refused in meetings**, whatever the organization's switch says. Each person's connector rules apply,
and everyone in a meeting counts as unverified, so personal connector items are never used.

**Client guests:** once a guest is seen, only **Shareable** sources are used, and Sidekick says so once in the chat.
A guest is seen when:
- the meeting chat is marked as having guests;
- invitees come from another organization;
- someone shown as "(Guest)" or "(External)" joins.

**Per-group settings** (defaults are Cody's, Oct 29): answer mode **also questions nobody answers**; speaking **when
asked or called on** (also: chat only, or also after a pause of 2–30 s); **asks its own questions** on.

**Running list** of decisions and action items: Claude feature `live`, updated every 12 lines. "Sidekick, recap"
reads it back.

### Stopping, notes, limits

**When it leaves:**
- the meeting ends;
- someone says "Sidekick, leave", types `@Sidekick leave`, or presses Stop;
- this month's live hours run out;
- it has been there 4 hours;
- nobody admits it from the lobby within 15 minutes;
- the kill switch is used.

**Notes afterwards:** written exactly once. The Teams transcript claims the session if one exists; otherwise the
live transcript goes to `meetings.notes` (compare-and-set on `live_sessions.handoff`).

**Bookkeeping:**
- Hours count against `liveMeetingHours`.
- Joins, leaves, settings and the provider choice are audited.
- Every step is a trace span of kind `live`, with timings.
- The new tables are covered by row-level security.
- The Owner Console's **Live meetings** page shows sessions, hours and failures per client.

---

### Runs only during meetings (stage 2, built against fakes)
- **One Container Apps job execution per meeting** (`sidekick-meetbot` in `sidekick-env`, consumption, East US):
  - It starts about 2 minutes before a group meeting, or when someone types `@Sidekick join`.
  - It exits when the meeting ends or Sidekick is stopped.
  - Sidekick starts it through Azure Resource Manager with its managed identity, which has a role on that job only
    (`lib/live-meetings/launcher.ts`).
  - The meeting's settings go in as environment overrides; the job's secrets are referenced by name.
- **The image** (`meetbot/`): Attendee v1.89.2, built from its own Dockerfile at the tag, plus our patches, Redis and
  the shim.
  - Attendee's web API and worker listen on 127.0.0.1 only.
  - Its API key and webhook secret are made inside the container at start (`bootstrap.py`) and never leave it.
  - Its database is `attendee` on `sidekick-labs-db`.
  - Size: start at 2 vCPU / 4 GiB and measure.
  - At most 4.5 hours per execution, so a stuck bot can't run on.
- **The shim** (`meetbot/shim/`). Jobs have no inbound address, so it connects **out**:
  - It forwards Attendee's events to `/api/live/events/attendee`, signed with the session's own key: an HMAC of the
    session id with `SIDEKICK_MEETBOT_SECRET`, so a container can only act for its own meeting.
  - It long-polls `/api/live/bot/commands` for chat, speak, hand, hearing and leave.
  - It exits with the meeting.
  - If a container doesn't exit within 3 minutes of the end, `live.watch` stops the execution in Azure.
- **Hearing:**
  - Teams live captions first: free, and Microsoft transcribes inside Teams.
  - Automatic fallback to **Azure AI Speech speech-to-text** in our subscription when captions can't be turned on, or
    when people have talked for 20 s with no caption (`rules.ts hearingNext`).
  - Back to captions once they're fresh again, after at least 2 minutes.
  - Each minute records which source it used (`live_hearing`) for the cost meter.
  - The audio only goes to Azure Speech while speech-to-text is on; otherwise the shim drops it.
- **Startup (estimate, to measure):** pulling and starting the image takes about 45–90 s (a large Chrome image, and the
  consumption plan doesn't guarantee a cached image), then joining Teams and the lobby about 10–20 s. Starting 2
  minutes early covers scheduled meetings; `@Sidekick join` takes about 1–2 minutes.

### Spending controls (stage 2, built)
- **Cost meter**, on the Owner Console → **Live meetings** page:
  - this month's estimate in dollars and "on pace for", with meeting hours, next to the AI spend;
  - worked out as container seconds × the rates above + speech-to-text minutes × $1/h + spoken characters × $15/M
    (+ Recall.ai hours × $0.65 for opted-in clients);
  - taken from Sidekick's own records (`lib/live-meetings/spend.ts`), with no Azure billing API.
- **Platform-wide hard cap**, set by Cody on that page, in dollars or meeting hours a month. **$50 by default.**
  - At 80%: a warning. At 100%: an alert. Both go to the operator log once per month and show on the Owner Console home.
  - Once reached, Sidekick joins no new meetings and says "Live help is paused…" (the reply to `@Sidekick join`, or
    once in the meeting's chat for automatic joins).
  - Meetings already running finish, and notes after meetings still work.
  - Per-customer plan limits are unchanged.
- **Azure budget** `sidekick-meetbot-monthly` on the resources tagged `sidekick-meetbot=1`, emailing at 50/80/100%.
  **Azure budgets only warn and never stop anything**; the app's cap is what stops spending.
- **Setup:** `infra/azure/meetbot-setup.sh`, idempotent az CLI. It only runs with `CONFIRM=yes`. Runbook:
  docs/RUNBOOKS.md → "Meeting bot".

### First live trial (stage 2, after Cody's OK)
1. Run `CONFIRM=yes BUDGET_EMAIL=… infra/azure/meetbot-setup.sh`.
2. Turn Live in meetings on for a Sidekick Labs group (Enterprise).
3. Hold a meeting with two test users, then `@Sidekick join` and try each must-have.
4. Measure and write down:
   - startup time;
   - heard → hand, heard → spoken and heard → chat (Activity traces);
   - container CPU and memory (Azure metrics), to settle the 2 vCPU / 4 GiB size;
   - caption quality against speech-to-text.
5. Find Teams' Raise hand selector and write `meetbot/patches/02-raise-hand.patch`. Then set `ATTENDEE_RAISE_HAND=1`.
6. **Record footage for the pitch video and website** (Cody, Oct 31: the only footage still missing). Screen
   recordings and screenshots of:
   - "Sidekick (notes)" in the lobby and joining;
   - its first chat message;
   - its hand going up;
   - a spoken answer, with the sourced answer in the chat;
   - a question to the room it answers when called on;
   - its own question about an owner or date;
   - the group page's running list during the meeting;
   - the notes card afterwards;
   - the Owner Console cost meter.

   Use made-up meeting content and the Sidekick Labs test users only. The clips go to `~/Desktop/Sidekick Pitch`; a
   few polished shots go to `app/public/site/` through a PR.

## Part 3: stages and pricing

### Stages
- **Stage 1: this PR, all against fake bots.**
  - The provider layer: self-hosted default, Recall.ai opt-in.
  - Invites.
  - Hearing speech and chat; addressed questions and questions to the room; the confidence bar.
  - The hand, being called on, never interrupting, spoken answers through Azure AI Speech, sourced chat answers.
  - Quiet mode; its own questions about owners and dates.
  - The running list, the guest wall, the context of this meeting so far plus the group's knowledge.
  - Notes written once, plan hours, audit, trace, the Owner Console.
- **Stage 2, code: built against fakes (Oct 31).** The bot runs only during meetings (one job execution each), with
  the outbound shim, the captions → Azure speech-to-text fallback, the cost meter, the platform cap with alerts, and
  the setup script.
- **Stage 2, deploy: needs Cody's OK.**
  - Run `infra/azure/meetbot-setup.sh`: the Speech resource, the job, the budget.
  - Run the first live trial in Sidekick Labs, **measure latency and size**, and record the footage (above).
  - Write the raise-hand patch.
  - Stream the answer: speak the first sentence while Claude still writes, with a faster model for the spoken part.
  - Compare Teams captions with Azure AI Speech speech-to-text.
  - Add a daily synthetic join test with an alert.
- **Stage 3: a sharper teammate.**
  - Notice when something said contradicts an earlier decision or a document ("this conflicts with the Oct 12
    decision…"), and point out gaps.
  - Suggest follow-ups.
  - A per-meeting switch in the Teams meeting side panel.
  - Handle being interrupted while speaking.
  - Support more languages.

### Pricing options (for Cody to decide; nothing changed yet)
Live meetings were planned as an **Enterprise-only add-on**: 100 live hours a month, `lib/plans.ts`. Since this is now
the main feature, the options are:
1. **Keep it Enterprise-only.**
   - Simplest, and the highest margin per client.
   - But the main feature is invisible to Starter, Team and Business buyers.
2. **Every plan gets an hours allowance**, for example Starter 5 h, Team 20 h, Business 60 h, Enterprise 200 h, with
   extra hours at about $2/hour.
   - Shows the main feature everywhere.
   - Our cost per hour is about $0.40 (self-hosted at volume, plus Claude) to $1.00 (Recall plus Claude).
3. **A paid add-on on any plan**, for example $99 per group per month with 20 h.
   - Keeps base prices as they are and makes the feature an upgrade.

`assertFeature("liveMeetings")` and `assertCanAdd("liveMeetingHours")` already gate it, so any option is a change to
`lib/plans.ts` only.

---

## Part 4: what Cody must sign up for or approve

Nothing below has been done. For the default, self-hosted route:
1. **Approve running the setup script** (`infra/azure/meetbot-setup.sh`, `CONFIRM=yes`). It creates:
   - an Azure AI Speech resource (S0, East US);
   - the Container Apps job `sidekick-meetbot` in the existing environment;
   - a new database on the existing Postgres server;
   - two images in the existing registry;
   - Key Vault secrets;
   - a $50/month Azure budget emailing Cody at 50/80/100%.

   No fixed monthly cost. About $1.32 per meeting hour at worst (speech-to-text for every minute), ≈ $0.32 when Teams
   captions work, plus Claude.
2. **Set the platform cap** in the Owner Console → Live meetings ($50/month until changed).
3. **Approve deploying Attendee** (Elastic License 2.0: fine for our own use, not for reselling Attendee itself) with
   our patches. Its credentials are made inside each container; nothing to put in Key Vault by hand.
4. **Sidekick Labs Teams settings**, for the first trial:
   - allow anonymous users to join meetings (or give the bot a signed-in account);
   - allow live captions;
   - let someone admit "Sidekick (notes)" from the lobby.
5. **Decide the pricing option** above.

Only if a client asks for the hosted route:
- a **Recall.ai** account (free to create, 5 hours free), region US East or EU;
- its API key and webhook secret in Key Vault;
- accepting Recall's **DPA**;
- that client's Org Owner choosing it in the portal.

**What a customer's IT must approve:**
- Sidekick's Teams app (already);
- anonymous join, or trusting the bot account's tenant;
- live captions;
- admitting "Sidekick (notes)" from the lobby.

Only for the hosted route, Recall.ai as a sub-processor.

---

[^att-tr]: Attendee, Transcription: https://github.com/attendee-labs/attendee/blob/main/docs/transcription.md (read Oct 29, 2026)
[^att-wh]: Attendee, Webhooks (triggers, payloads, signature): https://github.com/attendee-labs/attendee/blob/main/docs/webhooks.md
[^att-api]: Attendee API reference (output_audio, speech, send_chat_message): https://github.com/attendee-labs/attendee/blob/main/docs/openapi.yml
[^att-ui]: Attendee Teams UI automation: https://github.com/attendee-labs/attendee/blob/main/bots/teams_bot_adapter/teams_ui_methods.py
[^att-si]: Attendee, Signed-in bots: https://github.com/attendee-labs/attendee/blob/main/docs/signed_in_bots.md
[^att-rta]: Attendee, Realtime audio: https://github.com/attendee-labs/attendee/blob/main/docs/realtime_audio.md
[^vexa]: Vexa docs: https://docs.vexa.ai/llms.txt
[^vexa-st]: Vexa status ("honest capability truth tables", checked by Vexa Aug 2026): https://docs.vexa.ai/roadmap/status.md
[^rc-rt]: Recall.ai, Real-time transcription: https://docs.recall.ai/docs/bot-real-time-transcription
[^rc-lat]: Recall.ai Transcription (latency modes): https://docs.recall.ai/docs/recallai-transcription
[^rc-chat]: Recall.ai, Sending chat messages: https://docs.recall.ai/docs/sending-chat-messages
[^rc-idx]: Recall.ai docs index (no raise-hand API; output audio; chat events): https://docs.recall.ai/llms.txt
[^rc-price]: Recall.ai pricing: https://www.recall.ai/pricing and https://recall.ai/blog/new-recall-ai-pricing-for-2026
[^rc-reg]: Recall.ai regions: https://docs.recall.ai/docs/regions
[^rc-store]: Recall.ai storage and retention: https://docs.recall.ai/docs/storage-and-playback
[^rc-si]: Recall.ai signed-in Teams bots: https://docs.recall.ai/docs/setting-up-signed-in-bots-for-microsoft-teams
[^rc-lobby]: Recall.ai, Bypass the Teams lobby: https://docs.recall.ai/docs/teams-bots-bypass-the-lobby
[^mb]: Meeting BaaS docs: https://docs.meetingbaas.com/llms/all
[^mb-price]: Meeting BaaS pricing: https://www.meetingbaas.com/en/pricing
[^nylas]: Nylas Notetaker docs: https://developer.nylas.com/docs/v3/notetaker
[^nylas-price]: Nylas pricing: https://www.nylas.com/pricing/
[^az-speech]: Azure AI Speech pricing: https://azure.microsoft.com/pricing/details/speech/ (real-time speech-to-text ~$1/hour, neural text-to-speech ~$15 per 1M characters; East US, Oct 2026)
