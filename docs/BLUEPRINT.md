# Blueprint: AI Meeting Teammate for Microsoft Teams

> **Status:** v0.10 working draft. Not ready to hand off yet.
> **Changelog:** v0.2 removed fact-checking and corrections. The agent now raises its hand to share recalled context and ask questions. It also adds the first-customer pilot plan (consulting firm) and walls between client engagements.
> v0.3: two-level isolation (tenant packages + per-engagement workspaces), software-engineering focus (DevOps/GitHub/Jira/pipelines/diagrams).
> v0.4: general-purpose brain, learning loop (learns from meetings like a teammate), live web research, admin restrictions/guardrails, pluggable MCP connector catalog, live in-meeting actions (Jira/DevOps stories, draft backlog, permission levels).
> v0.5: decided fully Microsoft-native Teams app + Graph media bot, AWS for everything else (Bedrock, Transcribe/Polly/Translate, ECS, RDS, S3), Teams-native surfaces (4.6a). Pricing deferred, name TBD.
> v0.6: verified Microsoft docs. Production media bots must be hosted in Azure (thin Azure relay + AWS everything else). Graph has no raise-hand API, so MVP uses a virtual hand-raise, with an ACS real-hand R&D track.
> v0.7: moved to **all-Azure** (Claude in Foundry Azure-hosted, Azure AI Speech, Translator, AI Search, Postgres Flexible, Blob, Service Bus, Key Vault, Container Apps). Single cloud, no cross-cloud hop.
> v0.8: connection checklist (4.1b), full React Client Portal spec (roles, 12 pages), expanded React Owner Console (models, SDK-age warnings).
> v0.9: knowledge insights (topics + coverage, gaps, action-item tracker, RAG index health), Trust & security section (7.5): private endpoints, CMK, no training, off-the-record, Purview labels.
> v0.10: connector app-tile grid with per-app setup panel, client branding (logo + brand color) incl. Accenture pitch preset.
> **Codename:** `Sidekick` (placeholder)
> **Audience:** A Claude coding agent that will build this system, plus the product owner (Cody).
> **How to read this:** Sections marked **[DECISION]** are still open. Sections marked **[VERIFY]** depend on platform behavior that must be confirmed against current Microsoft docs before building.

---

## 1. Vision

> **One-liner:** Sidekick is another member of the meeting. It knows everything about the project, can check any fact in seconds, can see the complete pipelines, plans and blueprints, and makes suggestions. It does the things no human teammate can do, like remembering every meeting and reading every document at once.


Sidekick is an AI team member that:

- **Joins** Microsoft Teams meetings as a named participant.
- **Listens** in real time: it transcribes, translates, and keeps track of who said what.
- **Knows the history:** it remembers past meetings, project docs, tickets, and decisions for each client (RAG + MCP tools).
- **Takes part:** it answers questions out loud (TTS) in seconds, including things from meetings long ago that people have forgotten. It also raises its hand to offer useful context or ask good questions.
- **Never corrects people.** It isn't a referee. It helps people remember. It doesn't tell anyone they're wrong.
- **Follows up:** after the meeting it posts structured notes, decisions, and action items to the right Teams channel. Nobody has to copy and paste from Copilot.
- **Is sold as SaaS:** clients onboard through a **Client Portal**, and the owner runs everything from an **Owner Console**.

## 2. Product surfaces

| Surface | User | Purpose |
|---|---|---|
| **Meeting Agent** | Meeting participants | The bot in the call: listen, speak, raise hand, chat |
| **Teams App** | Client end users | Add Sidekick to meetings/channels, @mention it in chat, get notes, adaptive cards |
| **Client Portal** (React web app + Teams tab) | Client admins & members | Users & access, workspaces, docs, memory, connectors, restrictions, usage & billing, models, audit |
| **Owner Console** (React web app) | Cody (super-admin) | Spend, latency, errors, tool usage, tenants, releases/feature flags |

---

## 3. Core capabilities (functional requirements)

