import { OwnerShell } from "@/components/owner-shell";

// Loads the owner session in the browser, so this segment opts out of instant-navigation validation.
export const instant = false;

export default function OwnerLayout({ children }: { children: React.ReactNode }) {
  return <OwnerShell>{children}</OwnerShell>;
}
