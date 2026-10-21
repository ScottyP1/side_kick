// Group page: client-rendered (data loads after sign-in, and the id comes from the URL in the browser), so it
// opts out of instant-navigation validation; Suspense covers reading the route params.
import { Suspense } from "react";
import GroupView from "./view";

export const instant = false;

export default function GroupPage() {
  return (
    <Suspense fallback={<span className="muted">Loading group…</span>}>
      <GroupView />
    </Suspense>
  );
}
