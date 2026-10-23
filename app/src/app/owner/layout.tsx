/**
 * Wraps every Owner Console page (console, sign-in, setup) only to tell search engines to skip them
 * (`noindex`, lib/site.ts) and browsers not to offer installing it as an app (`NOT_INSTALLABLE`, lib/pwa.ts: the
 * installable app is the customer portal). The console's own frame is in owner/(console)/layout.tsx.
 */
import type { Metadata } from "next";
import { NOINDEX } from "@/lib/site";
import { NOT_INSTALLABLE } from "@/lib/pwa";

export const metadata: Metadata = { ...NOINDEX, ...NOT_INSTALLABLE };

export default function OwnerRootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
