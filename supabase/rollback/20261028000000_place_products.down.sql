-- Revoca di 20261028000000_place_products.sql: tornano le funzioni delle migrazioni 24–27 (copiate qui sotto) e
-- spariscono prodotto e diritto «luogo». Non cancella mai dati commerciali: se esistono prodotti o diritti «luogo»
-- (o ordini che li citano) si ferma prima di cambiare qualcosa. I file place-<luogo> nel bucket «premium», se ci
-- sono, restano e nessuno li legge più (la pulizia della pubblicazione li toglie).
do $$ begin
  if exists (select 1 from products where kind = 'place') or exists (select 1 from entitlements where scope = 'place') then
    raise exception 'REVOCA LUOGHI interrotta, nulla è stato modificato: esistono prodotti o diritti «luogo» (ritirarli e toglierli con una decisione esplicita)';
  end if;
end $$;

drop function if exists studio_places_on_sale(text, integer);
drop trigger if exists products_place_guard_trg on products;
drop function if exists products_place_guard();
drop index if exists products_one_place;
drop index if exists entitlements_place_idx;

-- da 20261024000000_entitlements.sql
create or replace function grant_product(p_user uuid, p_product uuid, p_source text, p_purchase uuid default null, p_note text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v products;
  n integer;
begin
  if p_source not in ('purchase', 'grant', 'promo', 'partner') then raise exception 'origine non ammessa: %', p_source; end if;
  if p_source = 'purchase' then
    -- Blocca l'acquisto: due eventi dello stesso acquisto in parallelo passano uno alla volta.
    perform 1 from purchases
    where id = p_purchase and user_id = p_user and product_id = p_product and status = 'completed' for update;
    if not found then raise exception 'acquisto non valido per questo utente e prodotto'; end if;
    if exists (select 1 from entitlements where purchase_id = p_purchase) then return 0; end if;
  end if;
  select * into v from products where id = p_product;
  if v.id is null then raise exception 'prodotto inesistente'; end if;
  if v.status <> 'active' and p_source <> 'purchase' then raise exception 'prodotto non attivo'; end if;
  if v.kind = 'explore' then
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id, note)
    values (p_user, v.id, p_source, p_purchase, 'explore', v.pack_id, p_note)
    on conflict do nothing;
  elsif v.kind = 'route' then
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id, route_id, note)
    values (p_user, v.id, p_source, p_purchase, 'route', v.pack_id, v.route_id, p_note)
    on conflict do nothing;
  else
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id, route_id, note)
    select p_user, v.id, p_source, p_purchase, 'route', v.pack_id, pr.route_id, p_note
    from product_routes pr where pr.product_id = v.id
    on conflict do nothing;
  end if;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'il prodotto non sblocca nulla (pacchetto vuoto?)'; end if;
  return n;
end;
$$;

-- da 20261024000000_entitlements.sql
create or replace function entitlements_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.route_id is not null and not exists (select 1 from routes where id = new.route_id and pack_id = new.pack_id) then
    raise exception 'il percorso del diritto è di un''altra destinazione';
  end if;
  return new;
end;
$$;

-- da 20261025000000_catalog.sql
create or replace function catalog_problem(p_product uuid)
returns text language sql stable set search_path = public as $$
  select catalog_problem_of(p.kind, p.pack_id, p.route_id, p.id) from products p where p.id = p_product;
$$;

-- da 20261025000000_catalog.sql
create or replace function products_activation_guard()
returns trigger language plpgsql set search_path = public as $$
declare v_problem text;
begin
  if current_user <> 'authenticated' then return new; end if;
  if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active') then
    v_problem := catalog_problem_of(new.kind, new.pack_id, new.route_id, new.id);
    if v_problem is not null then raise exception 'non si attiva: %', v_problem; end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'retired' and new.status <> 'retired' then
    raise exception 'un prodotto ritirato resta ritirato: creane uno nuovo';
  end if;
  return new;
end;
$$;

