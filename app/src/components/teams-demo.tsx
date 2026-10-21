/**
 * A static picture of Sidekick at work in a Teams group chat, for the public website: a question and its
 * answer card with sources, a meeting-notes card and a reminder card. Plain HTML and CSS (public-site.css),
 * no images or scripts. All names and data are made up (Contoso is Microsoft's own sample company name):
 * it shows what the cards look like, not a real conversation.
 */

/** The demo chat window. `compact` leaves out the notes card (for narrow spots). */
import { BRAND } from "@/lib/brand";
export function TeamsDemo({ compact }: { compact?: boolean }) {
  return (
    <figure style={{ margin: 0 }}>
      <div className="site-demo" role="img" aria-label={`Example: ${BRAND.name} answering a question with sources, posting meeting notes and a reminder in a Microsoft Teams group chat (made-up data)`}>
        <div className="site-demo-bar" aria-hidden="true">
          <span className="dots"><i /><i /><i /></span>
          <b>Contoso · Payments Platform</b>
          <span className="faint">Group chat</span>
        </div>
        <div className="site-demo-body" aria-hidden="true">
          <div className="site-msg">
            <span className="site-avatar">PR</span>
            <div>
              <div className="who"><b>Priya Raman</b>9:12 AM</div>
              <div className="site-bubble"><span className="mention">@{BRAND.name}</span> when is the wave 2 cutover and how many stores are in it?</div>
            </div>
          </div>
          <div className="site-msg">
            <span className="site-avatar sk">S</span>
            <div>
              <div className="who"><b>{BRAND.name}</b>9:12 AM</div>
              <div className="site-tcard">
                <p>Wave 2 cuts over on <b>Saturday, November 14</b>, starting 10 PM. It covers <b>38 stores</b> in the Northeast region; the rollback owner is Dan Ortiz.</p>
                <div className="src"><span>Cutover plan v3.docx</span><span>Weekly sync, Oct 13</span></div>
              </div>
            </div>
          </div>
          {!compact && (
            <div className="site-msg">
              <span className="site-avatar sk">S</span>
              <div>
                <div className="who"><b>{BRAND.name}</b>Meeting notes</div>
                <div className="site-tcard notes">
                  <h4>Weekly sync: notes</h4>
                  <p className="muted">Store pilot went well; card-reader firmware is the last blocker.</p>
                  <ul>
                    <li><b>Decided:</b> freeze the price file on Nov 10</li>
                    <li><b>Action:</b> Dan to confirm firmware with the vendor, due Nov 6</li>
                  </ul>
                  <div className="site-acts"><span>Open in {BRAND.name}</span></div>
                </div>
              </div>
            </div>
          )}
          <div className="site-msg">
            <span className="site-avatar sk">S</span>
            <div>
              <div className="who"><b>{BRAND.name}</b>Reminder</div>
              <div className="site-tcard remind">
                <h4>2 things need an owner</h4>
                <ul>
                  <li>Store training schedule: overdue since Oct 30</li>
                  <li>Decide the backup payment route: open 9 days</li>
                </ul>
                <div className="site-acts"><span>Assign</span><span>Mark done</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="site-demo-caption">Example with made-up data. {BRAND.name} posts these cards in your Teams chats.</figcaption>
    </figure>
  );
}
