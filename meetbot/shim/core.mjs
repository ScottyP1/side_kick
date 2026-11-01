/**
 * @file The shim inside Sidekick's meeting-bot container (meetbot/, one Azure Container Apps job execution per meeting).
 * It sits between Attendee (running in the same container on 127.0.0.1) and Sidekick (on the internet):
 * - **Events out**: Attendee's webhooks (bot state, caption lines, chat messages, who joins, who speaks, its logs) come
 *   to the shim on 127.0.0.1; it checks Attendee's signature and forwards them to Sidekick's
 *   `/api/live/events/attendee`, under the session id and signed with the session's key (`x-sidekick-bot-*`).
 * - **Commands in**: the container has no inbound address, so the shim long-polls Sidekick's `/api/live/bot/commands`
 *   and carries them out on Attendee: chat, speak (an MP3 from Azure AI Speech), raise/lower hand (our patch), how to
 *   hear (Teams captions or Azure speech-to-text, `audio.mjs`), leave.
 * - **Camera**: Sidekick's logo, a still picture (`bot_image`, meetbot/bot-logo.png), or, when the organization chose
 *   the moving crystal ball (Sidekick sends its page address, `orbUrl`, ORB_URL) and the container's second browser
 *   (Attendee's webpage streamer) is up, the moving ball: that page as the bot's webcam (`voice_agent_settings.url`).
 *   If the browser doesn't start, Attendee refuses it, or the container stays too busy (CPU over `cpuLimit` for
 *   `cpuStrikes` readings in a row), the shim falls back to the logo and stops that browser. It reports
 *   what the bot shows (`sidekick.camera`) and the container's CPU use every few minutes (`sidekick.load`).
 * - **Exits** when the meeting is over for the bot (Attendee says it ended or failed, Sidekick says stop, or the
 *   container's own time limit), after telling Sidekick (`sidekick.exit`), so the job execution ends and stops costing.
 *
 * No dependencies (Node 22 built-ins), so tests (app/tests/run.mjs → meetbot/shim/core.test.mjs) run it against fakes.
 * Who calls it: meetbot/shim/main.mjs (the container's entry), with settings from the environment.
 */
import crypto from "node:crypto";
import http from "node:http";

/** Attendee's webhook triggers the shim asks for. */
export const TRIGGERS = ["bot.state_change", "transcript.update", "chat_messages.update", "participant_events.join_leave", "participant_events.speech_start_stop", "bot_logs.update"];

