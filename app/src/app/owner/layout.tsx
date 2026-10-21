/**
 * Wraps every Owner Console page (console, sign-in, setup) only to tell search engines to skip them
 * (`noindex`, lib/site.ts). The console's own frame is in owner/(console)/layout.tsx.
 */
import type { Metadata } from "next";
import { NOINDEX } from "@/lib/site";

export const metadata: Metadata = NOINDEX;

export default function OwnerRootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
