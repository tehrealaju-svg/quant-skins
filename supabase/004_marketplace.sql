-- Quant Skins marketplace: any signed-in user can list their own CS2 skins at their own price.
-- The buyer pays the shop (escrow). The seller sends the skin straight to the buyer on Steam.
-- 8 days after delivery (Steam's trade-reversal window has passed) the shop pays the seller.
-- If the seller reverses the trade, the buyer is refunded and the seller is banned.

alter table public.skin_items   add column if not exists qnt_price numeric check (qnt_price is null or qnt_price > 0);  -- from 003, so 004 runs alone
alter table public.skin_items   add column if not exists tradable_after timestamptz;  -- from 002
alter table public.skin_items   add column if not exists seller_id uuid references public.skin_profiles on delete cascade;
alter table public.skin_profiles add column if not exists banned_until timestamptz;
alter table public.skin_profiles add column if not exists ban_reason text not null default '';
alter table public.skin_orders  add column if not exists seller_id uuid references public.skin_profiles on delete set null;
alter table public.skin_orders  add column if not exists sent_at timestamptz;          -- seller says the Steam trade is sent
alter table public.skin_orders  add column if not exists received_at timestamptz;      -- buyer confirms (or admin)
alter table public.skin_orders  add column if not exists payout_after timestamptz;     -- received + 8 days
alter table public.skin_orders  add column if not exists reported_reversed boolean not null default false;

alter table public.skin_orders drop constraint if exists skin_orders_status_check;
alter table public.skin_orders add constraint skin_orders_status_check check (status in
  ('awaiting_payment', 'paid', 'awaiting_skins', 'trade_sent', 'in_escrow', 'reversed', 'refunded', 'done', 'cancelled'));

create or replace function public.skin_is_banned(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select banned_until > now() from skin_profiles where id = p), false)
$$;

-- Market view: who sells it.
drop view if exists public.skin_market;
create view public.skin_market with (security_invoker = on) as
  with s as (select usd_per_qnt from public.skin_settings where id = 1),
  v as (select i.*, public.skin_price_usd(i.item, i.wear, i.float_value, i.usd_override) as value_usd from public.skin_items i)
  select v.id, v.name, v.item, v.wear, v.float_value, v.paint_seed, v.image, v.rarity_color, v.inspect_link, v.status, v.listed_at,
         v.tradable_after, v.seller_id,
         coalesce((select p.name from public.skin_profiles p where p.id = v.seller_id), '') as seller_name,
         round(coalesce(v.qnt_price * s.usd_per_qnt, v.value_usd), 2) as usd,
         round(coalesce(v.qnt_price, v.value_usd / s.usd_per_qnt), 4) as qnt,
         round(v.value_usd, 2) as value_usd,
         round(v.value_usd / s.usd_per_qnt, 4) as value_qnt,
         case when v.value_usd > 0 and v.qnt_price is not null
              then round((1 - (v.qnt_price * s.usd_per_qnt) / v.value_usd) * 100, 1) end as deal_pct
  from v, s;

-- Sellers manage their own listings (price, hide); the shop's listings stay admin-only.
drop policy if exists "sellers list skins" on public.skin_items;
create policy "sellers list skins" on public.skin_items for insert to authenticated
  with check (seller_id = auth.uid() and qnt_price is not null and status = 'available' and not public.skin_is_banned(auth.uid()));
drop policy if exists "sellers edit listings" on public.skin_items;
create policy "sellers edit listings" on public.skin_items for update to authenticated
  using (seller_id = auth.uid() and status in ('available', 'hidden'))
  with check (seller_id = auth.uid() and status in ('available', 'hidden') and qnt_price is not null);
drop policy if exists "sellers delete listings" on public.skin_items;
create policy "sellers delete listings" on public.skin_items for delete to authenticated
  using (seller_id = auth.uid() and status in ('available', 'hidden'));
drop policy if exists "read listed items" on public.skin_items;
create policy "read listed items" on public.skin_items for select
  using (status in ('available', 'reserved') or seller_id = auth.uid() or public.skin_is_admin());

-- Sellers see orders for their skins; buyers' trade URLs are shown to the seller of a paid order only.
drop policy if exists "read own orders" on public.skin_orders;
create policy "read own orders" on public.skin_orders for select to authenticated
  using (user_id = auth.uid() or seller_id = auth.uid() or public.skin_is_admin());

create or replace function public.skin_buyer_trade_url(p_order bigint) returns text
language sql stable security definer set search_path = public as $$
  select b.trade_url from skin_orders o join skin_profiles b on b.id = o.user_id
  where o.id = p_order and (o.seller_id = auth.uid() or public.skin_is_admin()) and o.status in ('paid', 'trade_sent', 'in_escrow')
$$;
grant execute on function public.skin_buyer_trade_url(bigint) to authenticated;

-- Placing an order: shop items or ONE user's items; user-listed items can only be bought (no swap).
create or replace function public.skin_place_order(p_shop_ids bigint[], p_user_items jsonb)
returns public.skin_orders
language plpgsql security definer set search_path = public as $$
declare
  me skin_profiles; s skin_settings; shop jsonb := '[]'; mine jsonb := '[]'; owe numeric := 0;
  it record; u jsonb; usd numeric; o skin_orders; k text; sellers uuid[];
