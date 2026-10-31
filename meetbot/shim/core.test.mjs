/**
 * Tests for the meeting-bot shim (meetbot/shim/core.mjs), run by app/tests/run.mjs: the shim against a fake Attendee
 * (its API and signed webhooks) and a fake Sidekick (signed events in, commands out), with a fake speech-to-text.
 * Covers: the bot it creates (captions, no recording, local webhooks), unsigned webhooks refused, events forwarded
 * signed with the session key, every command carried out, switching to speech-to-text and back, and exiting when the
 * meeting ends (with sidekick.exit).
 *
 *   node --test meetbot/shim/core.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { canonicalJson, createShim } from "./core.mjs";

const SECRET = crypto.randomBytes(32).toString("base64");
const BOT_KEY = "session-key-123";
const attendeeCalls = [];
const events = [];
const commands = [];
let shimPort;

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const read = (req) => new Promise((r) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => r(b));
});

const attendee = http.createServer(async (req, res) => {
  const body = await read(req);
  if (req.url === "/health") return res.end("ok");
  attendeeCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
  res.writeHead(201, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url === "/api/v1/bots" ? { id: "bot_abc" } : {}));
});
const sidekick = http.createServer(async (req, res) => {
  const raw = await read(req);
  if (req.url.startsWith("/api/live/bot/commands")) {
    if (req.headers.authorization !== `Bearer ${BOT_KEY}` || req.headers["x-sidekick-bot-session"] !== "sess-1") {
      res.writeHead(401);
      return res.end();
    }
    const next = commands.splice(0);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ commands: next.filter((c) => c !== "STOP"), stop: next.includes("STOP") }));
  }
  const ts = req.headers["x-sidekick-bot-timestamp"];
  const ok = req.headers["x-sidekick-bot-signature"] === `v1,${crypto.createHmac("sha256", BOT_KEY).update(`${ts}.${raw}`).digest("base64")}` && req.headers["x-sidekick-bot-session"] === "sess-1";
  for (const e of JSON.parse(raw)) events.push({ ...e, ok });
  res.writeHead(202);
  res.end();
});
const [attendeePort, sidekickPort] = await Promise.all([listen(attendee), listen(sidekick)]);

const audio = { started: 0, stopped: 0, onLine: null, async start(onLine) { this.started++; this.onLine = onLine; }, async stop() { this.stopped++; } };
let exited = null;
const shim = createShim({
  session: "sess-1", sidekickUrl: `http://127.0.0.1:${sidekickPort}`, botKey: BOT_KEY, meetingUrl: "https://teams.microsoft.com/l/meetup-join/x/0",
  botName: "Sidekick (notes)", raiseHand: true, attendeeUrl: `http://127.0.0.1:${attendeePort}`, attendeeKey: "att-key", attendeeSecret: SECRET,
  port: 0, pollSeconds: 0, audioUrl: "ws://127.0.0.1:8091/audio",
}, { audio, exit: (c) => (exited = c), log: () => {} });
const running = shim.start();
after(() => {
  attendee.close();
  sidekick.close();
});

const until = async (check, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("timed out");
};
/** Attendee calling the shim's webhook, signed (or not). */
async function webhook(payload, sign = true) {
  const sig = crypto.createHmac("sha256", Buffer.from(SECRET, "base64")).update(canonicalJson(payload)).digest("base64");
  const res = await fetch(`http://127.0.0.1:${shimPort}/attendee`, { method: "POST", headers: { "content-type": "application/json", ...(sign ? { "x-webhook-signature": sig } : {}) }, body: JSON.stringify(payload) });
  return res.status;
}

