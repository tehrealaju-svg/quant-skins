// The signed-in user's tradable CS2 skins with the price the shop pays for each (QNT).
// Admin: ?bot=1 returns the shop account's inventory, marking skins already listed.
import { admin, caller, cors, fetchPrices, json, steamInventory } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await caller(req);
    if (!me) return json({ error: "Sign in first" }, 401);
    const db = admin();
    const { data: s } = await db.from("skin_settings").select("*").single();
    const bot = new URL(req.url).searchParams.get("bot") === "1";
    if (bot && !me.is_admin) return json({ error: "Admins only" }, 403);
    const steamId = bot ? s.bot_steam_id : me.steam_id;
    if (!steamId) return json({ error: "Set the shop Steam ID in admin settings first" }, 400);
    const items = await steamInventory(steamId);

    const names = [...new Set(items.map((i) => i.item))];
    let { data: prices } = await db.from("skin_prices").select("*").in("item", names.length ? names : [""]);
    // Price skins we haven't seen yet (a few per request; the rest fill in on the next load).
    const known = new Set((prices || []).map((p: any) => p.item));
    const todo = names.filter((n) => !known.has(n) && !/^StatTrak/.test(n)).slice(0, 8);
    if (todo.length) {
      await Promise.all(todo.map((n) => fetchPrices(db, n).catch(() => [])));
      ({ data: prices } = await db.from("skin_prices").select("*").in("item", names));
    }
    const pmap = new Map((prices || []).map((p: any) => [`${p.item}|${p.wear}`, p]));
    let listed = new Set<string>();
    if (bot) {
      const { data: l } = await db.from("skin_items").select("asset_id").in("asset_id", items.map((i) => i.asset_id));
      listed = new Set((l || []).map((x: any) => x.asset_id));
    }
    const out = items.map((i) => {
      const p: any = pmap.get(`${i.item}|${i.wear}`);
      const usd = p ? Number(p.usd) : null;
      return { ...i, usd, qnt: usd === null ? null : +((usd * Number(s.sell_ratio)) / Number(s.usd_per_qnt)).toFixed(4), listed: listed.has(i.asset_id) };
    });
    return json({ items: out, missing_prices: names.filter((n) => !out.some((o) => o.item === n && o.usd !== null)) });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
