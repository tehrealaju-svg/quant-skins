-- Quant Skins: CS2 skin trading priced in QNT. Paste into the SQL editor of the Quant project.
-- Users sign in with Steam (edge function steam-login). Everything a user can change is guarded
-- by row-level security; orders and listings are changed by the admin (Ambrose) or edge functions.

-- ---------------------------------------------------------------- settings (single row)
create table if not exists public.skin_settings (
  id              int primary key default 1 check (id = 1),
  usd_per_qnt     numeric not null default 1.50,      -- 1 QNT = $1.50
  float_premium   numeric not null default 0.30,      -- best float in a wear band costs up to +30%
  sell_ratio      numeric not null default 0.90,      -- shop pays 90% of the price when buying from users
  shop_address    text not null default '',           -- QNT address buyers pay
  bot_trade_url   text not null default '',           -- spare Steam account trade URL
  bot_steam_id    text not null default '',
  updated_at      timestamptz not null default now()
);
insert into public.skin_settings (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------- people
create table if not exists public.skin_profiles (
  id          uuid primary key references auth.users on delete cascade,
  steam_id    text unique not null,
  name        text not null default '',
  avatar      text not null default '',
  trade_url   text not null default '' check (trade_url = '' or trade_url ~ '^https://steamcommunity\.com/tradeoffer/new/\?partner=\d+&token=[A-Za-z0-9_-]+$'),
  qnt_address text not null default '',
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create or replace function public.skin_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from skin_profiles where id = auth.uid()), false)
$$;

-- ---------------------------------------------------------------- prices (from csgoskins.gg)
create table if not exists public.skin_prices (
  item        text not null,           -- base name, e.g. 'AK-47 | Redline' or 'StatTrak™ AK-47 | Redline'
  wear        text not null,           -- FN MW FT WW BS, or '' for items without wear
  wear_min    numeric,
  wear_max    numeric,
  usd         numeric not null,
  fetched_at  timestamptz not null default now(),
  primary key (item, wear)
);

-- ---------------------------------------------------------------- shop inventory (the bot account)
create table if not exists public.skin_items (
  id            bigint generated always as identity primary key,
  asset_id      text unique,                 -- Steam asset id on the bot account
  name          text not null,               -- market hash name, e.g. 'AK-47 | Redline (Field-Tested)'
  item          text not null,               -- base name for pricing
  wear          text not null default '',
  float_value   numeric check (float_value is null or (float_value >= 0 and float_value <= 1)),
  paint_seed    int,
  image         text not null default '',
  rarity_color  text not null default '',
  inspect_link  text not null default '',
  usd_override  numeric,                     -- admin can pin a price
  status        text not null default 'available' check (status in ('available', 'reserved', 'sold', 'hidden')),
  listed_at     timestamptz not null default now()
);
create index if not exists skin_items_status on public.skin_items (status);

