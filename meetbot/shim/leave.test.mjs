/**
 * Tests for how the meeting-bot shim (meetbot/shim/core.mjs) leaves a call before its container exits, run by
 * app/tests/run.mjs. Found in the first live Teams trial (Nov 1 2026): on "Sidekick, leave" the container exited while
 * the bot was still in the call, so Teams showed a frozen "Sidekick" tile and the goodbye was never said.
 * Covers: Sidekick's stop → the queued goodbye is posted first, then Attendee is asked to leave, and the shim exits only
 * once Attendee says the bot is out; Attendee never confirming → it exits after `leaveTimeoutMs` anyway; a stop from
 * the container itself (SIGTERM, time limit) leaves too; a meeting that already ended exits without asking to leave.
 *
 *   node --test meetbot/shim/leave.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { canonicalJson, createShim } from "./core.mjs";

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

/**
 * A fake Attendee that, when `confirms`, reports the bot left (a signed `ended` webhook to the shim) a moment after
 * `/leave`; and a fake Sidekick whose `stopWith(commands)` makes the next poll hand over `commands` (the goodbye), then
 * say stop, as sessions.ts `takeCommands` does. `log` records the order of what happened.
 */
async function world({ confirms = true } = {}) {
  const secret = crypto.randomBytes(32).toString("base64");
  const log = [];
  const events = [];
  let queued = [];
  let late = [];
  let stop = false;
  let shimPort = null;
  const webhook = async (payload) => {
    const sig = crypto.createHmac("sha256", Buffer.from(secret, "base64")).update(canonicalJson(payload)).digest("base64");
    await fetch(`http://127.0.0.1:${shimPort()}/attendee`, { method: "POST", headers: { "content-type": "application/json", "x-webhook-signature": sig }, body: JSON.stringify(payload) });
  };
  const attendee = http.createServer(async (req, res) => {
    const body = await read(req);
    if (req.url === "/health") return res.end("ok");
    if (req.url === "/api/v1/bots") log.push("create");
    else log.push(req.url.split("/").pop());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/v1/bots" ? { id: "bot_leave" } : {}));
    if (req.url.endsWith("/leave") && confirms) {
      setTimeout(() => webhook({ trigger: "bot.state_change", data: { new_state: "leaving" } })
        .then(() => new Promise((r) => setTimeout(r, 150)))
        .then(() => webhook({ trigger: "bot.state_change", data: { new_state: "ended", event_type: "bot_left" } })), 50);
    }
    void body;
  });
  const sidekick = http.createServer(async (req, res) => {
    const raw = await read(req);
    if (req.url.startsWith("/api/live/bot/commands")) {
      res.writeHead(200, { "content-type": "application/json" });
      await new Promise((r) => setTimeout(r, 20));
      // The shim's last fetch on its way out (wait=0) also gets a goodbye queued after the stop was seen.
      const commands = [...queued.splice(0), ...(req.url.includes("wait=0") ? late.splice(0) : [])];
      return res.end(JSON.stringify({ commands, stop: stop && !commands.length }));
    }
    for (const e of JSON.parse(raw)) {
      events.push(e);
      log.push(`event:${e.trigger}${e.data?.new_state ? `:${e.data.new_state}` : ""}`);
    }
    res.writeHead(202);
    res.end();
  });
  const [ap, sp] = await Promise.all([listen(attendee), listen(sidekick)]);
  let exited = null;
  const shim = createShim({
    session: "sess-leave", sidekickUrl: `http://127.0.0.1:${sp}`, botKey: "leave-key", meetingUrl: "https://teams.microsoft.com/l/meetup-join/z/0",
    botName: "Sidekick", attendeeUrl: `http://127.0.0.1:${ap}`, attendeeKey: "k", attendeeSecret: secret,
    port: 0, pollSeconds: 0, leaveTimeoutMs: 1500, chatSettleMs: 100,
  }, { exit: (c) => {
    exited = c;
    log.push("exit");
  }, log: () => {} });
  shimPort = () => shim.port;
  const running = shim.start();
  await until(() => log.includes("create"));
  return {
    log, events, shim, running, webhook, exited: () => exited,
    stopWith(commands, lateCommands = []) {
      queued.push(...commands);
      late.push(...lateCommands);
      stop = true;
    },
    close() {
      attendee.close();
      sidekick.close();
    },
  };
}

const worlds = [];
after(() => worlds.forEach((w) => w.close()));

test("Sidekick's stop: the goodbye goes out, then the bot leaves, and the container exits once Attendee says it's out", async () => {
  const w = await world();
  worlds.push(w);
  await w.webhook({ trigger: "bot.state_change", data: { new_state: "joined_recording" } });
  w.stopWith([{ id: "1", kind: "chat", data: { text: "Okay, leaving now. The notes will follow in the group's chat." } }, { id: "2", kind: "leave", data: {} }]);
  await w.running;
  assert.equal(w.exited(), 0);
  const order = w.log.filter((x) => ["send_chat_message", "leave", "event:bot.state_change:ended", "event:sidekick.exit", "exit"].includes(x));
  assert.deepEqual(order, ["send_chat_message", "leave", "event:bot.state_change:ended", "event:sidekick.exit", "exit"], w.log.join(", "));
  assert.equal(w.log.filter((x) => x === "leave").length, 1, "asked to leave once");
});

test("a stop with no leave command still leaves the call first; a goodbye queued late is picked up on the way out", async () => {
  const w = await world();
  worlds.push(w);
  w.stopWith([], [{ id: "9", kind: "chat", data: { text: "Leaving now (stopped from the portal)." } }]);
  await w.running;
  assert.ok(w.log.indexOf("send_chat_message") >= 0, "the late goodbye was posted");
  assert.ok(w.log.indexOf("send_chat_message") < w.log.indexOf("leave"), "before leaving");
  assert.ok(w.log.indexOf("leave") < w.log.indexOf("exit"));
  assert.ok(w.log.indexOf("event:bot.state_change:ended") < w.log.indexOf("exit"), "exits after the bot is out");
});

test("Attendee never confirming: the shim exits after its leave timeout anyway (and Sidekick still hears why)", async () => {
  const w = await world({ confirms: false });
  worlds.push(w);
  const t = Date.now();
  await w.shim.stop("the container got SIGTERM");
  assert.equal(w.exited(), 0);
  assert.ok(w.log.includes("leave"), "a stop from the container itself leaves too");
  assert.ok(Date.now() - t >= 1400, "waited for the leave timeout");
  assert.equal(w.events.findLast((e) => e.trigger === "sidekick.exit").data.reason, "the container got SIGTERM");
  w.stopWith([]);
  await w.running;
});

test("the meeting already ended for the bot: it exits without asking to leave", async () => {
  const w = await world();
  worlds.push(w);
  await w.webhook({ trigger: "bot.state_change", data: { new_state: "ended", event_type: "meeting_ended" } });
  await until(() => w.exited() === 0);
  assert.equal(w.log.includes("leave"), false);
  w.stopWith([]);
  await w.running;
});
