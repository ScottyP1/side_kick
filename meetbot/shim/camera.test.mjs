/**
 * Tests for the meeting bot's camera (meetbot/shim/core.mjs "Camera", meetbot/shim/load.mjs), run by app/tests/run.mjs:
 * the shim against a fake Attendee, a fake Sidekick, a fake webpage streamer and fake CPU readings.
 * Covers: the moving ball asked for only when its browser is up (and reported), the logo when it isn't or
 * when Attendee refuses it (the bot is still created), falling back to the logo when the container stays
 * too busy (Attendee told, the browser stopped, Sidekick told why), CPU use reported, the CPU arithmetic, and that our
 * Attendee patch points the streamer's page script at the streamer's own port (else a red error box shows on the camera).
 *
 *   node --test meetbot/shim/camera.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createShim } from "./core.mjs";
import { coresFrom, cpuShare, createLoad } from "./load.mjs";

const BOT_KEY = "camera-key";
const ORB = "https://sidekick.example/live/orb?session=s&sig=x";
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const read = (req) => new Promise((r) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => r(b));
});
const until = async (check, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("timed out");
};

/** A fake Attendee (refusing voice agent settings when `refuseOrb`) and a fake Sidekick that stops after `stopAfter`. */
async function world({ refuseOrb = false } = {}) {
  const calls = [];
  const events = [];
  let stop = false;
  const attendee = http.createServer(async (req, res) => {
    const body = await read(req);
    if (req.url === "/health") return res.end("ok");
    const json = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, url: req.url, body: json });
    if (req.url === "/api/v1/bots" && refuseOrb && json.voice_agent_settings) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ voice_agent_settings: ["Voice agents are not enabled."] }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/v1/bots" ? { id: "bot_cam" } : {}));
  });
  const sidekick = http.createServer(async (req, res) => {
    const raw = await read(req);
    if (req.url.startsWith("/api/live/bot/commands")) {
      res.writeHead(200, { "content-type": "application/json" });
      await new Promise((r) => setTimeout(r, 20));
      return res.end(JSON.stringify({ commands: [], stop }));
    }
    for (const e of JSON.parse(raw)) events.push(e);
    res.writeHead(202);
    res.end();
  });
  const [ap, sp] = await Promise.all([listen(attendee), listen(sidekick)]);
  return {
    calls, events, ap, sp,
    end() {
      stop = true;
    },
    close() {
      attendee.close();
      sidekick.close();
    },
  };
}

/** Starts a shim with the camera settings and fakes; returns it with what the fakes saw. */
function shimFor(w, { orbUrl = ORB, streamerUp = true, readings = [] } = {}) {
  const streamer = { stopped: 0, ready: async () => streamerUp, stop: async () => void streamer.stopped++ };
  const load = { sample: () => (readings.length ? readings.shift() : 0.3) };
  let exited = null;
  const shim = createShim({
    session: "sess-cam", sidekickUrl: `http://127.0.0.1:${w.sp}`, botKey: BOT_KEY, meetingUrl: "https://teams.microsoft.com/l/meetup-join/y/0",
    botName: "Sidekick", botImage: "iVBORw0KGgo=", attendeeUrl: `http://127.0.0.1:${w.ap}`, attendeeKey: "k", attendeeSecret: crypto.randomBytes(32).toString("base64"),
    port: 0, pollSeconds: 0, orbUrl, cpuEverySeconds: 0.05, cpuLimit: 0.9, cpuStrikes: 3, loadReportSeconds: 0.1, leaveTimeoutMs: 200,
  }, { streamer, load, exit: (c) => (exited = c), log: () => {} });
  const running = shim.start();
  return { shim, streamer, running, exited: () => exited };
}

const worlds = [];
after(() => worlds.forEach((w) => w.close()));

test("shows the moving ball when its browser is up: the page as the webcam, the logo behind it", async () => {
  const w = await world();
  worlds.push(w);
  const s = shimFor(w);
  await until(() => w.events.some((e) => e.trigger === "sidekick.camera"));
  const create = w.calls.find((c) => c.url === "/api/v1/bots");
  assert.deepEqual(create.body.voice_agent_settings, { url: ORB });
  assert.equal(create.body.bot_image.data, "iVBORw0KGgo=", "the logo shows until the page streams, and after a fallback");
  assert.equal(w.events.find((e) => e.trigger === "sidekick.camera").data.camera, "orb");
  // CPU use is reported to Sidekick (here every 0.1 s).
  await until(() => w.events.some((e) => e.trigger === "sidekick.load"));
  assert.equal(w.events.find((e) => e.trigger === "sidekick.load").data.cpu_avg, 30);
  w.end();
  await s.running;
  assert.equal(s.exited(), 0);
  assert.ok(w.events.findLast((e) => e.trigger === "sidekick.exit"), "exits after the meeting");
  assert.equal(s.streamer.stopped, 0, "a calm container keeps the ball");
});

