import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

// The signed-in user's profile (from the Authorization header), or null.
export async function caller(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
  if (!token) return null;
  const db = admin();
  const { data } = await db.auth.getUser(token);
  if (!data?.user) return null;
  const { data: p } = await db.from("skin_profiles").select("*").eq("id", data.user.id).single();
  return p;
}

// ---------------------------------------------------------------- csgoskins.gg prices
export function slug(item: string) {
  return item.replace(/^StatTrak™ /, "").replace(/^★ /, "").toLowerCase()
    .replace(/[™★|()'.]/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Each wear appears as: name, "0.15 – 0.38", "$23.94".
export function parsePrices(html: string) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").split("\n").map((s) => s.trim()).filter(Boolean);
  const out: { wear: string; min: number; max: number; usd: number }[] = [];
  for (let i = 0; i < text.length - 2; i++) {
    const w = WEAR[text[i]];
    if (!w || out.some((o) => o.wear === w)) continue;
    const range = text[i + 1].match(/^([\d.]+)\s*[–-]\s*([\d.]+)$/);
    const price = text[i + 2].match(/^\$([\d,]+(?:\.\d+)?)$/);
    if (range && price) out.push({ wear: w, min: +range[1], max: +range[2], usd: +price[1].replace(/,/g, "") });
  }
  return out;
}

// Fetches every wear's price for one skin and stores it. Returns the rows ([] if none).
export async function fetchPrices(db: SupabaseClient, item: string) {
  if (/^StatTrak/.test(item)) return [];
  const r = await fetch(`https://csgoskins.gg/items/${slug(item)}`, { headers: { "User-Agent": "Mozilla/5.0 QuantSkins price check" } });
  if (!r.ok) return [];
  const rows = parsePrices(await r.text());
  if (rows.length) {
    await db.from("skin_prices").upsert(rows.map((x) => ({ item, wear: x.wear, wear_min: x.min, wear_max: x.max, usd: x.usd, fetched_at: new Date().toISOString() })));
  }
  return rows;
}

// Parses one Steam inventory page into skins. Floats are not in the inventory: they come from
// the float bot (or admin entry); inspect links are kept for that.
const WEAR: Record<string, string> = {
  "Factory New": "FN", "Minimal Wear": "MW", "Field-Tested": "FT", "Well-Worn": "WW", "Battle-Scarred": "BS",
};
export async function steamInventory(steamId: string) {
  const r = await fetch(`https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=1000`, {
    headers: { "User-Agent": "Mozilla/5.0 QuantSkins" },
  });
  if (r.status === 403) throw new Error("Your Steam inventory is private. Set it to public in Steam privacy settings.");
  if (!r.ok) throw new Error(`Steam inventory unavailable (${r.status}); try again in a minute`);
  const j = await r.json();
  const desc = new Map<string, any>();
  for (const d of j.descriptions || []) desc.set(`${d.classid}_${d.instanceid}`, d);
  const out = [];
  for (const a of j.assets || []) {
    const d = desc.get(`${a.classid}_${a.instanceid}`);
    if (!d || !d.tradable || !d.marketable) continue;
    const name: string = d.market_hash_name;
    const m = name.match(/^(.*) \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/);
    const inspect = (d.actions?.[0]?.link || "").replace("%owner_steamid%", steamId).replace("%assetid%", a.assetid);
    out.push({
      asset_id: a.assetid, name, item: m ? m[1] : name, wear: m ? WEAR[m[2]] : "",
      image: `https://community.cloudflare.steamstatic.com/economy/image/${d.icon_url}/256fx256f`,
      rarity_color: "#" + (d.tags?.find((t: any) => t.category === "Rarity")?.color || "b0c3d9"),
      inspect_link: inspect, float: null as number | null,
    });
  }
  return out;
}
