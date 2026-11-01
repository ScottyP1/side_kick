"use client";

/**
 * The crystal ball's "thinking" look, shared by the home page's live panel (components/live-orb.tsx) and the meeting
 * bot's camera page (app/live/orb): the dust swirls as if a finger were stirring it.
 */
import { useEffect, type RefObject } from "react";

/**
 * While `on`, stirs the ball's dust in circles, as if someone were circling a mouse inside it.
 *
 * How: the ball (an unmodified React Bits component) already swirls its dust when the pointer moves
 * over it, by listening to pointer events on the window. This sends it a "ghost pointer" circling the
 * centre of `target` (about half the ball's radius, `size` being the ball's own size prop; a little over one turn a
 * second, wobbling slightly so it looks alive). The ghost steps aside whenever the person's real mouse is over the ball, and a final
 * "pointer left" event lets the dust settle when thinking ends. Nothing happens for reduced motion.
 */
export function useThinkingSwirl(on: boolean, target: RefObject<HTMLElement | null>, reduced: boolean, size = 0.8) {
  useEffect(() => {
    const el = target.current;
    if (!on || reduced || !el) return;
    let raf = 0;
    let realUntil = 0;
    const t0 = performance.now();
    const onReal = (e: PointerEvent) => {
      if (!e.isTrusted) return;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) realUntil = performance.now() + 1200;
    };
    window.addEventListener("pointermove", onReal, { passive: true });
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      if (now < realUntil) return;
      const r = el.getBoundingClientRect();
      const t = (now - t0) / 1000;
      const ballRadius = (size * Math.min(r.width, r.height)) / 2; // the ball's `size`
      const rad = ballRadius * (0.5 + 0.12 * Math.sin(t * 1.7));
      const a = t * 2 * Math.PI * 1.15;
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + r.width / 2 + Math.cos(a) * rad, clientY: r.top + r.height / 2 + Math.sin(a) * rad, pointerType: "mouse" }));
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onReal);
      if (performance.now() >= realUntil) window.dispatchEvent(new PointerEvent("pointerout", { relatedTarget: null })); // let the dust settle
    };
  }, [on, target, reduced, size]);
}
