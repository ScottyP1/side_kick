# Sidekick live in Teams meetings (Enterprise)

> Written Oct 29, 2026. Part 1 is research (which hosted meeting-bot service to use), part 2 is the design that is
> built in `app/src/lib/live-meetings/`, part 3 is what Cody has to sign up for or approve. **Nothing has been paid
> for or signed up for.** The code runs against a fake provider (tests) until Cody says go.

## Why a hosted meeting bot

Sidekick already writes notes **after** a Teams meeting from Microsoft Graph transcripts (`lib/meetings-graph.ts`).
To be useful **during** the meeting (answer "Sidekick, what did the client say about the cutover?", keep a running
list of decisions), Sidekick has to hear the meeting as it happens. Microsoft's own way is the real-time media
platform, which only runs as a Windows/.NET bot hosted in Azure (docs/PROGRESS.md → Gotchas). Cody chose a hosted
meeting-bot service instead: they run a browser-based bot that joins the meeting like a participant, stream the
transcript to us by webhook, and can post into the meeting chat.

---

## Part 1: research (Oct 29, 2026)

### The candidates

| | **Recall.ai** | **Meeting BaaS** | **Attendee** | **Vexa** | **Nylas Notetaker** |
|---|---|---|---|---|---|
| What it is | Hosted meeting-bot API, the market leader | Hosted meeting-bot API | Meeting-bot API, hosted **or self-hosted** (source available, Elastic License 2.0) | Meeting-bot API, hosted or self-hosted (Apache 2.0) | Notetaker add-on to Nylas's email/calendar API |
| Teams: scheduled meetings | Yes | Yes | Yes | Yes | Yes |
| Teams: Meet now / ad hoc links | Yes if it has a join link; direct 1:1 calls, webinars, town halls, live events, breakout rooms, GCC High **not** supported | Yes (any Teams join link) | Yes | Yes | Yes |
| Guest vs signed-in bot | Anonymous guest by default; optional **signed-in** bot (needs its own Microsoft 365 tenant, see below) | Anonymous; signed-in pool for Google Meet (Teams not documented) | Anonymous, or signed in with bot credentials | Anonymous | Anonymous |
| Lobby | Waits in the lobby unless the meeting lets everyone in; a person must admit it | Same (lobby time is billed) | Same | Same | Same |
| Real-time transcript | Yes: webhook or websocket, `transcript.data` per utterance with **speaker name**; built-in "low latency" mode **1–3 s** (English only), or Deepgram/AssemblyAI/etc. | Raw **audio** over websocket plus speaker events; we'd run our own speech-to-text | Yes, webhooks per utterance (third-party speech-to-text or Teams captions) | Yes (websocket) | **No** documented live stream (post-meeting files) |
| Post in the meeting chat | Yes, `send_chat_message` (Teams: to everyone, 4,096 chars, not channel meetings) | Yes, send chat message | Yes | Not stated | Only one automatic intro message |
| Speak | Yes (output audio / output media) | Yes (speaking bots) | Yes | Not stated | No |
| Price per meeting hour | **$0.50** + $0.15 built-in transcription = **$0.65**; billed per second; no platform fee | $0.35–0.50 (prepaid tokens) + transcription; plans $0–299/month | Hosted $0.50 → $0.35 with volume; self-host = our servers | $0.30 + $0.20 real-time transcription = $0.50; self-host free | $0.65–0.80 on $15–49/month plans |
| Free tier / trial | First **5 hours free** | 8 hours free | 5 hours free | $2 credit (~4 h) | 5 hours/month |
| Data region | **US (2), EU (Frankfurt), Japan**: separate deployments, data stays in the region | Not stated (examples use AWS Paris); "multi-zonal residency coming soon" | Wherever we run it (self-host) | Wherever we run it (self-host) | US or EU (agent accounts) |
| Retention | Set per bot; media deletable by API (no backups kept); 7 days free storage | 3–30 days by plan, auto-deleted | Ours (self-host) | Ours (self-host) | Not stated |
| Security papers | SOC 2, ISO 27001, GDPR, CCPA, HIPAA (BAA on Enterprise), trust portal, DPA linked | Trust center, SOC 2 not stated | None (self-host: ours) | None stated | Nylas is SOC 2 (Notetaker not stated) |
| API | REST + webhooks (Standard Webhooks HMAC signatures), SDK samples | REST + webhooks + websocket | REST + webhooks | REST + websocket | REST + webhooks |