-- ---------------------------------------------------------------- orders
-- kind: buy (user pays QNT, gets shop items), sell (user gives skins, gets QNT),
-- swap (both; qnt_due > 0 means user pays, < 0 means the shop pays the difference).
create table if not exists public.skin_orders (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references public.skin_profiles on delete cascade,
  kind          text not null check (kind in ('buy', 'sell', 'swap')),
  shop_items    jsonb not null default '[]',   -- [{id, name, float, qnt}]
  user_items    jsonb not null default '[]',   -- [{asset_id, name, float, qnt, image}]
  qnt_due       numeric not null,              -- QNT the user owes (negative: the shop owes the user)
  pay_txid      text not null default '',
  payout_txid   text not null default '',
  status        text not null default 'awaiting_payment'
                check (status in ('awaiting_payment', 'paid', 'awaiting_skins', 'trade_sent', 'done', 'cancelled')),
  note          text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists skin_orders_user on public.skin_orders (user_id);
create index if not exists skin_orders_status on public.skin_orders (status);

-- ---------------------------------------------------------------- price of one item in QNT
-- Within a wear band the price rises smoothly as float falls toward the better edge (up to
-- float_premium extra), then jumps to the next band's price.
create or replace function public.skin_price_usd(p_item text, p_wear text, p_float numeric, p_override numeric)
returns numeric language sql stable set search_path = public as $$
  select case
    when p_override is not null then p_override
    else (
      select pr.usd * (1 + s.float_premium * case
        when p_float is null or pr.wear_min is null or pr.wear_max <= pr.wear_min then 0
        else power(greatest(0, least(1, (pr.wear_max - p_float) / (pr.wear_max - pr.wear_min))), 2)
      end)
      from skin_prices pr, skin_settings s
      where pr.item = p_item and pr.wear = p_wear
    )
  end
$$;

create or replace view public.skin_market with (security_invoker = on) as
  select i.id, i.name, i.item, i.wear, i.float_value, i.paint_seed, i.image, i.rarity_color, i.inspect_link, i.status, i.listed_at,
         round(public.skin_price_usd(i.item, i.wear, i.float_value, i.usd_override), 2) as usd,
         round(public.skin_price_usd(i.item, i.wear, i.float_value, i.usd_override) / (select usd_per_qnt from skin_settings), 4) as qnt
  from public.skin_items i;

-- ---------------------------------------------------------------- row-level security
alter table public.skin_settings enable row level security;
alter table public.skin_profiles enable row level security;
alter table public.skin_prices   enable row level security;
alter table public.skin_items    enable row level security;
alter table public.skin_orders   enable row level security;

drop policy if exists "read settings" on public.skin_settings;
create policy "read settings" on public.skin_settings for select using (true);
drop policy if exists "admin edits settings" on public.skin_settings;
create policy "admin edits settings" on public.skin_settings for update to authenticated using (public.skin_is_admin());

drop policy if exists "read own profile" on public.skin_profiles;
create policy "read own profile" on public.skin_profiles for select to authenticated using (id = auth.uid() or public.skin_is_admin());
-- Users may only change their trade URL and QNT address (is_admin / steam_id are locked by the trigger below).
drop policy if exists "edit own profile" on public.skin_profiles;
create policy "edit own profile" on public.skin_profiles for update to authenticated using (id = auth.uid());
create or replace function public.skin_profiles_guard() returns trigger language plpgsql as $$
begin
  if not public.skin_is_admin() or auth.uid() = old.id then
    new.is_admin := old.is_admin; new.steam_id := old.steam_id; new.id := old.id;
  end if;
  return new;
end $$;
drop trigger if exists skin_profiles_guard on public.skin_profiles;
create trigger skin_profiles_guard before update on public.skin_profiles for each row execute function public.skin_profiles_guard();

drop policy if exists "read prices" on public.skin_prices;
create policy "read prices" on public.skin_prices for select using (true);
drop policy if exists "admin prices" on public.skin_prices;
create policy "admin prices" on public.skin_prices for all to authenticated using (public.skin_is_admin()) with check (public.skin_is_admin());

drop policy if exists "read listed items" on public.skin_items;
create policy "read listed items" on public.skin_items for select using (status in ('available', 'reserved') or public.skin_is_admin());
drop policy if exists "admin items" on public.skin_items;
create policy "admin items" on public.skin_items for all to authenticated using (public.skin_is_admin()) with check (public.skin_is_admin());

drop policy if exists "read own orders" on public.skin_orders;
create policy "read own orders" on public.skin_orders for select to authenticated using (user_id = auth.uid() or public.skin_is_admin());
drop policy if exists "admin orders" on public.skin_orders;
create policy "admin orders" on public.skin_orders for update to authenticated using (public.skin_is_admin());

-- ---------------------------------------------------------------- placing an order
-- Prices are computed here (never trusted from the browser). Shop items get reserved.
-- p_user_items: [{asset_id, name, item, wear, float, image}] from the user's Steam inventory.
create or replace function public.skin_place_order(p_shop_ids bigint[], p_user_items jsonb)
returns public.skin_orders
language plpgsql security definer set search_path = public as $$
declare
  me skin_profiles;
  s skin_settings;
  shop jsonb := '[]';
  mine jsonb := '[]';
  owe numeric := 0;
  it record;
  u jsonb;
  usd numeric;
  o skin_orders;
  k text;
begin
  select * into me from skin_profiles where id = auth.uid();
  if me is null then raise exception 'Sign in with Steam first'; end if;
  if me.trade_url = '' then raise exception 'Add your Steam trade URL first'; end if;
  select * into s from skin_settings where id = 1;
  if coalesce(array_length(p_shop_ids, 1), 0) = 0 and jsonb_array_length(coalesce(p_user_items, '[]')) = 0 then
    raise exception 'Pick at least one skin';
  end if;
  if coalesce(array_length(p_shop_ids, 1), 0) > 20 or jsonb_array_length(coalesce(p_user_items, '[]')) > 20 then
    raise exception 'At most 20 skins per side';
  end if;

  perform public.skin_expire_orders();
  perform 1 from skin_items where id = any(p_shop_ids) for update;
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
  insert into skin_orders (user_id, kind, shop_items, user_items, qnt_due, status)
  values (me.id, k, shop, mine, round(owe, 4), case when owe > 0 then 'awaiting_payment' else 'awaiting_skins' end)
  returning * into o;
  return o;
end $$;
grant execute on function public.skin_place_order(bigint[], jsonb) to authenticated;

-- User cancels an unpaid order: shop items go back on sale.
create or replace function public.skin_cancel_order(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare o skin_orders;
begin
  select * into o from skin_orders where id = p_id and (user_id = auth.uid() or public.skin_is_admin()) for update;
  if o is null then raise exception 'Order not found'; end if;
  if o.status not in ('awaiting_payment', 'awaiting_skins') and not public.skin_is_admin() then raise exception 'This order can no longer be cancelled'; end if;
  update skin_items set status = 'available' where id in (select (x->>'id')::bigint from jsonb_array_elements(o.shop_items) x) and status = 'reserved';
  update skin_orders set status = 'cancelled', updated_at = now() where id = p_id;
end $$;
grant execute on function public.skin_cancel_order(bigint) to authenticated;

-- Unpaid orders release their skins after 30 minutes.
create or replace function public.skin_expire_orders() returns void
language sql security definer set search_path = public as $$
  update skin_items set status = 'available'
   where status = 'reserved' and id in (
     select (x->>'id')::bigint from skin_orders o, jsonb_array_elements(o.shop_items) x
      where o.status = 'awaiting_payment' and o.created_at < now() - interval '30 minutes');
  update skin_orders set status = 'cancelled', note = 'Not paid within 30 minutes', updated_at = now()
   where status = 'awaiting_payment' and created_at < now() - interval '30 minutes';
$$;

-- Live updates for the admin page and order pages.
do $$ begin
  alter publication supabase_realtime add table public.skin_orders;
exception when duplicate_object then null; end $$;
