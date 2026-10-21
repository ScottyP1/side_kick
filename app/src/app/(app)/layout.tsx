/** Wraps every signed-in client portal page in the portal frame (components/shell.tsx). */
import { Suspense } from "react";
import { AppShell } from "@/components/shell";

// The shell loads the signed-in user in the browser, so this segment opts out of instant-navigation validation.
export const instant = false;

/**
 * The shell reads the current path (usePathname) for the menu. Under Cache Components that read suspends while
 * Next builds pages whose URL holds an id (e.g. /workspaces/[id]), so it sits in a Suspense boundary whose
 * fallback matches the shell's own loading screen.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="auth-wrap"><span className="muted">Loading Sidekick…</span></div>}>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
