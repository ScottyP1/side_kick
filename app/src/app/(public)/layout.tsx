/**
 * Wraps every public website page (home, features, pricing, the /docs help center, sign-up…; lib/site.ts
 * `PUBLIC_PAGES`) only to tell browsers not to offer installing the website as an app (`NOT_INSTALLABLE`,
 * lib/pwa.ts): the installable app is the customer portal. Each page draws its own frame (components/public-shell.tsx).
 */
import type { Metadata } from "next";
import { NOT_INSTALLABLE } from "@/lib/pwa";

export const metadata: Metadata = NOT_INSTALLABLE;

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return children;
}
