/**
 * Checkout (/checkout) is for a signed-in organization paying for its plan, so search engines skip it
 * (`noindex`, lib/site.ts); this layout only adds that and the page title.
 */
import type { Metadata } from "next";
import { NOINDEX } from "@/lib/site";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { ...NOINDEX, title: `Checkout · ${BRAND.name}` };

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return children;
}
