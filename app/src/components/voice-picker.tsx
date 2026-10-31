"use client";

/**
 * The meeting-voice picker shared by Settings (the organization's default) and a group's "Live in meetings" panel (its
 * override): a voice from the curated Azure AI Speech list (lib/live-meetings/voices.ts), a speed from 0.9× to 1.2×,
 * and **Play sample** (POST /api/live/voice/sample; cached per voice and speed, so replays cost nothing). When speech
 * isn't set up the button says so instead of failing. `inherit` adds a "Use the organization's voice" choice (null).
 */
import { useState } from "react";
import { api, useReportError } from "@/components/ui";
import { SPEEDS, VOICES, voiceLabel } from "@/lib/live-meetings/voices";

export function VoicePicker({ voiceId, speed, onChange, disabled, inherit, speechReady }: {
  voiceId: string | null; speed: number | null; onChange: (v: { voiceId?: string | null; speed?: number | null }) => void;
  disabled?: boolean; inherit?: string | null; speechReady: boolean;
}) {
  const reportError = useReportError();
  const [playing, setPlaying] = useState(false);
  const play = async () => {
    const id = voiceId ?? inherit;
    if (!id) return;
    setPlaying(true);
    try {
      const { mp3 } = await api<{ mp3: string }>("/api/live/voice/sample", { method: "POST", json: { voiceId: id, speed: speed ?? 1 } });
      await new Audio(`data:audio/mpeg;base64,${mp3}`).play();
    } catch (e) {
      reportError(e);
    } finally {
      setPlaying(false);
    }
  };
  return (
    <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <select className="input" style={{ width: "auto" }} disabled={disabled} value={voiceId ?? ""} onChange={(e) => onChange({ voiceId: e.target.value || null })} aria-label="Voice">
        {inherit !== undefined && <option value="">The organization&apos;s voice{inherit ? ` (${voiceLabel(inherit).split(" ·")[0]})` : ""}</option>}
        {VOICES.map((v) => <option key={v.id} value={v.id}>{v.label} · {v.gender}, {v.accent}</option>)}
      </select>
      <select className="input" style={{ width: "auto" }} disabled={disabled} value={speed ?? ""} onChange={(e) => onChange({ speed: e.target.value ? Number(e.target.value) : null })} aria-label="Speaking speed">
        {inherit !== undefined && <option value="">Organization&apos;s speed</option>}
        {SPEEDS.map((s) => <option key={s} value={s}>{s.toFixed(2).replace(/0$/, "")}×</option>)}
      </select>
      {speechReady
        ? <button type="button" className="btn small" onClick={play} disabled={playing || !(voiceId ?? inherit)}>{playing ? "Playing…" : "Play sample"}</button>
        : <span className="muted" style={{ fontSize: 12.5 }}>Samples play once spoken answers are set up.</span>}
    </span>
  );
}
