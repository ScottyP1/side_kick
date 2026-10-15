import { handle, readJson } from "@/lib/api";
import { audit, requireUser } from "@/lib/auth";
import { run } from "@/lib/db";

// Branding (logo + brand color). The logo is stored as a small data URL for step 1.
export const PUT = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const body = await readJson<{ logo?: string | null; accent?: string | null }>(req);
  const logo = typeof body.logo === "string" && body.logo.startsWith("data:image/") && body.logo.length < 700_000 ? body.logo : null;
  const accent = typeof body.accent === "string" && /^#[0-9a-f]{6}$/i.test(body.accent) ? body.accent : null;
  run("INSERT INTO settings (org_id, json) VALUES (?, ?) ON CONFLICT(org_id) DO UPDATE SET json = excluded.json", user.org_id, JSON.stringify({ logo, accent }));
  audit(user, "Updated branding", "Policy change");
  return { ok: true };
});
