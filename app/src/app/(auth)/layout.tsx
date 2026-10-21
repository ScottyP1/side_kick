/**
 * Wraps the portal's sign-in (/login) and first-run setup (/setup) pages only to tell search engines to skip
 * them (`noindex`, lib/site.ts). The pages draw their own frame.
 */
import type { Metadata } from "next";
import { NOINDEX } from "@/lib/site";

export const metadata: Metadata = NOINDEX;

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
