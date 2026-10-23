/**
 * Wraps the portal's sign-in (/login) and first-run setup (/setup) pages only to tell search engines to skip
 * them (`noindex`, lib/site.ts) and to mark them as part of the installable app (`INSTALLABLE`, lib/pwa.ts), so an
 * iPhone home-screen icon added from the sign-in page opens as an app too. The pages draw their own frame.
 */
import type { Metadata } from "next";
import { NOINDEX } from "@/lib/site";
import { INSTALLABLE } from "@/lib/pwa";

export const metadata: Metadata = { ...NOINDEX, ...INSTALLABLE };

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
