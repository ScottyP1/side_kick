"use client";

/**
 * The public support form on /support (no sign-in): name, email, subject, category, description and an optional
 * phone number, sent to POST /api/support/public, which opens a ticket for the Sidekick team (no organization).
 * A hidden "website" field is a honeypot for bots; the server also limits requests per network address.
 * Signed-in customers get a better form in the portal (Help & support), with their account details filled in.
 */
import { useState, type FormEvent } from "react";
import { api, Spinner } from "./ui";

export function SupportForm() {
  const [f, setF] = useState({ name: "", email: "", subject: "", category: "question", description: "", phone: "", website: "" });
  const [state, setState] = useState<{ s: "idle" | "busy" | "done" | "failed"; msg?: string }>({ s: "idle" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ s: "busy" });
    try {
      const r = await api<{ ref?: string }>("/api/support/public", { method: "POST", json: { ...f, page: "/support" } });
      setState({ s: "done", msg: r.ref ? `Thanks, we've got it. Your reference is ${r.ref}. We'll reply by email, usually within two working days.` : "Thanks, we've got it." });
    } catch (x) {
      setState({ s: "failed", msg: x instanceof Error ? x.message : "Couldn't send it. Try again." });
    }
  };
  if (state.s === "done") return <div className="callout info" role="status"><span>{state.msg}</span></div>;
  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="field"><label htmlFor="s-name">Your name</label><input id="s-name" className="input" required maxLength={120} autoComplete="name" value={f.name} onChange={set("name")} /></div>
      <div className="field"><label htmlFor="s-email">Email</label><input id="s-email" className="input" type="email" required maxLength={200} autoComplete="email" value={f.email} onChange={set("email")} /></div>
      <div className="field"><label htmlFor="s-subject">Subject</label><input id="s-subject" className="input" required minLength={4} maxLength={160} value={f.subject} onChange={set("subject")} /></div>
      <div className="field"><label htmlFor="s-cat">Category</label><select id="s-cat" className="input" value={f.category} onChange={set("category")}><option value="question">Question</option><option value="bug">Something&apos;s broken</option><option value="billing">Billing</option><option value="access">Sign-in or access</option><option value="feature">Feature request</option></select></div>
      <div className="field"><label htmlFor="s-desc">How can we help?</label><textarea id="s-desc" className="input" required minLength={10} maxLength={8000} rows={5} value={f.description} onChange={set("description")} /><span className="hint">If you saw an error with a reference code (like K7Q2-9XM4), include it. Never send passwords or payment details.</span></div>
      <div className="field"><label htmlFor="s-phone">Phone (optional)</label><input id="s-phone" className="input" type="tel" maxLength={40} autoComplete="tel" value={f.phone} onChange={set("phone")} /></div>
      <label className="hp" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} /></label>
      {state.s === "failed" && <p className="err" style={{ margin: 0 }}>{state.msg}</p>}
      <div><button className="btn primary" type="submit" disabled={state.s === "busy"}>{state.s === "busy" ? <><Spinner /> Sending</> : "Send"}</button></div>
    </form>
  );
}
