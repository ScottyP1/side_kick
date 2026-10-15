import { handle } from "@/lib/api";
import { all } from "@/lib/db";
import { requireOwner } from "@/lib/owner";

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

export const GET = handle(async () => {
  await requireOwner();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const rows = all<{ feature: string; model: string; latency_ms: number; ok: number; input_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost_usd: number }>(
    "SELECT feature, model, latency_ms, ok, input_tokens, cache_read_tokens, cache_write_tokens, cost_usd FROM usage_events WHERE created_at >= ?",
    since,
  );
  const group = (key: "feature" | "model") =>
    [...new Set(rows.map((r) => r[key]))].map((k) => {
      const rs = rows.filter((r) => r[key] === k);
      const lat = rs.map((r) => r.latency_ms);
      const input = rs.reduce((s, r) => s + r.input_tokens + r.cache_read_tokens + r.cache_write_tokens, 0);
      return {
        name: k,
        calls: rs.length,
        errors: rs.filter((r) => !r.ok).length,
        p50: pct(lat, 50),
        p95: pct(lat, 95),
        cost: rs.reduce((s, r) => s + r.cost_usd, 0),
        cacheHit: input ? rs.reduce((s, r) => s + r.cache_read_tokens, 0) / input : 0,
      };
    });
  return {
    byFeature: group("feature"),
    byModel: group("model"),
    errors: all(
      `SELECT u.created_at, u.feature, u.model, u.latency_ms, u.error, o.name AS tenant FROM usage_events u LEFT JOIN orgs o ON o.id = u.org_id
        WHERE u.ok = 0 ORDER BY u.id DESC LIMIT 50`,
    ),
    processing: all(
      `SELECT o.name AS tenant,
         (SELECT COUNT(*) FROM documents d WHERE d.org_id = o.id AND d.status = 'Failed') AS failed_docs,
         (SELECT COUNT(*) FROM meetings m WHERE m.org_id = o.id AND m.status = 'Failed') AS failed_meetings,
         (SELECT COUNT(*) FROM questions q WHERE q.org_id = o.id AND q.found = 0) AS unanswered,
         (SELECT COUNT(*) FROM questions q WHERE q.org_id = o.id) AS questions
       FROM orgs o ORDER BY o.name`,
    ),
  };
});
