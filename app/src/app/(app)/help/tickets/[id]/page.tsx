// One support ticket (portal): client-rendered, and the id comes from the URL in the browser, so it opts out of
// instant-navigation validation; Suspense covers reading the route params.
import { Suspense } from "react";
import TicketView from "./view";

export const instant = false;

export default function TicketPage() {
  return (
    <Suspense fallback={<span className="muted">Loading ticket…</span>}>
      <TicketView />
    </Suspense>
  );
}
