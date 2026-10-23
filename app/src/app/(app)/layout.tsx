/**
 * Wraps every signed-in client portal page in the portal frame (components/shell.tsx). Search engines are told to
 * skip these pages (`noindex`), and the pages can be installed as an app (`INSTALLABLE`, lib/pwa.ts).
 */
import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/shell";
import { NOINDEX } from "@/lib/site";
import { BRAND } from "@/lib/brand";
import { INSTALLABLE } from "@/lib/pwa";

export const metadata: Metadata = { ...NOINDEX, ...INSTALLABLE };

/**
 * Lets portal pages use the whole phone screen (`viewport-fit=cover`), so CSS `env(safe-area-inset-*)` reports the
 * iPhone home indicator and notch: the phone tab bar and menu (globals.css) keep clear of them, in Safari and in
 * the installed app.
 */
export const viewport: Viewport = { viewportFit: "cover" };

// The shell loads the signed-in user in the browser, so this segment opts out of instant-navigation validation.
export const instant = false;

/**
 * The shell reads the current path (usePathname) for the menu. Under Cache Components that read suspends while
 * Next builds pages whose URL holds an id (e.g. /workspaces/[id]), so it sits in a Suspense boundary whose
 * fallback matches the shell's own loading screen.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="auth-wrap"><span className="muted">Loading {BRAND.name}…</span></div>}>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
