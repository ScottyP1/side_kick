/** Wraps every Owner Console page in the console frame (components/owner-shell.tsx). */
import { Suspense } from "react";
import { OwnerShell } from "@/components/owner-shell";

// Loads the owner session in the browser, so this segment opts out of instant-navigation validation.
export const instant = false;

export default function OwnerLayout({ children }: { children: React.ReactNode }) {
  // The sidebar reads the current address (usePathname). Under pages with an id in the address (a
  // client's page), Next.js needs that read inside <Suspense> or the production build fails; the frame
  // shows its own loading state until the owner session loads anyway.
  return (
    <Suspense fallback={<div className="auth-wrap"><span className="muted">Loading Owner Console…</span></div>}>
      <OwnerShell>{children}</OwnerShell>
    </Suspense>
  );
}
