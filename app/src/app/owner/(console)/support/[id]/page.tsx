// One support ticket (Owner Console): client-rendered with the id from the URL, so it opts out of
// instant-navigation validation; Suspense covers reading the route params.
import { Suspense } from "react";
import OwnerTicketView from "./view";

export const instant = false;

export default function OwnerTicketPage() {
  return (
    <Suspense fallback={<span className="muted">Loading ticket…</span>}>
      <OwnerTicketView />
    </Suspense>
  );
}