-- da 20261025000000_catalog.sql
create or replace function studio_catalog(p_pack text)
returns jsonb language plpgsql stable set search_path = public as $$
declare k packs;
begin
  perform studio_require(is_platform_admin(), 'il catalogo lo gestisce l''amministratore della piattaforma');
  select * into k from packs where id = p_pack;
  if k.id is null then raise exception 'territorio non trovato: %', p_pack; end if;
  return jsonb_build_object(
    'isDestination', k.kind = 'destination',
    'explore', coalesce(k.config #>> '{access,explore}', 'free'),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'slug', r.slug, 'name', coalesce(r.labels #>> '{it,name}', r.labels #>> '{en,name}', r.slug),
               'premium', coalesce(k.config -> 'access' -> 'premiumRoutes' ? r.slug, false))
             order by r.slug)
      from routes r where r.pack_id = k.id), '[]'),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'slug', p.slug, 'kind', p.kind, 'labels', p.labels, 'status', p.status,
               'availability', p.availability, 'sortOrder', p.sort_order,
               'route', (select jsonb_build_object('id', r.id, 'slug', r.slug) from routes r where r.id = p.route_id),
               'routes', coalesce((select jsonb_agg(r.slug order by r.slug) from product_routes pr join routes r on r.id = pr.route_id
                                   where pr.product_id = p.id), '[]'),
               'published', (select jsonb_build_object('amount', pp.unit_amount, 'at', pp.published_at) from product_prices pp
                             where pp.product_id = p.id and pp.status = 'published'),
               'draft', (select jsonb_build_object('amount', pp.unit_amount) from product_prices pp
                         where pp.product_id = p.id and pp.status = 'draft'),
               'paidOrders', (select count(*) from purchases pu where pu.product_id = p.id and pu.status = 'completed'),
               'problem', catalog_problem(p.id))
             order by p.status = 'retired', p.sort_order, p.kind, p.slug)
      from products p where p.pack_id = k.id), '[]'),
    'drafts', (select count(*) from product_prices pp join products p on p.id = pp.product_id
               where p.pack_id = k.id and pp.status = 'draft'));
end;
$$;

-- da 20261025000000_catalog.sql
create or replace function public_catalog(p_pack text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'slug', p.slug, 'kind', p.kind, 'labels', p.labels,
           'route', (select r.slug from routes r where r.id = p.route_id),
           'routes', coalesce((select jsonb_agg(r.slug order by r.slug) from product_routes pr join routes r on r.id = pr.route_id
                               where pr.product_id = p.id), '[]'),
           'price', jsonb_build_object('amount', pp.unit_amount, 'currency', pp.currency),
           'available', p.availability = 'available')
         order by p.sort_order, p.kind, p.slug), '[]')
  from products p
  join product_prices pp on pp.product_id = p.id and pp.status = 'published' and pp.currency = 'EUR'
  where p.pack_id = p_pack and p.status = 'active' and p.availability <> 'hidden' and catalog_problem(p.id) is null;
$$;

-- da 20261026000000_orders.sql
create or replace function order_already_owned(p_user uuid, p_product uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from purchases where user_id = p_user and product_id = p_product
                 and status in ('completed', 'partially_refunded', 'disputed'))
      or (select case p.kind
            when 'explore' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                                        and e.scope = 'explore' and e.pack_id = p.pack_id)
            when 'route' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                                      and e.scope = 'route' and e.route_id = p.route_id)
            else not exists (select 1 from product_routes pr where pr.product_id = p.id and not exists (
                   select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                   and e.scope = 'route' and e.route_id = pr.route_id))
          end
          from products p where p.id = p_product);
$$;

