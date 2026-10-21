/**
 * Small pictures of the screens on the How it works page (/how-it-works), one per step: the sign-up form,
 * Microsoft's approval page, the Teams app, a group card with its Team Lead, a chat waiting for a group, and
 * a Teams answer card. Plain HTML and CSS (components/public-site.css, `site-mock*`), no images or scripts,
 * made-up names (Contoso, Northwind). Decorative: the page hides them from screen readers, because the step
 * text says the same thing.
 */

/** A small window frame with a title bar around a mock screen. */
import { BRAND } from "@/lib/brand";
function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="site-mock">
      <div className="site-mock-bar"><span className="dots"><i /><i /><i /></span><span>{title}</span></div>
      <div className="site-mock-body">{children}</div>
    </div>
  );
}

/** A fake form field with its label and value. */
const Field = ({ label, value }: { label: string; value: string }) => (
  <div className="site-mock-field"><small>{label}</small><span>{value}</span></div>
);

/** Step 1: the sign-up form. */
export function SignupMock() {
  return (
    <Frame title={`${BRAND.name} · Sign up`}>
      <Field label="Organization" value="Contoso Consulting" />
      <Field label="Work email" value="ana@contoso.example" />
      <div className="site-mock-plans"><span>Starter</span><span className="on">Team</span><span>Business</span></div>
      <span className="site-mock-btn">Start free trial</span>
    </Frame>
  );
}

/** Step 2: Microsoft's one-time approval. */
export function ApproveMock() {
  return (
    <Frame title="Microsoft · Permissions requested">
      <b className="site-mock-title">{BRAND.name} wants to:</b>
      <ul className="site-mock-checks">
        <li>Sign you in and read your profile</li>
        <li>Read people&apos;s names and work emails</li>
        <li>Remove itself from a chat</li>
      </ul>
      <div className="site-mock-row"><span className="site-mock-btn ghost">Cancel</span><span className="site-mock-btn">Accept</span></div>
    </Frame>
  );
}

/** Step 3: the Sidekick app in Teams. */
export function InstallMock() {
  return (
    <Frame title="Teams · Apps">
      <div className="site-mock-app">
        <span className="site-avatar sk">S</span>
        <div><b>{BRAND.name}</b><small>AI teammate for client teams</small></div>
      </div>
      <div className="site-mock-row"><span className="site-mock-chip">Chats</span><span className="site-mock-chip">Channels</span></div>
      <span className="site-mock-btn">Add</span>
    </Frame>
  );
}

/** Step 4: a group card with its client and Team Lead. */
export function GroupMock() {
  return (
    <Frame title={`${BRAND.name} · Groups`}>
      <div className="site-mock-group">
        <div className="site-mock-row" style={{ justifyContent: "space-between" }}><b>Payments Platform</b><span className="pill good">On track</span></div>
        <small>Client: Northwind Bank · NWB-204</small>
        <div className="site-mock-lead"><span className="site-avatar">DO</span><span><b>Dan Ortiz</b><small>Team Lead</small></span></div>
        <div className="site-mock-row"><span className="site-mock-chip">6 people</span><span className="site-mock-chip">2 chats</span><span className="site-mock-chip">41 docs</span></div>
      </div>
    </Frame>
  );
}

/** Step 5: a Teams chat waiting to be assigned to a group. */
export function WaitingChatMock() {
  return (
    <Frame title={`${BRAND.name} · Chats waiting for a group`}>
      <div className="site-mock-group">
        <div className="site-mock-row" style={{ justifyContent: "space-between" }}><b>Wave 2 cutover</b><span className="pill warn">Waiting</span></div>
        <small>Group chat · added by Dan Ortiz · 9 people</small>
        <div className="site-mock-select"><span>Payments Platform</span><span aria-hidden="true">▾</span></div>
        <span className="site-mock-btn">Assign to group</span>
      </div>
    </Frame>
  );
}

/** Step 6: a question and Sidekick's answer card in Teams. */
export function AnswerMock() {
  return (
    <Frame title="Teams · Wave 2 cutover">
      <div className="site-bubble"><span className="mention">@{BRAND.name}</span> who owns the rollback?</div>
      <div className="site-tcard">
        <p><b>Dan Ortiz</b> owns the rollback for wave 2, with Priya as backup.</p>
        <div className="src"><span>Cutover plan v3.docx</span></div>
      </div>
    </Frame>
  );
}
