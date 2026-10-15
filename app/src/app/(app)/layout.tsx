import { AppShell } from "@/components/shell";

// The shell loads the signed-in user in the browser, so this segment opts out of instant-navigation validation.
export const instant = false;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
