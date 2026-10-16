"use client";

/** Crash screen for Owner Console pages (keeps the console menu working). See components/crash.tsx. */
import { CrashScreen } from "@/components/crash";

export default function ConsoleError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <CrashScreen error={error} retry={retry} area="Owner Console" />;
}