test("creates the bot: captions on, nothing recorded, webhooks and audio to the shim on 127.0.0.1", async () => {
  await until(() => attendeeCalls.some((c) => c.url === "/api/v1/bots"));
  shimPort = shim.port;
  const create = attendeeCalls.find((c) => c.url === "/api/v1/bots");
  assert.equal(create.auth, "Token att-key");
  assert.equal(create.body.meeting_url, "https://teams.microsoft.com/l/meetup-join/x/0");
  assert.equal(create.body.bot_name, "Sidekick (notes)");
  assert.equal(create.body.transcription_settings.meeting_closed_captions.teams_language, "en-us");
  assert.equal(create.body.recording_settings.format, "none");
  assert.equal(create.body.webhooks[0].url, `http://127.0.0.1:${shimPort}/attendee`);
  assert.ok(create.body.webhooks[0].triggers.includes("participant_events.speech_start_stop"));
  assert.equal(create.body.websocket_settings.audio.url, "ws://127.0.0.1:8091/audio");
});

test("forwards Attendee's signed webhooks to Sidekick, signed with the session key; refuses unsigned ones", async () => {
  assert.equal(await webhook({ trigger: "transcript.update", data: { speaker_name: "Ana", transcription: { transcript: "Hello" } } }, false), 401);
  assert.equal(await webhook({ trigger: "transcript.update", data: { speaker_name: "Ana", transcription: { transcript: "Hello" } } }), 200);
  await until(() => events.some((e) => e.trigger === "transcript.update"));
  const e = events.find((x) => x.trigger === "transcript.update");
  assert.equal(e.ok, true, "signed with the session key");
  assert.equal(e.bot_id, "sess-1");
  assert.equal(events.filter((x) => x.trigger === "transcript.update").length, 1, "the unsigned one wasn't forwarded");
  // Captions that can't be turned on (Attendee's log) become sidekick.captions_unavailable.
  await webhook({ trigger: "bot_logs.update", data: { entry_type: "could_not_enable_closed_captions", level: "warning" } });
  await until(() => events.some((x) => x.trigger === "sidekick.captions_unavailable"));
});

test("carries out Sidekick's commands: chat (as Teams HTML), speak, hand, leave", async () => {
  commands.push(
    { id: "1", kind: "chat", data: { text: "Line one\nA <b> & c" } },
    { id: "2", kind: "speak", data: { mp3: "SUQzZmFrZQ==" } },
    { id: "3", kind: "hand", data: { raised: true } },
    { id: "4", kind: "leave", data: {} },
  );
  await until(() => attendeeCalls.some((c) => c.url.endsWith("/leave")));
  const by = (end) => attendeeCalls.find((c) => c.url === `/api/v1/bots/bot_abc/${end}`);
  assert.deepEqual(by("send_chat_message").body, { to: "everyone", message: "Line one<br>A &lt;b&gt; &amp; c" });
  assert.deepEqual(by("output_audio").body, { type: "audio/mp3", data: "SUQzZmFrZQ==" });
  assert.deepEqual(by("raise_hand").body, { raised: true });
});

test("switches to Azure speech-to-text and back; its lines are marked, captions during it say captions work", async () => {
  commands.push({ id: "5", kind: "hearing", data: { source: "stt" } });
  await until(() => audio.started === 1);
  await until(() => events.some((x) => x.trigger === "sidekick.hearing" && x.data.source === "stt"));
  await webhook({ trigger: "participant_events.speech_start_stop", data: { participant_name: "Mo", event_type: "speech_start" } });
  await audio.onLine("We moved the review.");
  await until(() => events.some((x) => x.data?.source === "azure_stt"));
  const line = events.find((x) => x.data?.source === "azure_stt");
  assert.equal(line.data.speaker_name, "Mo", "the person speaking now");
  await webhook({ trigger: "transcript.update", data: { speaker_name: "Mo", transcription: { transcript: "We moved the review." } } });
  await until(() => events.some((x) => x.trigger === "transcript.update" && x.data.source === "captions"));
  commands.push({ id: "6", kind: "hearing", data: { source: "captions" } });
  await until(() => audio.stopped >= 1);
});

test("exits when the meeting is over for the bot, after telling Sidekick", async () => {
  await webhook({ trigger: "bot.state_change", data: { new_state: "ended", old_state: "joined_recording", event_type: "meeting_ended" } });
  await until(() => exited === 0);
  assert.ok(events.some((x) => x.trigger === "bot.state_change" && x.data.new_state === "ended"));
  assert.ok(events.some((x) => x.trigger === "sidekick.exit"));
  await running;
});