### 3.1 Meeting join & presence
- Joins on schedule (calendar invite to the bot's address), on demand (`/join` or a button in the Teams app), or automatically for meetings that match rules set in the portal.
- Shows up as "Sidekick (AI)" with a clear AI label, and announces itself and its recording/AI notice when it joins.
- Can be removed by any participant. Leaves when the meeting ends or after N minutes alone in the call.

### 3.2 Listening pipeline
- Per-speaker audio, then streaming STT with **speaker diarization** mapped to real Teams participant identities.
- Language detection, with translation of each utterance into the tenant's working language (originals are kept).
- Rolling "meeting state": topics, open questions, claims made, decisions, action items.

### 3.3 Participation modes (per tenant, per meeting, overridable live)
| Mode | Behavior |
|---|---|
| **Silent scribe** | Listens and writes notes only. Never speaks. |
| **On-call** | Speaks only when addressed ("Sidekick, …") or @mentioned in chat |
| **Hand-raise** (default) | Everything in On-call, plus it can raise its hand to offer recall or ask a question (see 3.5). Speaks only once called on (e.g., "Go ahead, Sidekick"). |

**Ground rule for every mode:** Sidekick never speaks over people and never says someone is wrong. The only things it ever says out loud are answers, recalled context, and questions.

### 3.4 Answering questions
- Detects questions directed at it (wake word, its name, chat @mention).
- Answers from RAG, MCP tools, and the meeting so far. Spoken answers stay under about 20 seconds; longer detail goes to the meeting chat.
- Always **cites sources** in chat ("per the Q3 SOW, section 4…").

### 3.5 Hand-raise engine: proactive recall & questions
Sidekick raises its hand (it never just talks) when it notices one of these triggers:

| Trigger | Example in the meeting | What Sidekick offers once called on |
|---|---|---|
| **Memory gap** | "When did we agree to that…?" / "Who was handling the API keys again?" / "I think we talked about this months ago…" | "That was decided in the March 4 kickoff. Dana owns it, due end of Q2. Link's in chat." |
| **Unanswered question** | Someone asks a question, nobody answers, and the conversation moves on | "Earlier someone asked about the SOW budget. I found it: $48k, section 3." |
| **Prior history on the topic** | A topic comes up that was discussed before | "Heads up: we discussed this on Aug 12. Want a 2-line recap?" |
| **Missing details** | An action item is created without an owner or a date | "Quick question: who's owning that, and by when?" |
| **Changed decision** | What's being said now differs from a recorded decision | Phrased **as a question, never a correction**: "Just checking: in June we went with option B. Are we switching to A?" |
| **Suggestion** | The team is planning or solving something where the project data shows a risk, dependency or better option | "One thing to consider: Phase 3 depends on the vendor API, which is still 2 weeks behind. Want the details?" |
| **Precedent** | A problem comes up that was solved before, on this engagement or (if allowed) a similar past one | "We hit this on the data migration in May. The fix was X. Notes in chat." |

**Pipeline:**
1. **Detect:** the fast model tags utterances: `memory-gap | question | unanswered-question | topic-shift | action-item | decision | chatter`.
2. **Fetch:** for each candidate, search meeting history, the knowledge base, and MCP tools in parallel. Target **< 3 s**, so the answer is ready *before* the hand goes up.
3. **Gate:** raise the hand only if the answer was found with high confidence, it's relevant to what's being discussed right now, nobody already answered it, and the rate limit allows it (e.g., at most 1 hand-raise per 5–10 minutes, set per tenant).
4. **Raise hand:** if raise-hand isn't supported by the gateway, it posts a short chat message instead: *"I have the answer to Mike's question about the deadline. Want me to share?"*
5. **Called on:** it speaks a short answer (under about 20 s) and posts the source links in chat. If nobody calls on it within about 2 minutes, it lowers its hand and puts the item in the meeting chat and the notes instead.
6. **Logging:** every candidate is logged, including ones it skipped and the reason, so it can be tuned.

**Real-time "lookup" vs. hand-raise:** if someone speaks *directly to* Sidekick ("Sidekick, when did we sign the contract?"), it skips the hand-raise and answers right away. A direct question is permission to talk.

**Optional (off by default):** a quiet "things to double-check" section in the post-meeting notes listing statements that differ from records. It's never spoken and never names a person. **[DECISION: include at all?]**

### 3.6 Speaking (TTS)
- Text → **Azure AI Speech neural TTS** (voice chosen per tenant), then streamed into the call's audio.
- Barge-in handling: it stops talking immediately if a human starts speaking.
- Target **< 2.5 s** from end of question to first audio.

### 3.7 Post-meeting output
- Structured notes: summary, decisions, action items (owner and due date), open questions (including ones nobody answered), "Sidekick looked up" (what it fetched and for whom), links.
- Posted as an **Adaptive Card** to a configured channel or chat, with optional email and a Planner/Jira/Asana task push via MCP.
- Notes are versioned and editable in the Client Portal. Edits go back into memory.

### 3.8a Superhuman abilities (the core value)
These are the things that make Sidekick worth paying for, because a human teammate can't do them:

| Ability | What it means | How it works |
|---|---|---|
| **Instant fact-check, on request** | "Sidekick, is that right?" / "Can you confirm the budget number?" It answers with sources in seconds. Asking is the trigger. It never volunteers corrections. | RAG + meeting memory + live tools, answer + citation |
| **Total project awareness** | Knows the full status: scope, timeline, budget, owners, risks, open items, and every past decision | Project "state model" rebuilt continuously from docs, tickets, meetings and tools |
| **General intelligence** | Not limited to one domain. It has Claude's full general knowledge, so it can answer questions on any topic the organization deals with (engineering, finance, HR policy, sales, legal basics, industry knowledge) | Claude + the workspace's knowledge + the connector catalog |
| **Sees pipelines & blueprints** | Can read and reason over the project's plans, pipelines, diagrams and technical documents, and explain or summarize any piece of them on request ("Walk us through stage 3 of the pipeline") | Document parsing incl. diagrams/drawings (vision-capable model) + connectors (see 9.6) |
| **Live research** | "Sidekick, what's the latest pricing for Azure OpenAI?" / "Does this library support .NET 8?" It searches the web during the meeting and answers with sources | Web search/fetch tool, allowed per workspace (see 3.9) |
| **Suggestions** | Spots risks, dependencies, conflicts, gaps, and better options, and offers them through a hand-raise | Reasoning over the project state model while listening |
| **Show, not just tell** | Posts the relevant diagram, doc section, chart or table into the meeting chat while it speaks | Chat + Adaptive Cards. Screen-sharing by a bot is **[VERIFY]**, so chat is the MVP |
| **Instant prep & follow-up** | Pre-meeting brief ("here's what's open since last time") posted to the channel. Post-meeting notes and action items | Scheduled job before each meeting + post-meeting pipeline |

### 3.8 Long-term memory: learning alongside the team
Sidekick learns the way a new team member does: by sitting in the meetings. When a new project kicks off, it hears the rundown and requirements at the same moment the team does, and it remembers all of it.

**The learning loop (after every meeting):**
1. **Capture:** the full transcript is stored, chunked and embedded in that workspace's memory.
2. **Extract:** the meeting is turned into structured knowledge: requirements, decisions (with date and who made them), stakeholders and roles, glossary terms, risks, open questions, commitments.
3. **Update the project profile:** a living "what we know" document per workspace. For a brand-new project, it's built from the kickoff meeting. Newer information replaces older information, and the history is kept ("budget was $40k on Mar 3, changed to $48k on Apr 10").
4. **Fill gaps:** if requirements are vague or contradict each other, it adds questions to the next pre-meeting brief, or raises its hand to ask ("Is the deadline the 15th or end of month?").
5. **Human review:** the team can see, edit and delete anything Sidekick has "learned" in the portal (a memory page per workspace). Corrections are applied immediately.

**What "learning" means technically (important for the pitch):** Sidekick doesn't retrain the AI model. It builds a growing, searchable memory that belongs to the customer: stored in their tenant, deletable, and never used to train anyone's model. That's a selling point for IT/security: the memory is the customer's, not the AI vendor's.

- "What did we decide about X?" works across all past meetings in the workspace.
- Organization-wide knowledge (company policies, standards, org chart) can live in a shared **Org workspace** that every workspace can read. Engagement-specific knowledge stays walled off.

### 3.8b Live actions: doing the work during the meeting
Sidekick doesn't just take notes. It **does the follow-up work while the meeting is still going**.

**Examples:**
- "Sidekick, make a story for that." → it drafts a Jira/DevOps story (title, description, acceptance criteria taken from what was just said, assignee, sprint, labels) and posts it as a card in the meeting chat with **[Create] [Edit] [Discard]** buttons.
- "Add that as a bug, high priority, assign to Maria." → done, and the link is posted in chat.
- "Move PROJ-142 to the next sprint." / "What's the status of PROJ-88?" → it updates the ticket or reads it out.
- "Schedule a follow-up with the client next Tuesday." → it drafts the Outlook invite for one-click send.
- **Auto-drafting:** while listening, it collects possible stories, bugs and tasks into a **draft backlog**. At the end of the meeting (or when asked: "Sidekick, what did we capture?"), it shows the list so the team can approve everything in one pass.
- Requirements discussed in a kickoff become a draft epic with child stories, linked back to the meeting transcript.

**Permission levels (set per connector, per workspace, in the dashboard):**
| Level | Behavior |
|---|---|
| Read-only | It can look things up but never change them |
| Draft (default) | It prepares items and a human clicks Create |
| Create with voice confirm | "Sidekick, create it." A spoken OK is enough |
| Auto | It creates items without asking (for low-risk actions like adding a comment) |

Every action is logged with who asked, what changed, and a link, and it's listed in the post-meeting notes under "Actions taken". Undo is available where the tool supports it.

### 3.8c Knowledge insights: topics, gaps & action items
Built on top of the RAG index and memory, and shown on the **Memory & gaps** page of the Client Portal.

**Topics (knowledge map):** Sidekick groups everything in a workspace into topics (e.g., "Wave 2 cutover", "Security & PCI compliance"), clustering document passages and meeting segments by meaning. For each topic it tracks:
- **Coverage score** (0–100%): how many documents and meetings cover it, how recently, and how often questions about it got a sourced answer. Shown as *Well covered / Partial / Gap*.
- A short summary, key facts, sources, last updated date, audience (Internal/Shareable), and open gaps.
- One-click "write a brief": Sidekick writes a one-page topic summary and posts it to the channel.

**Gaps:** things the team should know but doesn't have written down. Sidekick detects:
| Gap type | How it's detected |
|---|---|
| Couldn't find an answer | A question was asked (in a meeting or chat) and retrieval found nothing reliable. Repeat questions are counted |
| Unanswered in meeting | A question was asked and nobody answered it |
| Conflicting information | Two sources disagree (e.g., the runbook says 48 stores, a meeting said 52) |
| Out of date | A document is older than the decisions made about its topic since |
| Thin coverage | A topic is discussed often but has few or no documents |
| Only in a meeting | An important decision exists only in a transcript, not in any design doc |
Each gap has a suggested fix and can be **assigned** to a person (Teams message), resolved, or closed by uploading a document. Open gaps also go into pre-meeting briefs.

**Action items:** collected automatically from every meeting across the workspace into one tracker: item, owner, due date, status (Open / In progress / Overdue / Done), source meeting (with a link to the transcript moment), and linked ticket. Filters: Open, Overdue, No owner, Done. Missing owners can be assigned inline. "Create ticket" pushes to Azure DevOps/Jira. Sidekick follows up on overdue items in the next relevant meeting's brief.

**RAG index health** (Knowledge page): passages indexed, search mode (hybrid keyword + vector with semantic re-ranking), % of answers that cited a source, last re-index time, failed files.

### 3.9 Research & restrictions (guardrails)
**Research:** Sidekick can search the web in real time when the workspace allows it. Answers always cite sources, and it says clearly when something came from the web rather than from the team's own records.
- **No leaking in queries:** web searches are written without confidential details (client names, internal numbers, code), checked by a query-sanitizer step.
- Deeper research ("compare these three vendors") runs in the background, and the result is posted to the channel during or after the meeting.

**Restrictions are set by admins in the portal, at org level and per workspace:**
| Control | Examples |
|---|---|
| Topics off-limits | Salaries/HR matters, legal disputes, M&A, other clients |
| Sources allowed | Web research on/off, which connectors, which document folders |
| Audience rules | What may be said when external guests are present (internal-only tags) |
| Actions allowed | Read-only vs. may create tickets, send summaries, etc. |
| Memory rules | Meetings or channels that are never recorded or remembered (e.g., 1:1s, HR) |

When it hits a restriction, Sidekick politely declines ("That's outside what I can discuss here") and logs the attempt for admins.

**Built (Oct 2026, phase 1):** a locked floor (no hate/bias, harassment, sexual content or harm; jailbreak resistance; never crosses client walls; "I don't know" instead of guessing) plus org-wide switches set by the Org Owner (swearing, small talk, judging people, HR/legal/medical, contact details, competitors), enforced in the portal, Teams and the assistant, with counts (never text) per rule. Next: per-workspace settings (stricter only) and plain-language custom rules. See `app/src/lib/guardrails.ts` and docs/guide/admin-guide.md.

---

## 4. Architecture

```
                 ┌──────────────────────── Microsoft Teams ────────────────────────┐
                 │   Meeting (audio/video/chat)        Channels / Chats             │
                 └──────────┬───────────────────────────────────┬──────────────────┘
                            │ real-time media                   │ Bot Framework / Graph
                ┌───────────▼────────────┐            ┌─────────▼──────────┐
                │  MEDIA GATEWAY         │            │  TEAMS APP / BOT   │
                │  (joins call, audio    │            │  (chat, cards,     │
                │   in/out, raise hand)  │            │   commands, notes) │
                └───────────┬────────────┘            └─────────┬──────────┘
                            │ audio frames / events             │
                ┌───────────▼─────────────────────────────────────────────┐
                │                    SESSION ORCHESTRATOR                 │
                │  per-meeting actor: state, mode, turn-taking, gating    │
                └──┬──────────┬──────────────┬──────────────┬─────────────┘
                   │          │              │              │
              ┌────▼───┐ ┌────▼─────┐  ┌─────▼──────┐  ┌────▼────────┐
              │  STT   │ │Translate │  │ REASONING  │  │  TTS        │
              │(stream)│ │          │  │ (Claude +  │  │ (Azure TTS) │
              └────────┘ └──────────┘  │  tools)    │  └─────────────┘
                                       └──┬─────┬───┘
                                ┌─────────▼┐  ┌─▼──────────┐
                                │ RAG/Vector│  │ MCP Tool   │
                                │ + Memory  │  │ Gateway    │
                                └───────────┘  └────────────┘
     ┌───────────────────────────────────────────────────────────────────────┐
     │ CONTROL PLANE: Postgres · Object storage · Queue · Telemetry/OTel     │
     │ Client Portal (web) · Owner Console (web) · Auth · Billing · Flags    │
     └───────────────────────────────────────────────────────────────────────┘
```

### 4.1 Media gateway: Microsoft-native **[DECIDED, VERIFIED Oct 2026]**
**Decision:** Sidekick is a **first-party Microsoft Teams app** built on Microsoft's own platform. No third-party meeting-bot vendor. It installs from the firm's Teams admin center like any other Teams app, and it shows up and behaves as a native participant.

**How it joins and hears the call:** the **Microsoft Graph Communications API** with an **application-hosted real-time media bot** (`Microsoft.Graph.Communications.Calls.Media` SDK). This gives raw audio streams (with participant/speaker identity), the ability to play audio into the call (Sidekick's voice), and call/participant events.

**Platform constraints (verified against Microsoft Learn, Oct 2026; see Sources at the end):**
- The real-time media bot **must be C# / .NET** (.NET 6+ supported) using the `Microsoft.Graph.Communications.Calls.Media` library. Node.js and C++ can't access real-time media.
- **Production media bots must run on Windows Server in Azure.** Allowed Azure hosts are Cloud Service, Service Fabric with VM Scale Sets, IaaS VMs, or **AKS** (Windows node pools). Azure Web Apps are not allowed. On-premises Windows Server is allowed only for development and testing. **AWS hosting of the media bot is not supported.**
- Each bot VM needs an **instance-level public IP** and a public port mapped to that instance (NAT rules on the scale-set load balancer).
- **Calls are pinned to the VM that joined them.** Stopping the VM drops its calls, so scale-in has to drain calls first.
- At least **2 CPU cores** per VM (Microsoft recommends Dv2-series, or 4 vCPU minimum on other types). Audio-only bots like Sidekick are far lighter than video bots.
- The media NuGet package must be **no more than about 3 months old**, or it stops working. Add an automated monthly dependency update and redeploy to CI.
- Microsoft still labels the real-time media platform "developer preview" in its docs, so guidance may change. Re-check the docs before each phase.

**Resulting hosting design: all-Azure, single cloud**
```
Teams meeting ⇄ [Azure: C# media bot on Windows VMSS/AKS] ⇄ (same region, private network) ⇄ [Azure: orchestrator, Claude in Foundry, Azure AI Speech, Translator, AI Search, Postgres, Blob, dashboards]
```
- Microsoft requires Azure for the media bot, so putting **everything** in Azure removes the cross-cloud hop. The result is lower latency, one network, one bill, one security review, and one identity system (Entra ID).
- The media bot stays **thin**: it joins and leaves calls and moves audio and events. All intelligence lives in the TypeScript orchestrator next to it, talking over the private VNet.
- **Pitch line:** "Runs entirely in Microsoft Azure, in the US, next to your Microsoft 365 data." The firm already trusts Microsoft with its Teams data, so this is the easiest possible security review.

**Raise hand: findings**
- **The Microsoft Graph calling API has no raise-hand capability.** The Graph `participant` resource (v1.0) only supports list, get, delete, invite, mute, and hold music, with no hand-raise property. So a Graph media bot **can't raise its hand**, and it **can't see when humans raise theirs** either.
- **Azure Communication Services (ACS) Calling SDK does support `raiseHand()` / `lowerHand()` in Teams meetings** (GA on Web; preview on Windows, iOS and Android). But it's a *client* SDK: it would join as a second, separate ACS identity (shown as an external participant), which conflicts with the "one clean native participant" goal.

**Decision for MVP: a "virtual hand-raise" that feels native, with no fake second participant:**
1. **Meeting chat card:** "✋ **Sidekick** has the answer to Mike's question about the deadline. Say *'go ahead, Sidekick'* or tap **Share**." It also has **Share** / **Dismiss** buttons.
2. **Side panel badge:** the Sidekick meeting side panel shows a pulsing ✋ with a one-line preview.
3. **Optional soft chime** (off by default): a short, quiet audio cue before the chat card.
4. Saying "go ahead, Sidekick", tapping Share, or an @mention counts as being called on. If ignored, the hand lowers after about 2 minutes and the item goes into the notes.

**R&D track (Phase 3, optional):** test a companion ACS identity that does nothing except raise and lower a real Teams hand while the Graph bot handles the audio. Adopt it only if it shows up cleanly in the roster and IT accepts the extra participant. Check again whether Graph has added hand-raise before each phase.

Keep the `MediaGateway` interface so the C# media bot is a thin adapter and all logic lives in the TypeScript orchestrator next to it in Azure:
```ts
interface MediaGateway {
  join(meeting: MeetingRef, identity: BotIdentity): Promise<CallSession>;
  leave(callId: string): Promise<void>;
  onAudio(callId: string, cb: (frame: AudioFrame /* pcm16, 16kHz, speakerId? */) => void): void;
  onParticipants(callId: string, cb: (p: Participant[]) => void): void;
  onChat(callId: string, cb: (m: ChatMessage) => void): void;
  playAudio(callId: string, stream: AsyncIterable<AudioFrame>): Promise<PlaybackHandle>; // cancellable
  sendChat(callId: string, text: string | AdaptiveCard): Promise<void>;
  raiseHand(callId: string, preview: string): Promise<HandHandle>; // MVP = virtual hand-raise (chat card + side panel), see above
}
```

### 4.1b Connection checklist: what's proven vs. what could block
Claude, Azure and Teams all connect through **documented, supported Microsoft paths**. Nothing here is a hack. These are the real gotchas, and Phase 0 must clear each one:

| Connection | Status | Gotcha to handle |
|---|---|---|
| Media bot ↔ Teams meeting | Supported (Graph Communications) | C#/Windows only. Docs still say "developer preview". Media SDK must be updated every ≤3 months. Calls pinned to a VM |
| Bot permissions in the firm's tenant | Supported | App permissions `Calls.JoinGroupCall.All`, `Calls.AccessMedia.All` (and related) need **tenant admin consent**. Teams admin must allow the app. Budget time for IT approval |
| **Meetings hosted by *other* organizations** (e.g., a client's Teams) | ⚠️ Biggest real-world risk | The bot belongs to the firm's tenant. Joining a meeting hosted in a client's tenant may land it in the **lobby** or be blocked by the client's external-access/bot policies. **Test early**. Fallback: the organizer admits it, or Sidekick runs in notes-only mode from the firm side |
| Orchestrator ↔ media bot | Our own code, same Azure region/VNet | Low latency. Keep the bot thin |
| Orchestrator ↔ Claude (Foundry) | Supported, GA, Anthropic SDK | Requires an **Azure Marketplace subscription** for Claude. **Rate limits/quotas** per subscription: request increases before the pilot. Add retry/backoff |
| Orchestrator ↔ Azure AI Speech | Supported, GA | Streaming STT/TTS concurrency quotas, so request increases for many simultaneous meetings |
| Teams app / bot / side panel / cards | Supported (Teams SDK, Bot Service) | App must pass org catalog review. Store publishing later needs Microsoft validation |
| Connectors (Jira, DevOps, GitHub…) | Supported via OAuth / MCP | Each client's admin must approve OAuth apps. Tokens expire, so refresh handling and connector health alerts are needed |

**Latency budget (target p95 < 2.5 s from end of question to first spoken word):** end-of-speech detection ~300–500 ms → Claude Haiku/Sonnet first tokens ~500–1000 ms (streamed) → TTS first audio ~200–300 ms → playback. It's achievable but tight, so **stream every stage** and start TTS on the first sentence.

### 4.2 Speech & language stack **[DECIDED: Azure]**
- **STT:** **Azure AI Speech**, real-time speech-to-text with **real-time diarization** (speaker labels in streaming mode), plus **custom speech / phrase lists** fed from the workspace glossary (client names, acronyms). Speakers are matched to Teams participants using the media bot's per-participant streams where available.
- **Translation:** **Azure AI Translator** for text, and Azure AI Speech **speech translation** for live multilingual meetings.
- **TTS:** **Azure AI Speech neural TTS** (hundreds of neural voices and styles; optional **Custom Neural Voice** for a branded voice per client, which requires Microsoft approval). This replaces Polly.
- Each one sits behind the `SttProvider`, `TtsProvider` and `TranslateProvider` interfaces.

### 4.3 Reasoning
- LLM: **Claude in Microsoft Foundry, "Hosted on Azure" version**, which runs on Azure infrastructure end-to-end, is GA, and bills on the Azure invoice (can count toward the firm's Azure commitment). Use the **Data Zone Standard (US)** deployment to keep inference in the US.
  - Real-time triage: `claude-haiku-5-5` (fast and cheap).
  - Answers, live actions, notes: `claude-sonnet-5-5`. Deep project analysis or long documents: `claude-opus-5-5`.
  - Called through the Anthropic SDK (`@anthropic-ai/foundry-sdk`) against `https://<resource>.services.ai.azure.com/anthropic/v1/messages`.
- Supported on Azure-hosted Claude and used here: streaming, prompt caching (5 min and 1 hr), citations, structured outputs, vision/PDF, **web search tool** (`web_search_20250305`), **MCP connector**, tool search.
- Foundry has **no built-in content filter for Claude**, so add Azure AI Content Safety checks on outputs where needed.
- **Real-time loop:** Haiku classifies each utterance: `addressed-to-me | question | memory-gap | unanswered-question | topic-shift | decision | action-item | chatter`. Only some of these go to Sonnet/Opus.
- **Tool use:** knowledge search, meeting-history search, web research, and MCP tools (Jira, Azure DevOps, GitHub, SharePoint, Confluence, CRM, and so on).
- Prompt caching for each workspace's system prompt and project profile.

### 4.4 Knowledge / RAG
- **Azure AI Search** is the knowledge index (Azure's managed equivalent of Elasticsearch): **hybrid search** (keyword + vector) with **semantic re-ranking**, built-in indexers for **SharePoint, OneDrive and Blob Storage**, and document-level security filters.
- Sources: uploaded files, URLs (crawled on a schedule), SharePoint/OneDrive, past meeting transcripts and notes.
- Pipeline: ingest, parse (Azure AI Document Intelligence for PDF/DOCX/PPTX/XLSX/scans; Claude vision for diagrams), chunk, embed (Azure OpenAI or Foundry embedding model), index with fields `{tenant_id, workspace_id, source, acl, audience: internal|external, updated_at}`.
- **Hard isolation:** one index (or index partition) per tenant, plus mandatory `tenant_id` + `workspace_id` filters on every query, enforced in a single data-access layer (see 4.7). App data in Postgres uses row-level security.
- Elastic Cloud (via the Azure Marketplace) is a drop-in alternative if the firm already standardizes on Elastic.

### 4.5 MCP integration
- An MCP client gateway inside the reasoning service. Each workspace enables and connects MCP servers in the portal (see 9.6).
- Tool calls are logged (name, args hash, latency, result size, error), which feeds the Owner Console.
- Write actions follow the per-connector permission levels (see 3.8b).

### 4.6 Tech stack **[DECIDED: all Azure]**
| Layer | Choice | (AWS equivalent, for reference) |
|---|---|---|
| Teams app | Teams app manifest (bot + meeting side panel + tabs + message extension), Teams SDK / Bot Framework, Adaptive Cards, **Azure Bot Service** | — |
| Media bot | C# / .NET Graph Communications media bot on **Azure Windows VM Scale Set or AKS Windows node pool** (required by Microsoft) | — |
| Orchestrator & APIs | TypeScript (Node) on **Azure Container Apps** (or AKS Linux nodes): per-meeting orchestrator as a long-lived worker | ECS Fargate |
| Web (Client Portal + Owner Console) | **React** via **Next.js** (React framework) + TypeScript + Tailwind + shadcn/ui components + Recharts/Tremor for charts + TanStack Query/Table. Shared design-system package for both apps. Hosted on **Azure Container Apps** or **App Service**, behind **Azure Front Door** | Amplify / CloudFront |
| LLM | **Claude in Microsoft Foundry (Hosted on Azure)**: Haiku 5.5 / Sonnet 5.5 / Opus 5.5 | Bedrock |
| Embeddings | Foundry / Azure OpenAI embedding model | Bedrock embeddings |
| Speech to text | **Azure AI Speech** (real-time + diarization + custom speech) | Transcribe |
| Text to speech | **Azure AI Speech neural TTS** | Polly |
| Translation | **Azure AI Translator** + speech translation | Translate |
| Search / knowledge index | **Azure AI Search** (hybrid + vector + semantic ranker) | OpenSearch / Elastic |
| Document parsing | **Azure AI Document Intelligence** | Textract |
| App database | **Azure Database for PostgreSQL – Flexible Server** (row-level security, pgvector available) | RDS / Aurora |
| Files | **Azure Blob Storage** (per-tenant containers, customer-managed keys) + **Defender for Storage** malware scanning | S3 + scanning |
| Queues / events / schedules | **Azure Service Bus** + **Event Grid**; scheduled jobs via Container Apps jobs | SQS / EventBridge |
| Secrets & keys | **Azure Key Vault** (per-tenant keys, connector tokens) | KMS / Secrets Manager |
| Identity | **Microsoft Entra ID** for everyone (Teams SSO + portal). Owner Console with MFA + Conditional Access | Cognito |
| Telemetry | **Azure Monitor + Application Insights** (OpenTelemetry); cost-metering table in Postgres; **Azure Cost Management** exports for infrastructure spend | CloudWatch / X-Ray |
| Content safety | **Azure AI Content Safety** (output checks) | Bedrock Guardrails |
| Web research | Claude's built-in **web search tool** (supported on Azure-hosted Claude). Note: the old Bing Search API was retired in Aug 2025 | — |
| Infra as code / CI | **Bicep** or Terraform; **GitHub Actions** or Azure Pipelines | CDK |
| Billing | Deferred (metering from day 1) | — |

### 4.6a Teams-native experience (how it "syncs cleanly" inside Teams)
Sidekick should feel like part of Teams, not a bolt-on:
| Teams surface | What Sidekick does there |
|---|---|
| **Meeting participant** | Joins as "Sidekick (AI)": listens and speaks. Hand-raise is "virtual" (chat card + side panel), because Graph has no raise-hand API |
| **Meeting side panel** (in-meeting app) | Live view: running notes, draft backlog (approve/edit stories), "ask Sidekick" box, mode switch (scribe/on-call/hand-raise), pause/remove |
| **Meeting chat** | Answers with sources, story cards with Create/Edit buttons, links |
| **Channel / chat bot** | @Sidekick questions outside meetings ("what did we decide about the API last week?"), post-meeting notes, pre-meeting briefs |
| **Personal app / tab** | A user's own view: my action items, my meetings, ask anything |
| **Channel tab** | Workspace dashboard pinned in the project's channel: project profile, recent meetings, open items |
| **Message extension** | Right-click any Teams message → "Make a story" / "Add to Sidekick memory" |
| **Install & admin** | Published to the firm's **org app catalog** (later the public Teams Store). IT approves it once in the Teams admin center, using resource-specific consent (RSC) where possible to keep permissions narrow |
| **Single sign-on** | Teams SSO, so users never log in again inside Teams. The web portal uses the same Entra ID login |

---

## 4.7 Isolation model: two levels

**Level 1: Tenant (each customer company).** Every customer gets their own package: their own dashboard, logins, configuration, rules, knowledge vault, and meeting history. Nothing is shared between tenants.
- Every row carries `tenant_id`, enforced by Postgres row-level security, plus **per-tenant encryption keys** (Azure Key Vault) for files and transcripts.
- Separate storage prefix and vector namespace per tenant.
- **Enterprise tier option:** a dedicated database or a fully dedicated deployment for customers whose IT/security requires physical separation.

**Level 2: Workspace (inside a tenant).** A customer like a consulting firm works with many of *its own* clients through one account. Each engagement becomes a **Workspace**, a mini-package with its own:
- knowledge vault (docs, URLs, connectors)
- linked Teams channels and meetings
- member list (who can see and configure it)
- agent rules (voice, triggers, what may be spoken when external guests are present)
- meeting memory

Sidekick only ever searches the workspace linked to the current meeting. The firm's admin sees all workspaces, and engagement teams see only their own. Cross-workspace search ("have we solved this for another client?") is **off by default** and, if enabled, is limited to internal-only meetings and anonymized precedents. **[DECISION]**

**Isolation tests are mandatory:** automated tests try to read tenant B or workspace B data from tenant A or workspace A at the DB, vector search, file storage, and agent levels, and every attempt must fail.

## 5. Client Portal (React web app)

The client's home base: everything an admin needs to manage Sidekick for their organization. It uses the same login as Teams (Entra ID SSO). Key pages are also embedded as a **Teams tab**, so admins can manage it without leaving Teams.

### 5.1 Roles & permissions (RBAC)
| Role | Scope | Can do |
|---|---|---|
| **Org Owner** | Whole tenant | Everything: billing, security, delete org data, assign Org Admins |
| **Org Admin** | Whole tenant | Users, workspaces, connectors, org-wide restrictions, view all usage |
| **Billing Admin** | Whole tenant | Usage, invoices, budgets, and nothing else |
| **Workspace Admin** | One or more workspaces | Workspace members, docs, connectors, agent rules, workspace restrictions |
| **Member** | Assigned workspaces | View meetings/notes/memory, upload docs (if allowed), give feedback, approve draft stories |
| **Viewer** | Assigned workspaces | Read-only notes and meetings |
| **Auditor** | Whole tenant | Read-only audit logs and policies (for compliance teams) |

Roles can be assigned to individuals or **mapped to Entra ID security groups** (e.g., `SG-Sidekick-Admins` → Org Admin), so the firm's IT manages access in Entra as usual.

### 5.2 Pages
**1. Overview (home)**
- KPI cards: meetings this period, hours attended, questions answered, hand-raises (accepted %), stories created, docs indexed, active users.
- **Billing-period usage meter**: used vs. included, days left, and a projected end-of-period total.
- Live now: meetings Sidekick is currently in (with a "remove from meeting" button).
- Alerts: connector errors, docs that failed to index, budget thresholds, pending approvals.

**2. Usage & Billing**
- Current billing period (start/end, days remaining), plan, and included allowances.
- Usage over time (charts): meeting hours, AI usage (questions/answers, tokens), speech minutes, translation, storage, and actions taken. Filter by workspace, user, or date range.
- Breakdown tables: by workspace, by user, by meeting.
- **Budgets & alerts**: monthly cap per org/workspace, alerts at 50/80/100%, optional hard stop (Sidekick switches to notes-only mode).
- Invoices & payment history, download CSV/PDF. (Pricing model is deferred, but the page structure is built now on metering data.)

**3. AI Models & Agent**
- **Current models in use** (read-only for clients, or selectable per plan): e.g., "Fast responses: Claude Haiku 5.5 · Answers & actions: Claude Sonnet 5.5 · Deep analysis: Claude Opus 5.5", with hosting info ("Azure-hosted, US data zone").
- Model change history (when Sidekick was upgraded) and release notes ("What's new in Sidekick").
- Agent persona: name, voice (preview playback), languages, speaking style (brief/detailed), wake word.
- Default participation mode, hand-raise triggers on/off, hand-raise frequency limit, confidence threshold.

**4. Users & Access**
- User list: name, email, role(s), workspaces, last active, status.
- **Create / invite users** (by email from the org's directory), bulk CSV import, **Entra group sync**, and SCIM provisioning (later).
- Assign roles, add/remove from workspaces, deactivate, and transfer ownership.
- Pending invites, and access requests ("Maria requested access to Contoso Migration workspace").
- Guest policy: whether external guests can see notes or use @Sidekick in chat.

**5. Workspaces**
- List all workspaces (one per client engagement or project), with status, members, docs count, last meeting, and usage.
- Create a workspace with a wizard: name → link Teams channels/meetings → add members → connect tools → upload docs → set rules.
- Archive or delete a workspace (with data export first).

**6. Knowledge & Documents** (per workspace, plus the org-wide workspace)
- Drag-and-drop upload (folders too), URL list with crawl schedule, SharePoint/OneDrive folder picker.
- Per document: status (queued/indexing/ready/failed), size, uploaded by, last updated, **audience tag** (internal / shareable with external guests), and visibility.
- Search & preview: "test what Sidekick knows". Type a question, see the answer and which docs it used.
- Re-index, replace with new version, delete (purges the index too), and an expiry date for docs.

**7. Memory & gaps** (per workspace, see 3.8c)
- **Topics:** a knowledge map with a coverage score per topic, summary, key facts, sources, and "write a brief".
- **Gaps:** couldn't-answer questions, unanswered questions, conflicting info, stale docs, thin coverage, decisions only in meetings. Each can be assigned, resolved, or fixed with an upload.
- **Action items:** a tracker across all meetings with owner, due date, status, source meeting, and ticket. Assign owners and create tickets inline.
- **Decisions & facts:** requirements, decisions (with history), people, glossary. Edit, pin, or "forget" with an audit trail.

**8. Meetings**
- List with filters (workspace, date, attendee). Each meeting shows the transcript (searchable, translated view), notes, hand-raise log, actions taken, and recording consent status.
- Edit and re-post notes, export (DOCX/PDF/Markdown), and delete a meeting.
- Auto-join rules: which meetings Sidekick joins automatically (by channel, organizer, keyword in title), and meetings it must never join.

**9. Connectors**
- **App-tile grid** grouped by Microsoft 365 / Engineering / Work & docs / Business apps / Built in: square tiles with the app icon, name, one-line description, a status dot (connected / needs attention), and a call to action (Connect / Reconnect / current permission level). Filter: All / Connected / Needs attention / Not connected.
- Clicking a tile opens a setup panel: sign in (OAuth or Microsoft 365 admin consent), **what Sidekick can access** (per-app scope checkboxes, e.g., Outlook: read calendar / read linked mail folders / draft follow-ups), permission level, which workspaces use it, and Disconnect.
- Per connector: health, last sync, scopes granted, **permission level** (read-only / draft / voice-confirm / auto), and which workspaces use it.
- Story templates (fields, acceptance-criteria format, default project/sprint/labels).

**10. Restrictions & Policies** (org-wide defaults, overridable per workspace where allowed)
- Off-limits topics, blocked sources, web research on/off.
- External-guest rules: what may be spoken or shown when guests are present.
- Never-record rules (1:1s, HR, specific channels or people).
- Allowed actions per connector, and whether actions need approval.
- **Data retention**: transcripts, audio (default: don't keep audio), notes, memory. Auto-delete after N days.
- Data residency display (US), customer-managed encryption keys (enterprise).

**11. Security & Audit**
- Audit log: who did what and when (logins, role changes, policy changes, deletions, every agent action), filterable and exportable.
- Restricted-topic attempts log.
- Active sessions, SSO settings, IP restrictions (enterprise).
- **Data export** (full org or workspace) and **delete all data** (Org Owner only, with confirmation and a cooling-off period).

**12. Notifications & Settings**
- Email/Teams notifications: budget alerts, connector failures, weekly digest.
- Org profile, default language, time zone.
- **Client branding (white-label):** upload the organization's logo and choose a brand color. Applied to the portal (sidebar, buttons, charts), Teams Adaptive Cards, meeting notes, and pre-meeting briefs. Contrast is checked automatically so text stays readable. The pitch build ships an Accenture-themed preset (purple #A100FF, deep purple #460073, black; **verify against Accenture's official brand portal**).
- Support: help center, contact support, system status.

### 5.3 UX principles
- Clean, fast, minimal: lots of whitespace, clear typography, light and dark mode, fully responsive.
- Every number links to its detail (click "142 questions answered" → that list).
- Destructive actions always confirm and show what will be deleted.
- Role-aware navigation: users only see pages they're allowed to use.

## 6. Owner Console (super-admin, React)

Same React design system as the Client Portal, a separate app on a separate domain, with an owner-only login (MFA + Conditional Access).
- **Overview KPIs:** active meetings now, meetings today, active tenants, error rate, p50/p95 latency, AI spend today/this month, MRR and gross margin (once pricing exists).
- **Spend:** cost by provider (Claude tokens per model, speech minutes, TTS characters, Translator characters, AI Search units, media bot compute, other Azure infrastructure from Azure Cost Management), broken down by tenant, workspace, meeting, and model, with margin per tenant.
- **Models:** which Claude models are deployed, quota/rate-limit headroom, per-model latency and cost, A/B tests between models, and one-click model switch per tenant or globally.
- **Performance:** answer latency waterfall (STT → Claude → TTS → playback), join success rate, dropped calls, media bot VM load.
- **Errors:** grouped errors with trace links, by service and tenant, with alerting.
- **Tools:** MCP/connector call counts, success rate, latency, top tools, failing connectors.
- **Quality:** hand-raise acceptance rate, answer ratings, "found it" rate, flagged answers for review.
- **Tenants:** list, plan, usage, health, budgets, and read-only impersonation (audited, with tenant consent).
- **Releases:** deploy history, versions per component (media bot SDK version + age warning at 60/80/90 days), feature flags per tenant, staged rollouts, and kill switches (disable voice / hand-raise / actions globally or per tenant).
- **Live view:** a live meeting's event stream (utterance classifications, gate decisions), with consent and audit.

---

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Latency | Addressed question → first spoken audio p95 < 2.5 s. Chat answer p95 < 4 s |
| Reliability | Bot join success > 99%. Graceful degradation (if TTS fails, answer in chat) |
| Security | See 7.5: private endpoints only, encryption in transit and at rest (customer-managed keys), per-tenant isolation, no training on customer data, audio not stored, immutable audit log |
| Privacy & compliance | Visible AI and recording notice on join. Per-tenant retention policies. Data deletion on request. US region pinning by default (Azure US regions + Claude Data Zone Standard US). Recording-consent laws vary by jurisdiction (some require all-party consent), so the tenant admin must accept responsibility in the ToS, and the bot always announces itself |
| Cost | Per-meeting-hour cost target **[DECISION]**. The fast-model triage layer exists to protect margin |
| Observability | Every meeting has one trace ID. Every LLM/tool/STT/TTS call is metered with cost |

---

## 7.5 Trust & security: "talk freely, nothing leaks"

**Promise to customers:** everything Sidekick hears, reads, and writes stays inside Microsoft Azure in the US. It's encrypted everywhere, isolated per customer, never used to train AI, and every access is logged. Teams can discuss sensitive matters, and admins decide exactly what is recorded, remembered, and spoken.

**Data path (all Azure, all private):**
```
Teams meeting (customer's M365) → media bot (Azure VNet) → Azure AI Speech (STT/TTS) → Claude, Azure-hosted in Foundry → Azure AI Search / Postgres / Blob
                                     every hop TLS 1.2+ · data services on Private Endpoints · no public endpoints
```

**Controls the build agent must implement:**
| Area | Control |
|---|---|
| Network | All data services (Postgres, Blob, AI Search, Key Vault, AI Speech, Foundry) reachable **only through Private Endpoints** inside the VNet. Public network access disabled. Only the media bot (required by Teams) and the web front door are internet-facing, behind Azure Front Door + WAF |
| Encryption in transit | TLS 1.2+ on every connection, including service-to-service inside Azure. Media between Teams and the bot uses Teams' own encrypted media (SRTP) |
| Encryption at rest | AES-256 on all storage. **Customer-managed keys** (per tenant, in Key Vault with HSM backing) on the Enterprise tier. Each tenant can revoke its own key, which makes its data unreadable |
| AI providers | Claude **Hosted on Azure** version only (runs on Azure end-to-end; no Anthropic-hosted endpoint is used). Request the zero-data-retention option where offered **[VERIFY terms]**. Azure AI Speech: real-time mode, **audio logging disabled**. No customer data is used for model training |
| Audio | Processed in memory and **never stored** by default. Optional 30-day retention per tenant policy |
| Identity & access | Entra ID SSO + MFA + Conditional Access. Least-privilege RBAC (5.1). **Managed identities** between services (no keys in code). Just-in-time, audited access for Cody's support staff, and only with customer approval |
| Isolation | Per-tenant search index, storage container, and key. Workspace walls enforced in the data-access layer, with automated cross-tenant/workspace leak tests in CI (4.7) |
| Confidentiality controls | "**Go off the record**" voice command (pauses all listening and memory). Never-record rules (1:1s, HR, keywords, channels). **Microsoft Purview sensitivity labels honored**: Confidential/Highly Confidential meetings and files are not recorded or indexed. Internal-only tags never spoken to external guests |
| Leak prevention in outputs | Sidekick only answers from the current workspace. Web searches are stripped of client names and numbers. Output check (Azure AI Content Safety + PII detection) before anything is posted outside the workspace's channel |
| Audit | Immutable audit log (append-only storage) of sign-ins, access changes, policy changes, data exports and deletions, and every Sidekick action. Exportable to the customer's Microsoft Sentinel/SIEM |
| Data rights | Full export, per-item "forget", workspace deletion, and org deletion with a 7-day cooling-off period. Deletions purge the search index and backups within a stated window |
| Monitoring | Microsoft Defender for Cloud on all resources, Defender for Storage malware scanning on uploads, alerts for unusual access |
| Assurance (roadmap) | Annual third-party penetration test. SOC 2 Type II. Align with Microsoft's Teams app certification / Microsoft 365 App Compliance program for store listing |

**Honest limits to state in the pitch:** encryption and isolation make leaks extremely unlikely, but no system is risk-free. People in a meeting can still repeat what they heard, and admins with access can see transcripts. That's why the off-the-record command, never-record rules, role-based access, and audit log exist.

**Portal surfaces:** Security & audit page shows a "Where your data goes" data-flow panel and the encryption/isolation guarantees. Restrictions page has off-the-record, sensitivity-label, never-record, guest, and retention controls.

## 8. Data model (sketch)

`tenants`, `users`, `workspaces`, `workspace_members`, `workspace_channels`, `connectors` (encrypted creds ref), `documents`, `chunks` (vector), `meetings`, `participants`, `utterances` (speaker, text, lang, translated_text, ts), `hand_raise_candidates` (trigger, answer, confidence, sources, outcome: raised/called_on/ignored/skipped + reason), `agent_turns` (trigger, prompt_ref, response, latency, cost), `notes` (versioned), `action_items`, `tool_calls`, `usage_events` (provider, unit, qty, cost), `feedback`, `audit_log`, `releases`, `feature_flags`.

---

## 9. Phased roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Spikes** (2–4 wks) | On an M365 developer tenant + Azure subscription: C# Graph media bot on an Azure Windows VM joins a meeting, Azure AI Speech STT → Claude (Foundry) → Azure neural TTS answer spoken in the meeting, virtual hand-raise chat card. Measure end-to-end latency | Demo: bot answers a spoken question out loud |
| **1. Scribe MVP** | Join, transcribe, translate, post-meeting notes to a channel, basic portal (connect tenant, upload files, pick channel) | 1 pilot client using it weekly |
| **2. Q&A + live actions** | On-call mode: answers when addressed, RAG and memory across meetings, citations in chat. Jira/DevOps live story creation (Draft level) and draft backlog | > 80% "helpful" ratings |
| **3. Hand-raise teammate** | Memory-gap / unanswered-question detection, pre-fetching, gating, raise-hand (chat fallback), clarifying questions | > 70% of hand-raises get called on; < 1 "annoying" rating per 10 meetings |
| **4. Owner Console + billing** | Full metering, spend dashboards, Stripe, feature flags, releases | Per-tenant margin visible |
| **5. MCP marketplace** | Tenant-configurable MCP servers, write actions with confirmation | — |

---

## 9.5 First customer: Cody's consulting firm (pilot plan)

**Why it's a good fit:** consultants spend all day in Teams meetings across many client engagements. The value is easy to see: no more digging through old meetings, and less copying notes out of Copilot.

**What being a consultancy changes in the design:**
- **Each client engagement = its own Workspace** (see 4.7). It has its own docs, rules, members and memory, inside the firm's account. Sidekick in a Client B meeting can only see Client B's workspace.
- **External attendees:** client staff join many meetings. Sidekick only shares information approved for that engagement. Internal-only material (rates, staffing, internal opinions) is tagged `internal` and never spoken when external guests are present.
- **Consent:** in client-facing meetings, Sidekick announces itself when it joins, and the meeting organizer can turn it off. Some end clients will say no, and that must be a one-click option.
- **Billable-time angle:** the notes can include a time-on-topic breakdown. Useful for consultants' timesheets (later phase).

**Pitch path:**
1. **Build the demo on a separate Microsoft 365 developer tenant**, not the firm's. Installing a bot into the employer's tenant needs IT admin approval anyway.
2. Demo in front-office meetings: answering "what did we decide last month?" out loud, a hand-raise, and auto-posted notes.
3. Propose a **pilot**: one internal team, internal meetings only, for 4–6 weeks, then expand to one client engagement with that client's agreement.
4. Expect IT/security review: data location, retention, what Microsoft permissions are requested, subprocessors: just **Microsoft Azure** (Claude runs Azure-hosted in Foundry; Anthropic is the model provider). A very short list. Prepare a one-page security summary.

**Personal checklist (before pitching):**
- Review your employment agreement for **IP/invention-assignment** and moonlighting clauses. Building this while employed could give the firm a claim on it. Build on your own time and your own equipment and accounts, and consider a quick consult with a lawyer.
- Decide how you'll structure the deal: sell or license it to the firm as an outside vendor, or propose it as an internal project. These lead to very different ownership outcomes.

## 9.6 Connector catalog (the firm "uses everything")

Sidekick is general-purpose. Software engineering is just the first demo story, because that's most of the firm's work. Since the firm uses many tools, connectors must be a **pluggable catalog**, not hard-coded integrations:
- **MCP-first:** every connector is an MCP server (an official vendor server where one exists, otherwise built in-house). New tools get added without changing Sidekick's core.
- **Per-workspace toggles:** each workspace admin turns on the connectors that engagement uses and signs in with OAuth (read-only by default).
- **Catalog page in the portal:** connected status, last sync, and an error indicator for each connector.

**Build order** (most value for a software consultancy first):
1. **Microsoft 365 core** (comes with the Teams install): SharePoint/OneDrive files, Teams channel history, Outlook calendar, Planner
2. **Azure DevOps** (Boards + Repos + Pipelines) and **GitHub** (Issues + PRs + Actions)
3. **Jira + Confluence**
4. Web search/fetch (research)
5. Later: GitLab, Lucidchart/Visio/draw.io diagrams, ServiceNow, Salesforce/HubSpot CRM, Smartsheet/MS Project, Slack, cloud resource inventory (Azure/AWS)

**Connector types by tool category:**
| Tool type | Examples | What Sidekick gets |
|---|---|---|
| Work tracking | Azure DevOps Boards, Jira | Epics, stories, bugs, sprint status, who owns what |
| Code | Azure Repos, GitHub, GitLab | Repo structure, PRs, recent changes, READMEs, code search |
| CI/CD pipelines | Azure Pipelines, GitHub Actions | Last build/deploy status, failures, what's in each release |
| Docs & designs | Confluence, SharePoint, Wiki, ADRs | Specs, solution designs, architecture decision records |
| Diagrams | Visio, draw.io, Lucidchart, Mermaid, images | Architecture and data-flow diagrams, read by a vision-capable model |
| Cloud (later) | Azure/AWS resource inventory | What's deployed where (read-only) |

**What this looks like in a meeting:**
- "Sidekick, did last night's deploy to staging pass?" → "Yes, at 11:42 PM. One flaky test was re-run. Details in chat."
- "What's left in this sprint?" → a quick spoken summary, with the board link and table posted in chat.
- "Why did we pick Cosmos DB over Postgres?" → "ADR-007 from April 3: global replication requirement. Link in chat."
- "How does the auth flow work again?" → a short explanation plus the architecture diagram posted in chat.
- **Hand-raise:** "The story you just mentioned, the payment API, is blocked by bug #482, which is still open."
- **Hand-raise:** "That endpoint change would affect the mobile app. It calls `/orders/v1` in 3 places."

**After the meeting:** action items can be turned into Azure DevOps/Jira work items (with a confirm button on the notes card), linked to the meeting notes.

**Security:** source code is the client's most sensitive asset. Code access is per workspace, read-only, uses scoped OAuth tokens or app installations (never personal passwords), and can be turned off entirely per workspace. Code snippets are never spoken when external guests are present, unless the workspace allows it.

## 10. Open decisions (working-session agenda)

1. ~~Media gateway~~ **Decided & verified:** Microsoft-native Teams app + Graph media bot, hosted in Azure as Microsoft requires (4.1). Raise hand = virtual hand-raise for MVP, with an ACS real-hand R&D track.
2. ~~Speech provider~~ **Decided:** Azure AI Speech (STT + TTS) and Azure AI Translator.
3. ~~Cloud home~~ **Decided (v0.7):** **all Azure**, a single cloud. Claude runs Azure-hosted in Microsoft Foundry, and every AWS service has an Azure equivalent (see 4.6).
4. ~~Customers~~ **Decided:** first client is Cody's consulting firm (see 9.5). *Still open:* firm size, and whether any of its end clients handle regulated data (HIPAA, finance, government).
5. ~~Interjection etiquette~~ **Decided (v0.2):** no corrections. It raises its hand for recall and questions, answers when asked directly, and never interrupts. *Still open:* the default hand-raise rate limit, and whether to include the optional "things to double-check" notes section.
6. **Permissions model:** should the bot only reveal knowledge every participant is allowed to see, including external guests?
7. **Pricing model:** *deferred.* Usage metering is built from day 1 so pricing can be decided later.
8. **Branding:** *no name yet* (`Sidekick` stays a placeholder; it's a single config value plus the Teams manifest). Each client can rename and re-voice its agent: **yes, planned**.
9. **Multi-platform:** Teams-only for now (follows from decision 1). Zoom/Meet would need new `MediaGateway` adapters later.
10. **Data residency and retention defaults.**
11. ~~Pipelines & blueprints~~ **Decided:** the firm does IT consulting and software engineering (building solutions and applications). "Pipelines and blueprints" = CI/CD pipelines, repos, architecture diagrams, and solution designs. See 9.6. The firm uses all of them, so connectors are a pluggable MCP catalog with a set build order (9.6). Sidekick is general-purpose. Engineering is just the lead demo.

---

## 11. Instructions for the build agent (to finalize later)

- Build behind interfaces: `MediaGateway`, `SttProvider`, `TtsProvider`, `TranslateProvider`, `LlmProvider`, `KnowledgeStore`, `ToolGateway`.
- Monorepo layout (proposed): `apps/portal` (React/Next.js), `apps/console` (React/Next.js), `packages/ui` (shared React design system), `apps/teams-app`, `services/orchestrator`, `services/ingestion`, `services/teams-media-bot` (C#), `packages/shared` (types, telemetry, metering).
- Every external call goes through a metering wrapper that emits a `usage_event` with cost.
- Tenant ID **and workspace ID** are required in every DB, vector, storage and tool query path. Add tests that prove cross-tenant and cross-workspace reads fail (see 4.7).
- Ship Phase 0 spikes as runnable demos before writing product UI.
- Two languages: **C#/.NET** only for the Teams media bot (keep it thin), **TypeScript** for everything else. All infrastructure in Bicep (or Terraform), deployed to Azure.
- Never hard-code the product name. Read it from config and the Teams manifest.
- Use the eval harness from day 1: recorded meeting fixtures plus expected notes, answers, and hand-raises.

---

## Sources (verified Oct 14, 2026)
- [Microsoft Learn: Build application-hosted media bots (requirements)](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots): C#/.NET only, Windows Server in Azure for production, allowed Azure hosts, public IP per instance, calls pinned to VM, 2+ cores, 3-month package freshness, "developer preview".
- [Microsoft Learn: Graph participant resource (v1.0)](https://learn.microsoft.com/en-us/graph/api/resources/participant?view=graph-rest-1.0): no raise-hand property or method.
- [Microsoft Learn: Graph cloud communications get started](https://learn.microsoft.com/en-us/graph/cloud-communications-get-started): bot registration options.
- [Microsoft Learn: ACS Calling SDK raise hand](https://learn.microsoft.com/en-us/azure/communication-services/how-tos/calling-sdk/raise-hand): raiseHand()/lowerHand() work in Teams calls; Web GA, Windows/iOS/Android preview; client SDK.
- [Microsoft Learn: Claude models in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models): Azure-hosted GA models (Haiku 5.5, Sonnet 5.5, Opus 5.5, …), Data Zone Standard (US), web search tool, MCP connector, prompt caching, no built-in content filter.
- [Microsoft Learn: Real-time diarization quickstart (Azure AI Speech)](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-stt-diarization)
- [Microsoft Learn: Bing Search API retirement](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement): retired Aug 11, 2025.
