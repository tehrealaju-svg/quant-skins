-- Skins that are still trade-protected / not yet tradable can be listed with an unlock time;
-- the market shows a countdown and orders for them are delivered once they unlock.
alter table public.skin_items add column if not exists tradable_after timestamptz;

create or replace view public.skin_market with (security_invoker = on) as
  select i.id, i.name, i.item, i.wear, i.float_value, i.paint_seed, i.image, i.rarity_color, i.inspect_link, i.status, i.listed_at,
         round(public.skin_price_usd(i.item, i.wear, i.float_value, i.usd_override), 2) as usd,
         round(public.skin_price_usd(i.item, i.wear, i.float_value, i.usd_override) / (select usd_per_qnt from skin_settings), 4) as qnt,
         i.tradable_after
  from public.skin_items i;