/** JSON with keys sorted at every level, as Attendee signs it (Python json.dumps(sort_keys=True, separators=(",", ":"))). */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** Whether a webhook really came from the local Attendee (its base64 project secret). */
export function attendeeSigned(secret, signature, body) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", Buffer.from(secret, "base64")).update(canonicalJson(body)).digest();
  const got = Buffer.from(signature, "base64");
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** Plain text as Teams chat HTML (Attendee's send_chat_message): escaped, line breaks kept. */
export const chatHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

/**
 * Creates the shim. `cfg`: session, sidekickUrl, botKey, meetingUrl, botName, botImage, raiseHand, attendeeUrl,
 * attendeeKey, attendeeSecret, port (0 = any), maxMinutes, captionsLanguage, orbUrl, cpuEverySeconds (default 20),
 * cpuLimit (0..1, default 0.9), cpuStrikes (default 3), loadReportSeconds (default 300). Hooks (all optional):
 * `audio` = `{ start(onLine), stop() }` for Azure speech-to-text (audio.mjs); `streamer` = `{ ready(), stop() }` for the
 * moving ball's browser; `load` = `{ sample() }` → the container's CPU share since the last call (load.mjs);
 * `exit(code)` ends the process (tests pass their own). Returns `{ start(), stop(), port }`.
 */
export function createShim(cfg, hooks = {}) {
  const log = hooks.log ?? ((...a) => console.log("[meetbot]", ...a));
  let botId = null;
  let hearing = "captions";
  let lastSpeaker = null;
  let stopping = false;
  let server;
  let timer;
  let loadTimer;
  let orb = false;
  const cpu = { sum: 0, count: 0, peak: 0, strikes: 0, reported: Date.now() };

  /** Sends events to Sidekick, signed with the session's key. Retries a few times; never throws. */
  async function toSidekick(items) {
    const body = JSON.stringify(items.map((i) => ({ bot_id: cfg.session, ...i })));
    for (let attempt = 0; attempt < 3; attempt++) {
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = crypto.createHmac("sha256", cfg.botKey).update(`${ts}.${body}`).digest("base64");
      try {
        const res = await fetch(`${cfg.sidekickUrl}/api/live/events/attendee`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-sidekick-bot-session": cfg.session, "x-sidekick-bot-timestamp": ts, "x-sidekick-bot-signature": `v1,${sig}` },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok || res.status === 401 || res.status === 400) return;
      } catch (e) {
        log("couldn't reach Sidekick", e.message);
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  /** One call to the local Attendee API. */
  async function attendee(method, path, body) {
    const res = await fetch(`${cfg.attendeeUrl}${path}`, {
      method, headers: { Authorization: `Token ${cfg.attendeeKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Attendee ${method} ${path} answered ${res.status}`);
    return res.json().catch(() => ({}));
  }

  /** Waits for the local Attendee to answer (it starts with the container). */
  async function attendeeReady(timeoutMs = 120_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${cfg.attendeeUrl}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.status < 500) return true;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** Ends the container: tells Sidekick why, stops speech-to-text, exits. Once. */
  async function finish(reason) {
    if (stopping) return;
    stopping = true;
    log("exiting:", reason);
    clearTimeout(timer);
    clearInterval(loadTimer);
    await Promise.resolve(hooks.audio?.stop?.()).catch(() => {});
    await toSidekick([...(cpu.count ? [loadEvent()] : []), { trigger: "sidekick.exit", data: { reason } }]);
    server?.close();
    (hooks.exit ?? ((c) => process.exit(c)))(0);
  }

  /** The container's CPU use so far, in percent, as Sidekick saves it. */
  const loadEvent = () => ({ trigger: "sidekick.load", data: { cpu_avg: Math.round((100 * cpu.sum) / Math.max(1, cpu.count)), cpu_peak: Math.round(100 * cpu.peak) } });

  /** Back to the logo: Attendee stops showing the page, the second browser is stopped, Sidekick is told why. */
  async function logoPicture(reason) {
    if (!orb) return;
    orb = false;
    log("camera: back to the logo:", reason);
    await attendee("PATCH", `/api/v1/bots/${encodeURIComponent(botId)}/voice_agent_settings`, { url: "" }).catch((e) => log("couldn't stop the page", e.message));
    await Promise.resolve(hooks.streamer?.stop?.()).catch((e) => log("couldn't stop the page's browser", e.message));
    await toSidekick([{ trigger: "sidekick.camera", data: { camera: "logo", reason, cpu_peak: Math.round(100 * cpu.peak) } }]);
  }

  /** One CPU reading: kept for the report, and too many busy readings in a row end the moving ball. */
  async function checkLoad() {
    const share = hooks.load?.sample?.();
    if (typeof share !== "number" || !Number.isFinite(share)) return;
    cpu.sum += share;
    cpu.count++;
    cpu.peak = Math.max(cpu.peak, share);
    cpu.strikes = share > (cfg.cpuLimit ?? 0.9) ? cpu.strikes + 1 : 0;
    if (orb && cpu.strikes >= (cfg.cpuStrikes ?? 3)) await logoPicture(`the container was too busy (CPU at ${Math.round(100 * share)}%)`);
    if (Date.now() - cpu.reported >= (cfg.loadReportSeconds ?? 300) * 1000) {
      cpu.reported = Date.now();
      await toSidekick([loadEvent()]);
    }
  }

  /** Switches how the bot hears: Azure speech-to-text lines are posted as transcript lines marked `azure_stt`. */
  async function setHearing(source) {
    if (source === hearing) return;
    hearing = source;
    if (source === "stt" && hooks.audio) {
      await hooks.audio.start((text) => toSidekick([{ trigger: "transcript.update", data: { speaker_name: lastSpeaker ?? "Someone", transcription: { transcript: text }, source: "azure_stt" } }]));
    } else if (hooks.audio) {
      await hooks.audio.stop();
    }
    await toSidekick([{ trigger: "sidekick.hearing", data: { source, reason: hooks.audio || source === "captions" ? null : "speech-to-text isn't available in this container" } }]);
  }

  /** Carries out one command from Sidekick. A failure is logged, not fatal. */
  async function run(c) {
    try {
      if (!botId) throw new Error("no bot yet");
      const bot = `/api/v1/bots/${encodeURIComponent(botId)}`;
      if (c.kind === "chat") await attendee("POST", `${bot}/send_chat_message`, { to: "everyone", message: chatHtml(c.data?.text ?? "") });
      else if (c.kind === "speak") await attendee("POST", `${bot}/output_audio`, { type: "audio/mp3", data: c.data?.mp3 ?? "" });
      else if (c.kind === "hand" && cfg.raiseHand) await attendee("POST", `${bot}/raise_hand`, { raised: Boolean(c.data?.raised) });
      else if (c.kind === "hearing") await setHearing(c.data?.source === "stt" ? "stt" : "captions");
      else if (c.kind === "leave") await attendee("POST", `${bot}/leave`, {});
    } catch (e) {
      log(`command ${c.kind} failed:`, e.message);
    }
  }

  /** Long-polls Sidekick for commands until the session is over. */
  async function commandLoop() {
    while (!stopping) {
      try {
        const res = await fetch(`${cfg.sidekickUrl}/api/live/bot/commands?wait=${cfg.pollSeconds ?? 20}`, {
          headers: { "x-sidekick-bot-session": cfg.session, Authorization: `Bearer ${cfg.botKey}` },
          signal: AbortSignal.timeout(((cfg.pollSeconds ?? 20) + 10) * 1000),
        });
        if (res.status === 401) return finish("Sidekick doesn't know this session any more");
        if (res.ok) {
          const out = await res.json();
          for (const c of out.commands ?? []) await run(c);
          if (out.stop) return finish("Sidekick ended the session");
        } else await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        if (stopping) return;
        log("command poll failed:", e.message);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Attendee's webhook: checked, forwarded, and watched for the end of the meeting and captions trouble. */
  async function onWebhook(payload) {
    const { trigger, data = {} } = payload;
    if (trigger === "participant_events.speech_start_stop" && data.event_type === "speech_start") lastSpeaker = data.participant_name ?? lastSpeaker;
    if (trigger === "transcript.update" && hearing === "stt") data.source = "captions"; // a caption while on speech-to-text: "captions work again"
    if (trigger === "bot_logs.update") {
      if (data.entry_type === "could_not_enable_closed_captions") await toSidekick([{ trigger: "sidekick.captions_unavailable", data: { reason: "Teams captions couldn't be turned on" } }]);
      return;
    }
    await toSidekick([{ trigger, data }]);
    if (trigger === "bot.state_change" && ["ended", "fatal_error", "data_deleted"].includes(data.new_state)) await finish(`the bot's state is ${data.new_state}`);
  }

  return {
    get port() {
      return server?.address()?.port;
    },
    /** Starts the local webhook server, waits for Attendee, sends the bot to the meeting and polls for commands. */
    async start() {
      server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          let payload;
          try {
            payload = JSON.parse(raw || "{}");
          } catch {
            res.writeHead(400);
            return res.end();
          }
          if (req.url !== "/attendee" || !attendeeSigned(cfg.attendeeSecret, req.headers["x-webhook-signature"], payload)) {
            res.writeHead(401);
            return res.end();
          }
          res.writeHead(200);
          res.end();
          onWebhook(payload).catch((e) => log("webhook failed", e.message));
        });
      });
      await new Promise((r) => server.listen(cfg.port ?? 8090, "127.0.0.1", r));
      // Never run (and bill) past the longest meeting, whatever happens.
      timer = setTimeout(() => finish("the container's time limit"), (cfg.maxMinutes ?? 270) * 60_000);
      if (!(await attendeeReady(cfg.readyTimeoutMs))) return finish("Attendee didn't start");
      // The moving ball only when its browser came up; otherwise (or if Attendee refuses it) the logo.
      let why = null;
      if (cfg.orbUrl) {
        orb = Boolean(hooks.streamer && (await Promise.resolve(hooks.streamer.ready()).catch(() => false)));
        if (!orb) why = "the moving ball's browser didn't start";
      }
      const create = (withOrb) => attendee("POST", "/api/v1/bots", {
        meeting_url: cfg.meetingUrl,
        bot_name: cfg.botName,
        ...(cfg.botImage ? { bot_image: { type: "image/png", data: cfg.botImage } } : {}),
        metadata: { sidekick_session: cfg.session },
        transcription_settings: { meeting_closed_captions: { teams_language: cfg.captionsLanguage ?? "en-us" } },
        recording_settings: { format: "none" },
        // Local addresses: plain http to the shim on 127.0.0.1 (REQUIRE_HTTPS_WEBHOOKS=false; the audio websocket: our patch).
        webhooks: [{ url: `http://127.0.0.1:${server.address().port}/attendee`, triggers: TRIGGERS }],
        ...(cfg.audioUrl ? { websocket_settings: { audio: { url: cfg.audioUrl, sample_rate: 16000 } } } : {}),
        // The page shown as the bot's webcam (Attendee's "voice agent" page; its audio is silent, answers stay on output_audio).
        ...(withOrb ? { voice_agent_settings: { url: cfg.orbUrl } } : {}),
      });
      try {
        let bot;
        try {
          bot = await create(orb);
        } catch (e) {
          if (!orb) throw e;
          orb = false;
          why = `Attendee refused the moving ball (${e.message})`;
          log("camera:", why);
          await Promise.resolve(hooks.streamer?.stop?.()).catch(() => {});
          bot = await create(false);
        }
        botId = bot.id;
      } catch (e) {
        await toSidekick([{ trigger: "bot.state_change", data: { new_state: "fatal_error", event_type: "could_not_create_bot" } }]);
        return finish(`Attendee couldn't create the bot: ${e.message}`);
      }
      log("bot", botId, "joining", cfg.meetingUrl.slice(0, 60));
      if (cfg.orbUrl) await toSidekick([{ trigger: "sidekick.camera", data: { camera: orb ? "orb" : "logo", reason: why } }]);
      if (hooks.load) loadTimer = setInterval(() => checkLoad().catch((e) => log("load check failed", e.message)), (cfg.cpuEverySeconds ?? 20) * 1000);
      await commandLoop();
    },
    stop: finish,
  };
}
