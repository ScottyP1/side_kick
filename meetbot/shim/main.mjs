/**
 * @file The meeting-bot container's shim entry (meetbot/entrypoint.sh starts it after Redis and Attendee). Reads its
 * settings from the environment the job execution was started with (app/src/lib/live-meetings/launcher.ts) and the
 * job's secrets, then runs the shim (core.mjs) with Azure speech-to-text (audio.mjs) when a Speech key is there.
 *
 * Environment: SIDEKICK_SESSION, SIDEKICK_URL, SIDEKICK_BOT_KEY, MEETING_URL, BOT_NAME, RAISE_HAND, ORB_URL (optional: the
 * animated crystal ball's page; entrypoint.sh then starts Attendee's webpage streamer on WEBPAGE_STREAMER_PORT) (from the launch);
 * AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (job secrets); Attendee's API key and webhook secret from the file bootstrap.py
 * wrote (or ATTENDEE_API_KEY / ATTENDEE_WEBHOOK_SECRET); optional
 * ATTENDEE_URL (default http://127.0.0.1:8000), MEETBOT_MAX_MINUTES (default 270).
 */
import fs from "node:fs";
import { createShim } from "./core.mjs";
import { createLoad } from "./load.mjs";

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`[meetbot] missing ${k}`);
    process.exit(2);
  }
  return v;
};

// Attendee's credentials for this meeting, made inside the container by bootstrap.py.
let creds = {};
try {
  creds = JSON.parse(fs.readFileSync("/tmp/meetbot-credentials.json", "utf8"));
} catch {
  creds = {};
}
const attendeeKey = process.env.ATTENDEE_API_KEY || creds.apiKey;
const attendeeSecret = process.env.ATTENDEE_WEBHOOK_SECRET || creds.webhookSecret;
if (!attendeeKey || !attendeeSecret) {
  console.error("[meetbot] no Attendee credentials");
  process.exit(2);
}

const audioPort = 8091;
let audio;
if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION) {
  const { createAudio } = await import("./audio.mjs");
  audio = await createAudio({ port: audioPort, key: process.env.AZURE_SPEECH_KEY, region: process.env.AZURE_SPEECH_REGION });
}

// The animated ball's browser (Attendee's webpage streamer, started by entrypoint.sh when ORB_URL is set).
const streamerUrl = `http://127.0.0.1:${process.env.WEBPAGE_STREAMER_PORT || 8001}`;
const streamer = process.env.ORB_URL ? {
  /** Waits up to a minute for the streamer to answer its keepalive. */
  async ready() {
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`${streamerUrl}/keepalive`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(2000) })).ok) return true;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  },
  /** Stops it (frees its CPU once the bot shows the still picture). */
  async stop() {
    await fetch(`${streamerUrl}/shutdown`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) }).catch(() => {});
  },
} : undefined;

const shim = createShim({
  session: need("SIDEKICK_SESSION"),
  sidekickUrl: need("SIDEKICK_URL").replace(/\/+$/, ""),
  botKey: need("SIDEKICK_BOT_KEY"),
  meetingUrl: need("MEETING_URL"),
  botName: process.env.BOT_NAME || "Sidekick",
  // Shown as the bot's video in the meeting instead of initials: the crystal ball (meetbot/bot-image.png).
  botImage: await fs.promises.readFile(process.env.BOT_IMAGE || "/meetbot/bot-image.png").then((b) => b.toString("base64")).catch(() => null),
  raiseHand: process.env.RAISE_HAND === "1",
  attendeeUrl: process.env.ATTENDEE_URL || "http://127.0.0.1:8000",
  attendeeKey,
  attendeeSecret,
  maxMinutes: Number(process.env.MEETBOT_MAX_MINUTES) || 270,
  audioUrl: audio ? `ws://127.0.0.1:${audioPort}/audio` : null,
  orbUrl: process.env.ORB_URL || null,
}, { audio, streamer, load: createLoad() });

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => shim.stop(`the container got ${sig}`));
await shim.start();
