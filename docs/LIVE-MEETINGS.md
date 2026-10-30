# Sidekick live in Teams meetings

> Oct 29, 2026. Cody: *"this is the main feature of the whole application: a bot inside a Teams meeting that listens,
> analyses the chat, the live meeting, previous meetings, the database, everything about that client. It can raise its
> hand, answer questions, ask questions: it's a real meeting member."*
>
> Part 1 is the research: which meeting bot, self-hosted options first. Part 2 is the design, built in
> `app/src/lib/live-meetings/` and tested against fake bots. Part 3 covers the stages and the pricing options for Cody.
> Part 4 is what Cody must sign up for or approve.
>
> **Nothing has been paid for, signed up for or deployed.**

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
  Teams' Raise/Lower hand control in the meeting toolbar. It is about 50 lines in `teams_ui_methods.py`, alongside the
  existing Join, Leave and captions clicks. We maintain it ourselves; Sidekick only uses it when
  `ATTENDEE_RAISE_HAND=1`, and otherwise falls back to "✋" in the chat.
- **Hosting in our Azure** (Linux only, no Windows):
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
- **Stage 2: needs Cody's OK to deploy.**
  - Deploy Attendee with the raise-hand patch on AKS in our subscription.
  - Create an Azure AI Speech resource.
  - Run the first live trial in Sidekick Labs and **measure latency**.
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
1. **Approve the Azure spend:** an AKS cluster (Free tier control plane), one small node plus a bot node pool, and
   Azure Cache for Redis Basic. About **$130/month** at low use; budgets and alerts as for the other services.
2. **Create an Azure AI Speech resource** (East US, S0) in our subscription. Pay per use; 0.5 M characters free a month.
   Its key goes in Key Vault as `AZURE_SPEECH_KEY`.
3. **Approve deploying Attendee** (Elastic License 2.0: fine for our own use, not for reselling Attendee itself) with
   our raise-hand patch. Its API key and webhook secret go in Key Vault, and `ATTENDEE_*` gets set on the Container App.
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
