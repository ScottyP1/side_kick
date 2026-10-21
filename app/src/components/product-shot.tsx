/**
 * Real product pictures on the website, in a frame: a chat-app window, a laptop (the portal) or a phone.
 * The pictures are 2x WebP files in public/site/ (served by the app itself, so the Content-Security-Policy
 * holds), captured from a throwaway local copy with made-up Contoso/Lakeside data. Each has a dark-mode version
 * where one exists, chosen by the browser (<picture> with prefers-color-scheme), so a page downloads only one.
 * Width and height are set so the page doesn't jump while they load; below-the-fold shots load lazily.
 *
 * The chat frame is a generic chat app in Sidekick's own colours, never Microsoft's artwork or logos; the
 * pages say "Teams" only in text.
 */

/** The pictures in public/site/: file stem, pixel size, whether a "-dark" version exists, and whether the picture is cropped (so its bottom fades out). */
export const SHOTS = {
  "chat-answer": { w: 1400, h: 1311, dark: true, fade: false },
  "chat-notes": { w: 1400, h: 1167, dark: true, fade: true },
  "phone-reminder": { w: 640, h: 1132, dark: true, fade: true },
  "portal-groups": { w: 1600, h: 1000, dark: true, fade: false },
  "portal-ask": { w: 1600, h: 1000, dark: false, fade: false },
} as const;

export type ShotName = keyof typeof SHOTS;

/** The <picture> for one shot. `eager` for a shot near the top of a page (skips lazy loading). */
function Picture({ name, alt, eager, sizes }: { name: ShotName; alt: string; eager?: boolean; sizes: string }) {
  const s = SHOTS[name];
  return (
    <picture>
      {s.dark && <source media="(prefers-color-scheme: dark)" srcSet={`/site/${name}-dark.webp ${s.w}w`} sizes={sizes} />}
      <img src={`/site/${name}.webp`} srcSet={`/site/${name}.webp ${s.w}w`} sizes={sizes} width={s.w} height={s.h} alt={alt} loading={eager ? "eager" : "lazy"} decoding="async" />
    </picture>
  );
}

/**
 * A product shot in a frame.
 * - `frame`: "window" (chat app), "laptop" (portal) or "phone".
 * - `alt`: what the picture shows, for people who can't see it.
 * - `caption`: optional line under it (e.g. "Made-up example data").
 */
export function ProductShot({ name, frame, alt, caption, eager }: { name: ShotName; frame: "window" | "laptop" | "phone"; alt: string; caption?: string; eager?: boolean }) {
  const sizes = frame === "phone" ? "300px" : frame === "laptop" ? "(max-width: 900px) 100vw, 880px" : "(max-width: 860px) 100vw, 640px";
  return (
    <figure className={`site-shot ${frame === "laptop" ? "site-laptop" : ""}`} style={{ margin: 0 }}>
      {frame === "window" && <div className={`site-window ${SHOTS[name].fade ? "site-fade" : ""}`}><Picture name={name} alt={alt} eager={eager} sizes={sizes} /></div>}
      {frame === "laptop" && (
        <>
          <div className="site-laptop-screen"><Picture name={name} alt={alt} eager={eager} sizes={sizes} /></div>
          <div className="site-laptop-base" aria-hidden="true" />
        </>
      )}
      {frame === "phone" && <div className="site-phone"><div className="site-fade"><Picture name={name} alt={alt} eager={eager} sizes={sizes} /></div></div>}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
