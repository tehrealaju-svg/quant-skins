// Refreshes skin prices from csgoskins.gg (one page per skin lists every wear with its float
// range and price). Body: { items: ["AK-47 | Redline", ...] } or empty for every listed skin.
// Admin only (or the service key, for a scheduled refresh).
import { admin, caller, cors, fetchPrices, json } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const isService = (req.headers.get("Authorization") || "") === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;
  if (!isService) {
    const me = await caller(req);
    if (!me?.is_admin) return json({ error: "Admins only" }, 403);
  }
  const db = admin();
  let { items } = await req.json().catch(() => ({ items: [] }));
  if (!items?.length) {
    const { data } = await db.from("skin_items").select("item").neq("status", "sold");
    items = [...new Set((data || []).map((d: any) => d.item))];
  }
  const results: Record<string, unknown> = {};
  for (const item of items.slice(0, 60)) {
    try {
      if (/^StatTrak/.test(item)) { results[item] = "StatTrak prices aren't automatic yet: set a price override in admin"; continue; }
      const rows = await fetchPrices(db, item);
      results[item] = rows.length ? rows : "no prices found";
      await new Promise((r) => setTimeout(r, 400)); // be polite to csgoskins.gg
    } catch (e) { results[item] = (e as Error).message; }
  }
  return json({ results });
});
