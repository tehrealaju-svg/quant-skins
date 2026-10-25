-- Admin sets each listing's price in QNT; the market shows it next to the csgoskins.gg + float
-- value so buyers see the deal (% below market value).
alter table public.skin_items add column if not exists qnt_price numeric check (qnt_price is null or qnt_price > 0);

drop view if exists public.skin_market;
create view public.skin_market with (security_invoker = on) as
  with s as (select usd_per_qnt from public.skin_settings where id = 1),
  v as (
    select i.*, public.skin_price_usd(i.item, i.wear, i.float_value, i.usd_override) as value_usd
    from public.skin_items i
  )
  select v.id, v.name, v.item, v.wear, v.float_value, v.paint_seed, v.image, v.rarity_color, v.inspect_link, v.status, v.listed_at,
         v.tradable_after,
         round(coalesce(v.qnt_price * s.usd_per_qnt, v.value_usd), 2) as usd,             -- price in USD
         round(coalesce(v.qnt_price, v.value_usd / s.usd_per_qnt), 4) as qnt,              -- price in QNT
         round(v.value_usd, 2) as value_usd,                                               -- market value (float-adjusted)
         round(v.value_usd / s.usd_per_qnt, 4) as value_qnt,
         case when v.value_usd > 0 and v.qnt_price is not null
              then round((1 - (v.qnt_price * s.usd_per_qnt) / v.value_usd) * 100, 1) end as deal_pct  -- + = below market
  from v, s;

notify pgrst, 'reload schema';