begin
  select * into me from skin_profiles where id = auth.uid();
  if me is null then raise exception 'Sign in with Steam first'; end if;
  if me.banned_until > now() then raise exception 'Your account is banned: %', me.ban_reason; end if;
  if me.trade_url = '' then raise exception 'Add your Steam trade URL first'; end if;
  select * into s from skin_settings where id = 1;
  if coalesce(array_length(p_shop_ids, 1), 0) = 0 and jsonb_array_length(coalesce(p_user_items, '[]')) = 0 then raise exception 'Pick at least one skin'; end if;
  if coalesce(array_length(p_shop_ids, 1), 0) > 20 or jsonb_array_length(coalesce(p_user_items, '[]')) > 20 then raise exception 'At most 20 skins per side'; end if;
  perform public.skin_expire_orders();
  perform 1 from skin_items where id = any(p_shop_ids) for update;
  select array_agg(distinct coalesce(seller_id, '00000000-0000-0000-0000-000000000000'::uuid)) into sellers from skin_items where id = any(p_shop_ids);
  if coalesce(array_length(sellers, 1), 0) > 1 then raise exception 'Buy from one seller per order'; end if;
  if sellers is not null and sellers[1] = me.id then raise exception 'That''s your own listing'; end if;
  if sellers is not null and sellers[1] <> '00000000-0000-0000-0000-000000000000'::uuid and jsonb_array_length(coalesce(p_user_items, '[]')) > 0 then
    raise exception 'Skins listed by other users can be bought with QNT, not swapped';
  end if;
  for it in select m.* from skin_market m where m.id = any(p_shop_ids) loop
    if it.status <> 'available' then raise exception '% is no longer available', it.name; end if;
    if it.qnt is null then raise exception '% has no price yet', it.name; end if;
    shop := shop || jsonb_build_object('id', it.id, 'name', it.name, 'float', it.float_value, 'qnt', it.qnt, 'image', it.image);
    owe := owe + it.qnt;
  end loop;
  if jsonb_array_length(shop) <> coalesce(array_length(p_shop_ids, 1), 0) then raise exception 'Some skins are no longer listed'; end if;
  for u in select * from jsonb_array_elements(coalesce(p_user_items, '[]')) loop
    usd := public.skin_price_usd(u->>'item', coalesce(u->>'wear', ''), nullif(u->>'float', '')::numeric, null);
    if usd is null then raise exception '% has no price yet', u->>'name'; end if;
    mine := mine || jsonb_build_object('asset_id', u->>'asset_id', 'name', u->>'name', 'float', u->'float',
                                       'image', coalesce(u->>'image', ''), 'qnt', round(usd * s.sell_ratio / s.usd_per_qnt, 4));
    owe := owe - round(usd * s.sell_ratio / s.usd_per_qnt, 4);
  end loop;
  k := case when jsonb_array_length(mine) = 0 then 'buy' when jsonb_array_length(shop) = 0 then 'sell' else 'swap' end;
  update skin_items set status = 'reserved' where id = any(p_shop_ids);
  insert into skin_orders (user_id, kind, shop_items, user_items, qnt_due, status, seller_id)
  values (me.id, k, shop, mine, round(owe, 4), case when owe > 0 then 'awaiting_payment' else 'awaiting_skins' end,
          nullif(sellers[1], '00000000-0000-0000-0000-000000000000'::uuid))
  returning * into o;
  return o;
end $$;

-- Seller: "I sent the Steam trade". Buyer: "I received it" (starts the 8-day hold) or
-- "the seller reversed it" (admin then refunds + bans).
create or replace function public.skin_order_step(p_id bigint, p_step text) returns void
language plpgsql security definer set search_path = public as $$
declare o skin_orders;
begin
  select * into o from skin_orders where id = p_id for update;
  if o is null then raise exception 'Order not found'; end if;
  if p_step = 'sent' then
    if o.seller_id <> auth.uid() then raise exception 'Only the seller can do that'; end if;
    if o.status <> 'paid' then raise exception 'Not waiting for the trade'; end if;
    update skin_orders set status = 'trade_sent', sent_at = now(), updated_at = now() where id = p_id;
  elsif p_step = 'received' then
    if o.user_id <> auth.uid() and not public.skin_is_admin() then raise exception 'Only the buyer can do that'; end if;
    if o.status not in ('paid', 'trade_sent') then raise exception 'Nothing to confirm'; end if;
    update skin_orders set status = case when o.seller_id is null then 'done' else 'in_escrow' end, received_at = now(),
      payout_after = case when o.seller_id is null then null else now() + interval '8 days' end, updated_at = now() where id = p_id;
    update skin_items set status = 'sold' where id in (select (x->>'id')::bigint from jsonb_array_elements(o.shop_items) x);
  elsif p_step = 'reversed' then
    if o.user_id <> auth.uid() then raise exception 'Only the buyer can report this'; end if;
    if o.status <> 'in_escrow' then raise exception 'Only during the 8-day hold'; end if;
    update skin_orders set reported_reversed = true, status = 'reversed', updated_at = now() where id = p_id;
  else raise exception 'Unknown step';
  end if;
end $$;
grant execute on function public.skin_order_step(bigint, text) to authenticated;

-- Admin: ban someone (seconds null = forever).
create or replace function public.skin_ban(p_user uuid, p_days int, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.skin_is_admin() then raise exception 'Admins only'; end if;
  update skin_profiles set banned_until = case when p_days is null then 'infinity'::timestamptz else now() + make_interval(days => p_days) end,
         ban_reason = coalesce(p_reason, '') where id = p_user;
  update skin_items set status = 'hidden' where seller_id = p_user and status = 'available';
end $$;
grant execute on function public.skin_ban(uuid, int, text) to authenticated;

notify pgrst, 'reload schema';

-- Users can't lift their own ban.
create or replace function public.skin_profiles_guard() returns trigger language plpgsql as $$
begin
  if not public.skin_is_admin() or auth.uid() = old.id then
    new.is_admin := old.is_admin; new.steam_id := old.steam_id; new.id := old.id;
    new.banned_until := old.banned_until; new.ban_reason := old.ban_reason;
  end if;
  return new;
end $$;