Sources (all read Oct 29, 2026):
[Recall.ai pricing](https://www.recall.ai/pricing),
[Recall.ai 2026 pricing post](https://recall.ai/blog/new-recall-ai-pricing-for-2026) (published Mar 10, updated Sep 14, 2026),
[Recall Teams overview](https://docs.recall.ai/docs/microsoft-teams) (Aug 28, 2026),
[Recall signed-in Teams bots](https://docs.recall.ai/docs/setting-up-signed-in-bots-for-microsoft-teams) (Sep 29, 2026),
[Recall bypass the Teams lobby](https://docs.recall.ai/docs/teams-bots-bypass-the-lobby) (Oct 26, 2026),
[Recall sending chat messages](https://docs.recall.ai/docs/sending-chat-messages) (Oct 26, 2026),
[Recall real-time transcription](https://docs.recall.ai/docs/bot-real-time-transcription) (Oct 26, 2026),
[Recall transcription latency modes](https://docs.recall.ai/docs/recallai-transcription),
[Recall real-time event payloads](https://docs.recall.ai/docs/real-time-event-payloads),
[Recall webhook verification](https://docs.recall.ai/docs/authenticating-requests-from-recallai),
[Recall regions](https://docs.recall.ai/docs/regions),
[Recall storage and retention](https://docs.recall.ai/docs/storage-and-playback),
[Recall Teams product page](https://www.recall.ai/product/meeting-bot-api/microsoft-teams),
[Meeting BaaS pricing](https://www.meetingbaas.com/en/pricing),
[Meeting BaaS docs](https://docs.meetingbaas.com/llms/all),
[Attendee pricing](https://attendee.dev/pricing),
[Attendee on GitHub](https://github.com/attendee-labs/attendee) (licence: Elastic License 2.0),
[Vexa pricing](https://vexa.ai/pricing),
[Nylas pricing](https://www.nylas.com/pricing/),
[Nylas Notetaker docs](https://developer.nylas.com/docs/v3/notetaker),
[price comparison, checked Aug 31, 2026](https://apicostcalc.com/recall-ai-vs-meetingbaas-vs-vexa-cost-calculator.html).

Things the sources didn't settle (check on a trial before relying on them): exact Recall latency on Teams with
several speakers; whether Recall's chat message reaches anonymous-joined Teams meetings where the tenant only lets
signed-in people chat (Recall says the bot then needs to be signed in); Meeting BaaS and Vexa Teams chat support.

### Recommendation: Recall.ai (Pay As You Go), with Attendee self-hosted as the exit path

Why Recall.ai:
1. **Everything we need is documented for Teams**: real-time transcript with speaker names in 1–3 s, posting into
   the meeting chat, speaking later if we want it, lobby behaviour spelled out.
2. **Simplest to run**: no servers of ours, no speech-to-text of ours (Meeting BaaS streams raw audio, so we'd also
   need Azure Speech), webhooks signed with a standard HMAC scheme we can verify.
3. **Data story an enterprise IT team accepts**: SOC 2 + ISO 27001, a DPA, an EU region, retention we control and
   media we can delete by API. We don't need recordings at all: Sidekick asks for the transcript only and the
   shortest retention.
4. **Cheap to start**: no platform fee, first 5 hours free, per-second billing.

Why not the others now: **Meeting BaaS** makes us build speech-to-text; **Nylas** has no live stream; **Vexa** is
the cheapest but doesn't document Teams chat posting; **Attendee** is the best fallback: the same shape of API, and
if a customer insists that audio never leaves our Azure, we self-host it (a Docker image plus Postgres and Redis;
each meeting runs a headless browser, about 1–2 vCPU). Our provider interface means switching is one file.

### Monthly cost (Recall.ai Pay As You Go, list prices Oct 29, 2026)

Bot + built-in real-time transcription = $0.65 per meeting hour. Claude (answers + the running decisions list) is
extra and goes through the organization's AI credit like everything else: about **$0.30–0.40 per meeting hour** on
the default model, much less with `SIDEKICK_MODEL_LIVE=claude-haiku-5-5`.

| Meeting hours / month | Recall.ai | Claude (estimate) | Total |
|---|---|---|---|
| 10 | $6.50 (first month $3.25: 5 h free) | ~$4 | **~$10** |
| 100 | $65 | ~$35 | **~$100** |
| 1,000 | $650 (less with a volume deal; the startup programme is $0.25/h for the first 10,000 h) | ~$350 | **~$1,000** |

The Enterprise plan includes 100 live meeting hours a month (`lib/plans.ts`), so one Enterprise client costs about
$100/month at full use. For comparison: self-hosted Attendee or Vexa at 1,000 h would be our Azure compute
(~$150–300) plus speech-to-text (~$150–250) plus our time running it.

---

## Part 2: design (built, against a fake provider)

Code: `app/src/lib/live-meetings/` (provider interface, Recall-shaped adapter, sessions), route
`POST /api/live/events` (provider webhooks), group switch `PUT /api/workspaces/:id/live`, Owner Console page
**Live meetings**. Tests: `app/tests/meetings-graph.test.mjs` (fake provider server).

### Provider interface (`lib/live-meetings/provider.ts`)
```ts
interface LiveProvider {
  join(o: { meetingUrl, botName, webhookUrl, sessionId }): Promise<{ botId: string }>;
  stop(botId): Promise<void>;
  sendChatMessage(botId, text): Promise<void>;
  verify(headers, rawBody): boolean;           // webhook signature
  parse(body): LiveEvent[];                    // transcript line | status | chat message
}
```
`SIDEKICK_LIVE_PROVIDER=recall` picks the Recall adapter (`RECALL_API_KEY`, `RECALL_REGION` or `RECALL_BASE_URL`,
`SIDEKICK_LIVE_WEBHOOK_SECRET`). Unset = live meetings are off everywhere and the group switch says so. The tests run
the same adapter against a fake Recall server that streams transcript lines and signs its webhooks.

### How Sidekick is invited
- **Group switch** (group page → Live in meetings; Team Lead of the group or Org Owner/Admin; Enterprise only):
  *Off* (default), *When asked*, or *Every group meeting*.
- **Every group meeting**: the scheduled-meeting reader that already exists for transcription reminders
  (`lib/meeting-nudge.ts`, calendar → clearly one group's meeting) also runs for groups with Live on; a minute
  before a group meeting starts, `live.auto` asks Graph for the meeting's join link and sends the bot. Once per
  occurrence.
- **`@Sidekick join`** in the meeting chat (or `@Sidekick join <meeting link>` anywhere linked to the group), and
  `@Sidekick leave`. Works with *When asked* or *Every group meeting*.

### What it does live
- Joins as **"Sidekick (notes)"** (visible in the participant list). When admitted, its first chat message says it
  is listening for the group, how to ask, and how to remove it ("Sidekick, leave", `@Sidekick leave`, or remove
  Sidekick (notes) from the participants).
- **"Sidekick, …"** said aloud or typed in the meeting chat → the normal Ask pipeline (`lib/sidekick.ts ask`):
  `screenTurn` before, `checkGrounding` + `cleanOutput` after, citations. The answer and its sources go to the
  meeting chat through our own Teams bot when Sidekick's Teams app is in that chat (an answer card), otherwise
  through the provider's chat message (plain text with numbered sources).
- **Running list**: every few minutes of new talk (`live.extract`), Claude (feature `live`) updates the decisions and
  action items so far. "Sidekick, recap" / "what have we decided" reads it back without another Claude call. The
  group's people see it on the group page while the meeting runs.
- **Guest/client wall**: when the meeting has client guests (the meeting chat is marked as having guests, Graph lists
  attendees from another organization, or someone joins as a guest/external participant), answers use **Shareable
  sources only**, exactly as Ask does with guests. Once guests are seen, the session stays in guest mode.

### When it stops
Meeting ended (provider status), `Sidekick, leave`, removed from the meeting, someone presses **Stop** on the group
page or the Owner Console, the month's live hours run out, 4 hours passed, or nobody admitted it from the lobby
within 15 minutes (`live.watch`, every minute). Every stop is audited and shown with its reason.

### Notes afterwards: no duplicates
At the end the **existing notes pipeline takes over**:
- If Teams made a transcript (automatic notes, `lib/meetings-graph.ts`), the Graph capture claims the session
  (`live_sessions.handoff = 'graph'`) and writes the notes as always.
- If no Teams transcript arrived 30 minutes after the end (`live.handoff`), the live transcript becomes the meeting
  (`meetings.source = 'teams-live'`) and the same `meetings.notes` job writes and posts the notes
  (`handoff = 'live'`); a Teams transcript that turns up later for the same meeting is skipped with the reason
  "Notes already written from Sidekick's live session".
- Both claims are compare-and-set on the session row, so only one ever wins. The raw live lines are deleted after
  the handoff (the transcript is kept only in the meeting, like an import).

### Limits, tracing, audit, isolation
- Plan: Enterprise feature `liveMeetings`; hours count against `liveMeetingHours` (joined → ended, live sessions
  counted up to now). Joining is refused when the month is used up; a running session leaves when it runs out.
- Trace spans (`live` kind): join, stop, chat post, webhook, answer, extract. Times and counts only.
- Audit: joined, left (with why), answered in a meeting, switch changes.
- Tables `live_sessions` and `live_lines` have `org_id` (Postgres row-level security applies automatically); every
  query is per org; the webhook finds the session by the provider's bot id under a named system scope, then works
  inside that session's org.

---

## Part 3: what Cody must sign up for or approve

Nothing below has been done. In order:

1. **Recall.ai account**, Pay As You Go, region **US East** (`us-east-1`, closest to Sidekick's Azure in East US;
   pick `eu-central-1` instead if the first client is European). Free to create; 5 free hours; then $0.65/meeting
   hour. No card needed to try (confirm at sign-up).
2. In the Recall dashboard: create an **API key** and a **workspace verification secret** (`whsec_…`). Put both in
   Key Vault `sidekick-kv` (never in chat), then set on the Container App: `SIDEKICK_LIVE_PROVIDER=recall`,
   `RECALL_REGION=us-east-1`, `RECALL_API_KEY`, `SIDEKICK_LIVE_WEBHOOK_SECRET`.
3. Review and accept Recall's **DPA** (linked from the pricing page footer) and add Recall.ai to Sidekick's
   sub-processor list (`app/src/lib/subprocessors.ts`) before the first client uses it.
4. **Teams settings in Sidekick Labs** (for the first live test), Teams admin center:
   - Meetings → Meeting policies → *Anonymous users can join a meeting* **On** (org-wide setting too).
   - Lobby: *Who can bypass the lobby* is up to the organizer; with the default, someone admits "Sidekick (notes)".
   - Meeting chat on for anonymous participants (so the provider can post when our Teams app isn't in the chat).
5. Later, optional: a **signed-in bot** (skips "anonymous join" and some lobbies) needs a separate Microsoft 365
   tenant with one Business Basic licence (~$6/month) and security defaults turned off there (Recall's guide).
   Not recommended until a client needs it.

What a **customer's IT** must approve: Sidekick's Teams app (already), anonymous join for meetings Sidekick should
join (or trusting the bot's tenant if we go signed-in), letting people admit "Sidekick (notes)" from the lobby,
Recall.ai as a sub-processor (DPA, region), and the Enterprise plan's live meeting hours.
