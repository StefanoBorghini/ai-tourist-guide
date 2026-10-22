-- Acquisto di un singolo luogo (decisione del 2026-10-18): nuovo tipo di prodotto «place», diritto «place», file
-- privato del luogo nel bucket «premium». Prezzo deciso nello Studio, 0,50 € proposto (il minimo che Stripe accetta
-- in euro, e quello del catalogo). Chi compra poi l'esplorazione completa paga il prezzo pieno.
-- Nessuna tabella nuova: una colonna «luogo» su prodotti e diritti. Vedi docs/v0.3-platform/CONSEGNA-CONTENUTI.md.
--
-- Un luogo si vende solo se l'esplorazione della destinazione è a pagamento e il luogo non è tra quelli
-- introduttivi (che sono gratuiti). Il diritto su un luogo apre solo il file di quel luogo.

-- ---------------------------------------------------------------- prodotti
alter table products add column place_id uuid references nodes (id);
alter table products drop constraint products_kind_check;
alter table products
  add constraint products_kind_check check (kind in ('explore', 'route', 'bundle', 'place')),
  add constraint products_place_only_for_place check ((kind = 'place') = (place_id is not null));
create unique index products_one_place on products (place_id) where kind = 'place' and status <> 'retired';

create or replace function products_place_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.place_id is not null and not exists (
       select 1 from nodes n where n.id = new.place_id and n.pack_id = new.pack_id and n.kind = 'place') then
    raise exception 'il luogo del prodotto non è un luogo di questa destinazione';
  end if;
  return new;
end;
$$;
create trigger products_place_guard_trg before insert or update on products for each row execute function products_place_guard();

-- ---------------------------------------------------------------- diritti
alter table entitlements add column place_id uuid references nodes (id);
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'entitlements'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%scope%' loop
    execute format('alter table entitlements drop constraint %I', c);
  end loop;
end $$;
alter table entitlements
  add constraint entitlements_scope_check check (scope in ('explore', 'route', 'place')),
  add constraint entitlements_scope_target check ((scope = 'route') = (route_id is not null)),
  add constraint entitlements_place_target check ((scope = 'place') = (place_id is not null));
create index entitlements_place_idx on entitlements (user_id, place_id) where status = 'active' and scope = 'place';

create or replace function entitlements_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.route_id is not null and not exists (select 1 from routes where id = new.route_id and pack_id = new.pack_id) then
    raise exception 'il percorso del diritto è di un''altra destinazione';
  end if;
  if new.place_id is not null and not exists (select 1 from nodes where id = new.place_id and pack_id = new.pack_id and kind = 'place') then
    raise exception 'il luogo del diritto non è un luogo di questa destinazione';
  end if;
  return new;
end;
$$;

create or replace function has_place_right(p_pack text, p_place uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from entitlements e
    where e.user_id = auth.uid() and e.status = 'active' and e.scope = 'place' and e.pack_id = p_pack and e.place_id = p_place
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now()));
$$;
revoke execute on function has_place_right(text, uuid) from public, anon;
grant execute on function has_place_right(text, uuid) to authenticated, service_role;

create or replace function grant_product(p_user uuid, p_product uuid, p_source text, p_purchase uuid default null, p_note text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v products;
  n integer;
begin
  if p_source not in ('purchase', 'grant', 'promo', 'partner') then raise exception 'origine non ammessa: %', p_source; end if;
  if p_source = 'purchase' then
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
  elsif v.kind = 'place' then
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id, place_id, note)
    values (p_user, v.id, p_source, p_purchase, 'place', v.pack_id, v.place_id, p_note)
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

-- ---------------------------------------------------------------- catalogo
-- Perché un luogo non si può vendere (null se si può): esplorazione gratuita, luogo introduttivo (già gratuito), o
-- luogo senza racconti (chi lo comprasse non riceverebbe nulla).
create or replace function catalog_problem_place(p_pack text, p_place uuid)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Vendita): il luogo è già gratuito'
    when coalesce(pk.config -> 'access' -> 'introPlaces' ? (select slug from nodes where id = p_place), false)
      then format('«%s» è un luogo introduttivo: è già gratuito', (select slug from nodes where id = p_place))
    when not exists (select 1 from narrative_units u where u.anchor_node_id = p_place)
      then format('«%s» non ha racconti: non c''è niente da vendere', (select slug from nodes where id = p_place))
  end
  from packs pk where pk.id = p_pack;
