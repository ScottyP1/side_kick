/**
 * @file Spoken answers for live meetings: text to speech with **Azure AI Speech in Sidekick's own Azure subscription**
 * (no new vendor; docs/LIVE-MEETINGS.md). Returns MP3 that the meeting bot plays through its microphone
 * (lib/live-meetings/provider.ts `speak`).
 *
 * Concepts
 * - **Where**: `AZURE_SPEECH_KEY` with `AZURE_SPEECH_REGION` (e.g. `eastus`), or `AZURE_SPEECH_TTS_URL` for another
 *   endpoint (the tests' fake; plain http only outside production). REST API: `POST /cognitiveservices/v1` with SSML,
 *   output `audio-24khz-48kbitrate-mono-mp3` (https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech).
 * - **Voice and speed**: chosen in the portal (lib/live-meetings/voices.ts: the organization's default, a group's
 *   override); only voices from that list, 0.9×–1.2× (SSML prosody rate).
 * - **Short only**: spoken answers are a sentence or two (lib/live-meetings/rules.ts `spokenText`), so one request is
 *   fast (well under a second for a short sentence) and costs a fraction of a cent ($15 per million characters).
 * - **Not configured** = no spoken answers anywhere; Sidekick answers in the chat only and the group page says why.
 *
 * Who may call: lib/live-meetings/sessions.ts only. Each call is a trace span (kind `live`, length only).
 */
import "server-only";
import { span } from "../trace";
import { DEFAULT_VOICE, isSpeed, isVoice, rateOf } from "./voices";

/** The Azure AI Speech text-to-speech address, or null when spoken answers aren't set up. */
function ttsUrl(): string | null {
  const explicit = process.env.AZURE_SPEECH_TTS_URL?.trim();
  if (explicit) return /^https:\/\//i.test(explicit) || process.env.NODE_ENV !== "production" ? explicit : null;
  const region = process.env.AZURE_SPEECH_REGION?.trim();
  return region && /^[a-z0-9]+$/.test(region) ? `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1` : null;
}

/** Whether spoken answers can be made on this copy of Sidekick. */
export const speechConfigured = () => Boolean(process.env.AZURE_SPEECH_KEY?.trim() && ttsUrl());

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Turns a short text into speech (MP3, base64). Throws a plain error when it isn't configured or Azure refuses (the
 * caller then answers in the chat only).
 */
export async function synthesize(text: string, opts: { voiceId?: string | null; speed?: number | null } = {}): Promise<string> {
  const url = ttsUrl();
  const key = process.env.AZURE_SPEECH_KEY?.trim();
  if (!url || !key) throw new Error("Spoken answers aren't set up (Azure AI Speech).");
  // Only allowed voices and speeds (lib/live-meetings/voices.ts); anything else is the default.
  const voice = isVoice(opts.voiceId) ? opts.voiceId : DEFAULT_VOICE;
  const speed = isSpeed(opts.speed) ? opts.speed : 1;
  const words = xml(text.slice(0, 600));
  const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="${xml(voice)}">${speed === 1 ? words : `<prosody rate="${rateOf(speed)}">${words}</prosody>`}</voice></speak>`;
  return span("live", "Make the spoken answer (Azure AI Speech)", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "sidekick" },
      body: ssml,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Azure AI Speech couldn't make the spoken answer (${res.status}).`);
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  }, { chars: text.length });
}
