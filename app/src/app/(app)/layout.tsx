/**
 * Wraps every signed-in client portal page in the portal frame (components/shell.tsx). Search engines are told to
 * skip these pages (`noindex`), and the pages can be installed as an app (`INSTALLABLE`, lib/pwa.ts).
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/shell";
import { NOINDEX } from "@/lib/site";
import { BRAND } from "@/lib/brand";
import { INSTALLABLE } from "@/lib/pwa";

export const metadata: Metadata = { ...NOINDEX, ...INSTALLABLE };

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
