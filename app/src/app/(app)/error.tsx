"use client";

/** Crash screen for client portal pages (keeps the sidebar and header working). See components/crash.tsx. */
import { CrashScreen } from "@/components/crash";

export default function PortalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <CrashScreen error={error} retry={retry} area="Portal" />;
}