-- da 20261026000000_orders.sql
create or replace function checkout_open(p_product uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  p products;
  v_price product_prices;
  v_id uuid := gen_random_uuid();
  v_snapshot jsonb;
  v_supersede jsonb;
begin
  perform studio_require(v_user is not null, 'accedi per acquistare');
  -- Due richieste dello stesso utente per lo stesso prodotto passano una alla volta.
  perform pg_advisory_xact_lock(hashtext('checkout:' || v_user::text || ':' || p_product::text));
  select * into p from products where id = p_product;
  if p.id is null or p.status <> 'active' or p.availability = 'hidden' then raise exception 'prodotto non in vendita'; end if;
  if p.availability = 'sold_out' then raise exception 'prodotto esaurito'; end if;
  if catalog_problem(p.id) is not null then raise exception 'prodotto non in vendita'; end if;
  if not exists (select 1 from destinations where pack_id = p.pack_id and status = 'published') then
    raise exception 'destinazione non ancora pubblicata';
  end if;
  select * into v_price from product_prices where product_id = p.id and status = 'published' and currency = 'EUR';
  if v_price.id is null then raise exception 'prodotto senza prezzo pubblicato'; end if;
  if order_already_owned(v_user, p.id) then raise exception 'hai già acquistato questo contenuto'; end if;

  select coalesce(jsonb_agg(stripe_checkout_session_id) filter (where stripe_checkout_session_id is not null), '[]')
  into v_supersede from purchases
  where user_id = v_user and product_id = p.id and status = 'pending' and provider = 'stripe';
  update purchases set status = 'canceled', note = 'sostituito da un nuovo checkout', updated_at = now()
  where user_id = v_user and product_id = p.id and status = 'pending' and provider = 'stripe';

  v_snapshot := jsonb_build_object(
    'kind', p.kind, 'slug', p.slug, 'pack', p.pack_id, 'labels', p.labels,
    'route', (select jsonb_build_object('id', r.id, 'slug', r.slug) from routes r where r.id = p.route_id),
    'routes', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'slug', r.slug) order by r.slug)
                        from product_routes pr join routes r on r.id = pr.route_id where pr.product_id = p.id), '[]'));
  insert into purchases (id, user_id, product_id, provider, provider_ref, status, unit_amount, currency, price_id, product_snapshot)
  values (v_id, v_user, p.id, 'stripe', v_id::text, 'pending', v_price.unit_amount, v_price.currency, v_price.id, v_snapshot);
  return jsonb_build_object('order', v_id, 'amount', v_price.unit_amount, 'currency', v_price.currency,
    'name', coalesce(p.labels #>> '{it,name}', p.slug), 'supersede', v_supersede);
end;
$$;

-- da 20261026000000_orders.sql
create or replace function grant_order(p_order uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare o purchases; s jsonb; n integer := 0; k integer;
begin
  select * into o from purchases where id = p_order for update;
  if o.id is null or o.status <> 'completed' or o.user_id is null or o.product_snapshot is null then return 0; end if;
  s := o.product_snapshot;
  if s ->> 'kind' = 'explore' then
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id)
    select o.user_id, o.product_id, 'purchase', o.id, 'explore', s ->> 'pack'
    where exists (select 1 from packs where id = s ->> 'pack')
    on conflict do nothing;
    get diagnostics n = row_count;
  else
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id, route_id)
    select o.user_id, o.product_id, 'purchase', o.id, 'route', s ->> 'pack', r.id
    from routes r
    where r.pack_id = s ->> 'pack'
      and r.id in (select (x ->> 'id')::uuid from jsonb_array_elements(
                     case when s ->> 'kind' = 'route' then jsonb_build_array(s -> 'route') else s -> 'routes' end) x)
    on conflict do nothing;
    get diagnostics k = row_count;
    n := k;
  end if;
  return n;
end;
$$;

-- da 20261027000000_premium_storage.sql
create or replace function premium_object_name_ok(p_name text)
returns boolean language sql immutable as $$
  select coalesce(p_name ~ ('^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}/'
                            '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
                            '(explore|route-[a-z0-9]+(-[a-z0-9]+)*)\.[0-9a-f]{16,64}\.json$'), false);
$$;

-- da 20261027000000_premium_storage.sql
create or replace function premium_object_readable(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_pack text;
  v_file text;
  v_route uuid;
begin
  if auth.uid() is null or not premium_object_name_ok(p_name) then return false; end if;
  v_pack := split_part(p_name, '/', 1);
  v_file := split_part(p_name, '/', 4);
  if v_file like 'explore.%' then
    return has_active_right('explore', v_pack, null);
  end if;
  select r.id into v_route from routes r
  where r.pack_id = v_pack and r.slug = substring(v_file from '^route-([a-z0-9-]+)\.[0-9a-f]+\.json$');
  return v_route is not null and has_active_right('route', v_pack, v_route);
end;
$$;

drop function if exists catalog_problem_place(text, uuid);
drop function if exists has_place_right(text, uuid);

alter table products drop constraint if exists products_place_only_for_place;
alter table products drop constraint products_kind_check;
alter table products add constraint products_kind_check check (kind in ('explore', 'route', 'bundle'));
alter table products drop column place_id;
alter table entitlements drop constraint if exists entitlements_place_target;
alter table entitlements drop constraint entitlements_scope_check;
alter table entitlements add constraint entitlements_scope_check check (scope in ('explore', 'route'));
alter table entitlements drop column place_id;
