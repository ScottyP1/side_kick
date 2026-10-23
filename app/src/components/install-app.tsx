"use client";

/**
 * The quiet "Install the app" hint on the portal's Help page (/help): installing the portal as an app with its
 * own window and icon (lib/pwa.ts, docs/guide/install-app.md).
 *
 * It shows only where it can help, and never nags:
 * - **Chrome / Edge (computer, Android)**: the browser announces it can install the site with a
 *   `beforeinstallprompt` event; the hint then offers an Install button that opens the browser's own dialog.
 * - **iPhone / iPad (Safari)**: no such event exists, so it explains Share → Add to Home Screen instead.
 * - Hidden when already running as the installed app, in other browsers (Firefox, desktop Safari use their own
 *   menus), after "Not now" (remembered in this browser only, localStorage `sk_install_hint`), and after install.
 *
 * Chrome fires `beforeinstallprompt` once per page load, often before the Help page is opened, so this module
 * starts listening as soon as it loads; the portal frame (components/shell.tsx) imports it for that reason.
 */
import { useEffect, useState } from "react";
import { Icon } from "./ui";
import { BRAND } from "@/lib/brand";

/** Chrome/Edge's install event (not in TypeScript's DOM types): `prompt()` opens the browser's install dialog. */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const DISMISS_KEY = "sk_install_hint";

/** The browser's install event once it has fired (null before, after install, or in browsers without one). */
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Keep Chrome's own mini-infobar on phones out of the way; the hint (and the browser's address-bar icon) stay.
    e.preventDefault();
    deferred = e as InstallEvent;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    changed();
  });
}

/** True when the page runs as the installed app (its own window or home-screen app), not in a browser tab. */
function runningInstalled(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone or iPad Safari, where install is Share → Add to Home Screen (iPadOS reports itself as a Mac with touch). */
function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "dismissed";
  } catch {
    return false;
  }
}

/**
 * The hint itself (a small panel), or nothing when install isn't possible or wanted here. Used by the Help page
 * (app/(app)/help/view.tsx); safe anywhere in the portal.
 */
export function InstallAppHint() {
  const [mode, setMode] = useState<"none" | "prompt" | "ios">("none");

  useEffect(() => {
    const update = () => {
      if (runningInstalled() || dismissed()) return setMode("none");
      if (deferred) return setMode("prompt");
      setMode(isIos() ? "ios" : "none");
    };
    update();
    listeners.add(update);
    return () => void listeners.delete(update);
  }, []);

  if (mode === "none") return null;

  const hide = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "dismissed");
    } catch {
      // Private browsing can refuse storage; the hint still hides for this visit.
    }
    setMode("none");
  };

  const install = async () => {
    const ev = deferred;
    if (!ev) return;
    await ev.prompt();
    await ev.userChoice;
    // The event can be used once (Chrome sends a new one on a later visit if the person said no).
    deferred = null;
    setMode("none");
  };

  return (
    <div className="callout info install-hint" role="region" aria-label={`Install ${BRAND.name}`}>
      <Icon n="upload" />
      <div style={{ flex: 1 }}>
        <b>Install {BRAND.name} as an app</b>
        {mode === "prompt" ? (
          <p style={{ margin: "2px 0 8px" }}>Open it from your dock, taskbar or home screen, in its own window. Same sign-in and data as here.</p>
        ) : (
          <p style={{ margin: "2px 0 8px" }}>In Safari, tap Share, then <b>Add to Home Screen</b>. It opens like an app, in its own window.</p>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          {mode === "prompt" && <button className="btn small primary" onClick={install}>Install</button>}
          <button className="btn small ghost" onClick={hide}>Not now</button>
        </div>
      </div>
    </div>
  );
}