$$;

create or replace function catalog_problem(p_product uuid)
returns text language sql stable set search_path = public as $$
  select case when p.kind = 'place' then catalog_problem_place(p.pack_id, p.place_id)
              else catalog_problem_of(p.kind, p.pack_id, p.route_id, p.id) end
  from products p where p.id = p_product;
$$;

create or replace function products_activation_guard()
returns trigger language plpgsql set search_path = public as $$
declare v_problem text;
begin
  if current_user <> 'authenticated' then return new; end if;
  if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active') then
    v_problem := case when new.kind = 'place' then catalog_problem_place(new.pack_id, new.place_id)
                      else catalog_problem_of(new.kind, new.pack_id, new.route_id, new.id) end;
    if v_problem is not null then raise exception 'non si attiva: %', v_problem; end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'retired' and new.status <> 'retired' then
    raise exception 'un prodotto ritirato resta ritirato: creane uno nuovo';
  end if;
  return new;
end;
$$;

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
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', n.id, 'slug', n.slug,
               'name', coalesce((select nl.name from node_labels nl where nl.node_id = n.id and nl.locale = 'it'), n.slug),
               'sellable', catalog_problem_place(k.id, n.id) is null)
             order by n.slug)
      from nodes n where n.pack_id = k.id and n.kind = 'place'), '[]'),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'slug', p.slug, 'kind', p.kind, 'labels', p.labels, 'status', p.status,
               'availability', p.availability, 'sortOrder', p.sort_order,
               'route', (select jsonb_build_object('id', r.id, 'slug', r.slug) from routes r where r.id = p.route_id),
               'place', (select jsonb_build_object('id', n.id, 'slug', n.slug) from nodes n where n.id = p.place_id),
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

-- «Metti in vendita i luoghi»: per ogni luogo vendibile senza prodotto (non ritirato) crea il prodotto attivo «Luogo»
-- con il prezzo in bozza indicato (in centesimi, 50 se non indicato). I prezzi valgono dopo «Pubblica i prezzi».
-- Restituisce quanti prodotti ha creato.
create or replace function studio_places_on_sale(p_pack text, p_amount integer default 50)
returns integer language plpgsql set search_path = public as $$
declare
  k packs;
  r record;
  v_id uuid;
  v_slug text;
  n integer := 0;
begin
  perform studio_require(is_platform_admin(), 'il catalogo lo gestisce l''amministratore della piattaforma');
  select * into k from packs where id = p_pack;
  if k.id is null or k.kind <> 'destination' then raise exception 'si vende solo una destinazione'; end if;
  if p_amount is null or p_amount < 50 or p_amount > 99900 then raise exception 'prezzo fuori dai limiti: da 0,50 € a 999 €'; end if;
  for r in
    select n2.id, n2.slug,
           coalesce((select nl.name from node_labels nl where nl.node_id = n2.id and nl.locale = 'it'), n2.slug) as name_it,
           (select nl.name from node_labels nl where nl.node_id = n2.id and nl.locale = 'en') as name_en
    from nodes n2
    where n2.pack_id = k.id and n2.kind = 'place' and catalog_problem_place(k.id, n2.id) is null
      and not exists (select 1 from products p where p.place_id = n2.id and p.kind = 'place' and p.status <> 'retired')
    order by n2.slug
  loop
    v_slug := regexp_replace(k.id, '[^a-z0-9]+', '-', 'g') || '-luogo-' || r.slug;
    if exists (select 1 from products where slug = v_slug) then
      v_slug := v_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;
    insert into products (slug, kind, pack_id, place_id, labels, status)
    values (v_slug, 'place', k.id, r.id,
            jsonb_strip_nulls(jsonb_build_object('it', jsonb_build_object('name', r.name_it),
                                                 'en', case when r.name_en is not null then jsonb_build_object('name', r.name_en) end)),
            'active')
    returning id into v_id;
    insert into product_prices (product_id, unit_amount, created_by) values (v_id, p_amount, auth.uid());
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function studio_places_on_sale(text, integer) from public, anon;
grant execute on function studio_places_on_sale(text, integer) to authenticated;