test("falls back to the logo when the ball's browser didn't start, and says so", async () => {
  const w = await world();
  worlds.push(w);
  const s = shimFor(w, { streamerUp: false });
  await until(() => w.events.some((e) => e.trigger === "sidekick.camera"));
  assert.equal(w.calls.find((c) => c.url === "/api/v1/bots").body.voice_agent_settings, undefined);
  const cam = w.events.find((e) => e.trigger === "sidekick.camera").data;
  assert.equal(cam.camera, "logo");
  assert.match(cam.reason, /browser didn't start/);
  w.end();
  await s.running;
});

test("Attendee refusing the ball doesn't cost the meeting: the bot is created again with the logo", async () => {
  const w = await world({ refuseOrb: true });
  worlds.push(w);
  const s = shimFor(w);
  await until(() => w.events.some((e) => e.trigger === "sidekick.camera"));
  const creates = w.calls.filter((c) => c.url === "/api/v1/bots");
  assert.equal(creates.length, 2);
  assert.ok(creates[0].body.voice_agent_settings && !creates[1].body.voice_agent_settings);
  const cam = w.events.find((e) => e.trigger === "sidekick.camera").data;
  assert.equal(cam.camera, "logo");
  assert.match(cam.reason, /refused/);
  assert.equal(s.streamer.stopped, 1, "its browser is stopped");
  assert.ok(!w.events.some((e) => e.trigger === "bot.state_change"), "no failed join reported");
  w.end();
  await s.running;
});

test("a container too busy for three readings in a row falls back to the logo", async () => {
  const w = await world();
  worlds.push(w);
  // One busy reading, a calm one (the count starts again), then three busy ones.
  const s = shimFor(w, { readings: [0.95, 0.5, 0.97, 0.99, 0.96] });
  await until(() => w.events.some((e) => e.trigger === "sidekick.camera" && e.data.camera === "logo"));
  const patch = w.calls.find((c) => c.method === "PATCH");
  assert.equal(patch.url, "/api/v1/bots/bot_cam/voice_agent_settings");
  assert.deepEqual(patch.body, { url: "" }, "Attendee stops showing the page (back to the bot image)");
  assert.equal(s.streamer.stopped, 1);
  const cam = w.events.find((e) => e.trigger === "sidekick.camera" && e.data.camera === "logo").data;
  assert.match(cam.reason, /too busy \(CPU at 96%\)/);
  assert.equal(cam.cpu_peak, 99);
  assert.equal(w.calls.filter((c) => c.method === "PATCH").length, 1, "only once");
  w.end();
  await s.running;
});

test("without a page address (the logo chosen) nothing about the camera changes (the logo, no camera event)", async () => {
  const w = await world();
  worlds.push(w);
  const s = shimFor(w, { orbUrl: null });
  await until(() => w.calls.some((c) => c.url === "/api/v1/bots"));
  assert.equal(w.calls.find((c) => c.url === "/api/v1/bots").body.voice_agent_settings, undefined);
  w.end();
  await s.running;
  assert.ok(!w.events.some((e) => e.trigger === "sidekick.camera"));
});

test("CPU arithmetic: share of the container's limit from cgroup v2 readings", () => {
  assert.equal(cpuShare({ usageUs: 0, atMs: 0 }, { usageUs: 1_000_000, atMs: 1000 }, 2), 0.5);
  assert.equal(cpuShare({ usageUs: 0, atMs: 0 }, { usageUs: 1, atMs: 0 }, 2), null);
  assert.equal(coresFrom("200000 100000", 8), 2);
  assert.equal(coresFrom("max 100000", 8), 8);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-"));
  fs.writeFileSync(path.join(dir, "cpu.stat"), "usage_usec 1000\nuser_usec 900\n");
  fs.writeFileSync(path.join(dir, "cpu.max"), "200000 100000\n");
  // A fake clock, so the result doesn't depend on how fast the machine is (a slow CI runner made this flaky, Nov 3).
  let clock = 1_000_000;
  const load = createLoad({ root: dir, now: () => clock });
  assert.equal(load.sample(), null, "the first reading has nothing to compare with");
  clock += 20;
  fs.writeFileSync(path.join(dir, "cpu.stat"), "usage_usec 21000\nuser_usec 900\n");
  assert.equal(load.sample(), 0.5, "20 ms of CPU over 20 ms on 2 vCPU");
  assert.equal(createLoad({ root: path.join(dir, "missing") }).sample(), null, "outside a container: null");
});

test("patch 03 points the streamer's page script at its own port (8000 is Attendee's API here)", () => {
  const patch = fs.readFileSync(new URL("../patches/03-local-webpage-streamer.patch", import.meta.url), "utf8");
  // Without this the page's microphone hookup asks Attendee's API for the meeting audio, fails, and Attendee's script
  // draws "Failed to receive remote audio stream within 10 seconds" over the ball (first live test, Nov 1).
  assert.match(patch, /\+\s*payload_code = payload_code\.replace\("http:\/\/localhost:8000\/", f"http:\/\/localhost:\{os\.getenv\('WEBPAGE_STREAMER_PORT', '8000'\)\}\/"\)/);
  assert.match(patch, /\+\s*port = int\(os\.getenv\("WEBPAGE_STREAMER_PORT", "8000"\)\)/);
});
