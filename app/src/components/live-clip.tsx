"use client";
/**
 * Short, silent, looping clips of Sidekick live in a real Teams meeting, for the public website (home,
 * Features). Recorded in Cody's test tenant with made-up Contoso content (Nov 1 2026), cropped to the meeting
 * tile and the meeting chat, muted, 10 seconds each; WebM with an MP4 fallback and a WebP poster in
 * public/site/ (served by the app itself, so the Content-Security-Policy's default-src 'self' covers them).
 *
 * Keeps pages fast: nothing is downloaded until the clip is about to scroll into view (preload="none" plus an
 * IntersectionObserver), it pauses again off screen, and the poster reserves the space (width/height) so the
 * page doesn't jump. People who ask for reduced motion get the poster and a play button instead of autoplay;
 * if the browser refuses to autoplay, the controls appear so the clip can still be played.
 */
import { useEffect, useRef } from "react";

/** The clips in public/site/: file stem and pixel size (every clip has `<stem>.webm`, `.mp4` and `-poster.webp`). */
export const CLIPS = {
  "clip-live-ask": { w: 1280, h: 562 },
  "clip-live-hand": { w: 1280, h: 562 },
  "clip-live-speak": { w: 1280, h: 562 },
} as const;

export type ClipName = keyof typeof CLIPS;

/**
 * One clip in a window frame, like the product shots (components/product-shot.tsx).
 * - `alt`: what happens in the clip, for screen readers (the video has no sound and no dialogue to caption).
 * - `caption`: optional line under it.
 */
export function LiveClip({ name, alt, caption }: { name: ClipName; alt: string; caption?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const c = CLIPS[name];

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // The browser's own controls appear when autoplay isn't wanted (reduced motion) or isn't allowed.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      v.controls = true;
      return;
    }
    v.muted = true;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          v.preload = "auto";
          v.play().catch(() => (v.controls = true));
        } else v.pause();
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(v);
    return () => io.disconnect();
  }, []);

  return (
    <figure className="site-shot site-clip" style={{ margin: 0 }}>
      <div className="site-window">
        <video
          ref={ref}
          muted
          loop
          playsInline
          preload="none"
          poster={`/site/${name}-poster.webp`}
          width={c.w}
          height={c.h}
          aria-label={alt}
        >
          <source src={`/site/${name}.webm`} type="video/webm" />
          <source src={`/site/${name}.mp4`} type="video/mp4" />
        </video>
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