create or replace function public_catalog(p_pack text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'slug', p.slug, 'kind', p.kind, 'labels', p.labels,
           'route', (select r.slug from routes r where r.id = p.route_id),
           'place', (select n.slug from nodes n where n.id = p.place_id),
           'routes', coalesce((select jsonb_agg(r.slug order by r.slug) from product_routes pr join routes r on r.id = pr.route_id
                               where pr.product_id = p.id), '[]'),
           'price', jsonb_build_object('amount', pp.unit_amount, 'currency', pp.currency),
           'available', p.availability = 'available')
         order by p.sort_order, p.kind, p.slug), '[]')
  from products p
  join product_prices pp on pp.product_id = p.id and pp.status = 'published' and pp.currency = 'EUR'
  where p.pack_id = p_pack and p.status = 'active' and p.availability <> 'hidden' and catalog_problem(p.id) is null;
$$;

-- ---------------------------------------------------------------- ordini
create or replace function order_already_owned(p_user uuid, p_product uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from purchases where user_id = p_user and product_id = p_product
                 and status in ('completed', 'partially_refunded', 'disputed'))
      or (select case p.kind
            when 'explore' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                                        and e.scope = 'explore' and e.pack_id = p.pack_id)
            when 'route' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                                      and e.scope = 'route' and e.route_id = p.route_id)
            when 'place' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                                      and e.scope = 'place' and e.place_id = p.place_id)
            else not exists (select 1 from product_routes pr where pr.product_id = p.id and not exists (
                   select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                   and e.scope = 'route' and e.route_id = pr.route_id))
          end
          from products p where p.id = p_product);
$$;

-- Copia del prodotto nell'ordine: anche il luogo.
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
    'place', (select jsonb_build_object('id', n.id, 'slug', n.slug) from nodes n where n.id = p.place_id),
    'routes', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'slug', r.slug) order by r.slug)
                        from product_routes pr join routes r on r.id = pr.route_id where pr.product_id = p.id), '[]'));
  insert into purchases (id, user_id, product_id, provider, provider_ref, status, unit_amount, currency, price_id, product_snapshot)
  values (v_id, v_user, p.id, 'stripe', v_id::text, 'pending', v_price.unit_amount, v_price.currency, v_price.id, v_snapshot);
  return jsonb_build_object('order', v_id, 'amount', v_price.unit_amount, 'currency', v_price.currency,
    'name', coalesce(p.labels #>> '{it,name}', p.slug), 'supersede', v_supersede);
end;
$$;

-- Diritti di un ordine pagato: anche il luogo.
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
  elsif s ->> 'kind' = 'place' then
    -- Un luogo eliminato dopo l'acquisto non crea nulla (come i percorsi, D11).
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id, place_id)
    select o.user_id, o.product_id, 'purchase', o.id, 'place', s ->> 'pack', pl.id
    from nodes pl
    where pl.pack_id = s ->> 'pack' and pl.kind = 'place' and pl.id = (s #>> '{place,id}')::uuid
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

-- ---------------------------------------------------------------- file privati dei luoghi
-- Nomi: anche place-<luogo>; un file place-<luogo> si legge solo con il diritto su quel luogo.
create or replace function premium_object_name_ok(p_name text)
returns boolean language sql immutable as $$
  select coalesce(p_name ~ ('^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}/'
                            '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
                            '(explore|(route|place)-[a-z0-9]+(-[a-z0-9]+)*)\.[0-9a-f]{16,64}\.json$'), false);
$$;

-- Il visitatore può leggere questo file? Solo con un diritto attivo e valido ora (has_active_right usa auth.uid()).
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
  if v_file like 'place-%' then
    return exists (select 1 from nodes n
                   where n.pack_id = v_pack and n.kind = 'place'
                     and n.slug = substring(v_file from '^place-([a-z0-9-]+)\.[0-9a-f]+\.json$')
                     and has_place_right(v_pack, n.id));
  end if;
  select r.id into v_route from routes r
  where r.pack_id = v_pack and r.slug = substring(v_file from '^route-([a-z0-9-]+)\.[0-9a-f]+\.json$');
  return v_route is not null and has_active_right('route', v_pack, v_route);
end;
$$;

