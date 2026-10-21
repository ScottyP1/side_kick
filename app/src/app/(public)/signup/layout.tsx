/**
 * Sign up (/signup) is a client page, which can't export metadata itself, so this layout gives it its title,
 * description and link preview (lib/site.ts).
 */
import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site";

export const metadata: Metadata = pageMetadata("/signup");

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
