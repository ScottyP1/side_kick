/**
 * @file Azure AI Speech speech-to-text for the meeting bot, used only when Teams captions are off or stalled (Sidekick
 * decides, app/src/lib/live-meetings/rules.ts `hearingNext`, and sends a `hearing` command). Attendee streams the
 * meeting's mixed audio to this websocket (`websocket_settings.audio`, 16 kHz); while speech-to-text is on, the audio
 * goes to Azure AI Speech in Sidekick's own subscription (key and region from the job's secrets) and each recognised
 * sentence comes back through `onLine`. While it's off, audio is dropped at once (nothing is kept or sent anywhere).
 *
 * Trial: Attendee's audio chunks are base64 (its docs show a WAV header on each); the header is skipped if present.
 * Dependencies: `ws`, `microsoft-cognitiveservices-speech-sdk` (meetbot/shim/package.json).
 */
import { WebSocketServer } from "ws";
import * as sdk from "microsoft-cognitiveservices-speech-sdk";

/** Starts the local audio websocket; returns `{ start(onLine), stop() }` for core.mjs. */
export async function createAudio({ port, key, region, language = "en-US" }) {
  let push = null;
  let recognizer = null;
  const wss = new WebSocketServer({ host: "127.0.0.1", port, path: "/audio" });
  wss.on("connection", (socket) => {
    socket.on("message", (msg) => {
      if (!push) return; // captions mode: the audio isn't used
      try {
        const m = JSON.parse(String(msg));
        let pcm = Buffer.from(m?.data?.chunk ?? "", "base64");
        if (pcm.subarray(0, 4).toString("ascii") === "RIFF") pcm = pcm.subarray(44);
        push.write(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
      } catch {
        // not an audio message
      }
    });
  });
  return {
    async start(onLine) {
      if (recognizer) return;
      push = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
      const speech = sdk.SpeechConfig.fromSubscription(key, region);
      speech.speechRecognitionLanguage = language;
      recognizer = new sdk.SpeechRecognizer(speech, sdk.AudioConfig.fromStreamInput(push));
      recognizer.recognized = (_s, e) => {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) onLine(e.result.text);
      };
      await new Promise((ok, fail) => recognizer.startContinuousRecognitionAsync(ok, fail));
    },
    async stop() {
      const r = recognizer;
      recognizer = null;
      push?.close();
      push = null;
      if (r) await new Promise((ok) => r.stopContinuousRecognitionAsync(() => { r.close(); ok(); }, () => ok()));
    },
  };
}
