-- Acquisto progressivo (decisioni del 2026-10-31, docs/v0.3-platform/ACQUISTO-PROGRESSIVO.md).
--
-- Livelli: contenuto singolo («unit»: un sottoluogo, o i racconti propri di un luogo principale), luogo principale
-- («place», comprende i suoi sottoluoghi), destinazione («explore»), tutte le destinazioni («all», nuovo, comprende
-- anche quelle pubblicate dopo l'acquisto). I percorsi restano separati e non contano.
--
-- Prezzo dei livelli superiori (regola A, sconto a conteggio, nessun credito):
--   prezzo = arrotondamento al centesimo di listino × (contenuti che mancano / contenuti del livello)
-- contando le unità acquistabili del livello coperte dai diritti attivi dell'utente (un luogo comprato copre tutte le
-- sue unità: niente doppi conteggi). Lo sconto raggiunto non scende mai (se si aggiungono contenuti vale la quota più
-- alta registrata nei suoi acquisti) e il prezzo non supera mai la somma dei singoli che mancano (così un luogo con
-- un solo contenuto costa quanto il singolo). Sotto 0,50 € (minimo di Stripe) il pacchetto non si vende: si comprano
-- i singoli che mancano. Il prezzo lo calcola solo il database (commerce_quote), anche al checkout.
--
-- Listino centrale: tabella price_tiers (bozza → pubblicato, come i prezzi dei prodotti), un prezzo per livello. Un
-- prodotto con un proprio prezzo pubblicato lo tiene (compatibilità: nessun prezzo esistente cambia); «Segui il
-- listino» nello Studio archivia il prezzo proprio. Le tariffe nascono in BOZZA: nulla cambia finché l'amministratore
-- non le pubblica.
--
-- Contenuti vendibili (decisione del 2026-11-01, criterio rigoroso): contano solo i contenuti della pubblicazione in
-- linea, con il loro file privato presente nel bucket e almeno un racconto con tutte le affermazioni verificate. Mai
-- contenuti in revisione, in bozza o non ancora pubblicati. Lo sconto e il tetto dei singoli valgono solo con la tariffa
-- del contenuto singolo pubblicata; senza, i pacchetti costano il loro listino come prima.
--
-- Rimborsi: l'ordine che ha contribuito allo sconto di un acquisto successivo segna quell'acquisto «da rivedere»;
-- nessuna revoca automatica dell'acquisto successivo.
--
-- Nessun dato esistente cambia: nuove colonne vuote, nuove tariffe in bozza, nessun prodotto creato.

-- ---------------------------------------------------------------- listino centrale
create table price_tiers (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('unit', 'place', 'explore', 'all')),
  currency     text not null default 'EUR' check (currency = 'EUR'),
  unit_amount  integer not null check (unit_amount between 50 and 99900),
  status       text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  published_at timestamptz,
  published_by uuid references auth.users (id) on delete set null,
  archived_at  timestamptz,
  check ((status = 'draft') = (published_at is null)),
  check ((status = 'archived') = (archived_at is not null))
);
create unique index price_tiers_one_draft on price_tiers (kind) where status = 'draft';
create unique index price_tiers_one_published on price_tiers (kind) where status = 'published';

-- Come i prezzi dei prodotti: un prezzo pubblicato o archiviato è storia.
create or replace function price_tiers_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'una tariffa nasce in bozza e si pubblica con «Pubblica il listino»'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and current_user = 'authenticated' then raise exception 'una tariffa pubblicata o archiviata non si elimina'; end if;
    return old;
  end if;
  if (new.kind, new.currency) is distinct from (old.kind, old.currency) then raise exception 'livello e valuta di una tariffa non cambiano'; end if;
  if old.status <> 'draft' and new.unit_amount <> old.unit_amount then
    raise exception 'l''importo di una tariffa pubblicata non cambia: prepara una nuova tariffa in bozza';
  end if;
  if old.status = 'archived' and new.status <> 'archived' then raise exception 'una tariffa archiviata resta archiviata'; end if;
  if old.status = 'published' and new.status = 'draft' then raise exception 'una tariffa pubblicata non torna in bozza'; end if;
  return new;
end;
$$;
create trigger price_tiers_guard_trg before insert or update or delete on price_tiers for each row execute function price_tiers_guard();

alter table price_tiers enable row level security;
create policy price_tiers_public_read on price_tiers for select using (status = 'published' or is_platform_admin());
create policy price_tiers_admin_write on price_tiers for all using (is_platform_admin()) with check (is_platform_admin());
revoke all on price_tiers from anon;
grant select on price_tiers to anon, authenticated;
grant insert, update, delete on price_tiers to authenticated;

-- Proposta del 2026-10-31, in bozza: 0,99 € · 2,99 € · 9,99 € · 19,99 €.
insert into price_tiers (kind, unit_amount) values ('unit', 99), ('place', 299), ('explore', 999), ('all', 1999);

-- ---------------------------------------------------------------- prodotti
alter table products drop constraint products_kind_check;
alter table products drop constraint products_pack_required;
alter table products drop constraint products_place_only_for_place;
alter table products
  add constraint products_kind_check check (kind in ('explore', 'route', 'bundle', 'place', 'unit', 'all')),
  add constraint products_pack_required check ((kind = 'all') = (pack_id is null)),
  add constraint products_place_only_for_place check ((kind in ('place', 'unit')) = (place_id is not null));
create unique index products_one_unit on products (place_id) where kind = 'unit' and status <> 'retired';
create unique index products_one_all on products (kind) where kind = 'all' and status <> 'retired';

create or replace function products_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE'
     and (new.kind, new.pack_id, new.route_id, new.place_id) is distinct from (old.kind, old.pack_id, old.route_id, old.place_id)
     and exists (select 1 from purchases where product_id = old.id) then
    raise exception 'il prodotto è già stato acquistato: tipo, destinazione e percorso non si cambiano (creane uno nuovo)';
  end if;
  if new.kind = 'all' then
    if new.pack_id is not null or new.route_id is not null or new.place_id is not null then
      raise exception '«Tutte le destinazioni» non appartiene a una destinazione';
    end if;
    return new;
  end if;
  if not exists (select 1 from packs where id = new.pack_id and kind = 'destination') then
    raise exception 'un prodotto appartiene a una destinazione';
  end if;
  if new.route_id is not null and not exists (select 1 from routes where id = new.route_id and pack_id = new.pack_id) then
    raise exception 'il percorso del prodotto è di un''altra destinazione';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------- diritti
alter table entitlements alter column pack_id drop not null;
alter table entitlements drop constraint entitlements_scope_check;
alter table entitlements drop constraint entitlements_place_target;
alter table entitlements
  add constraint entitlements_scope_check check (scope in ('explore', 'route', 'place', 'unit', 'all')),
  add constraint entitlements_place_target check ((scope in ('place', 'unit')) = (place_id is not null)),
  add constraint entitlements_pack_target check ((scope = 'all') = (pack_id is null));
create index entitlements_unit_idx on entitlements (user_id, place_id) where status = 'active' and scope = 'unit';

-- ---------------------------------------------------------------- ordini
alter table purchases
  add column tier_id uuid references price_tiers (id),
  add column list_amount integer check (list_amount between 50 and 99900),
  -- Preventivo applicato al checkout: unità del livello, già possedute, quota minima, acquisti che hanno contribuito.
  add column discount jsonb,
  -- Avanzamento dell'utente dopo questo acquisto, in punti base per livello («place:<id>», «explore:<pack>», «all»):
  -- base della regola «lo sconto raggiunto non scende mai».
  add column progress jsonb,
  add column review_reason text check (length(review_reason) <= 500),
  add column review_at timestamptz,
  add column review_done_at timestamptz,
  add column review_done_by uuid references auth.users (id) on delete set null;
alter table purchases drop constraint purchases_stripe_copy;
alter table purchases add constraint purchases_stripe_copy check (provider <> 'stripe'
  or (unit_amount is not null and currency is not null and (price_id is not null or tier_id is not null)
      and product_snapshot is not null));
create index purchases_review_idx on purchases (review_at) where review_reason is not null and review_done_at is null;

-- ---------------------------------------------------------------- unità acquistabili
-- Destinazioni che vendono contenuti: pubblicate, con l'esplorazione a pagamento.
create or replace function commerce_destinations()
returns table (pack_id text) language sql stable security definer set search_path = public as $$
  select pk.id from packs pk join destinations d on d.pack_id = pk.id
  where pk.kind = 'destination' and d.status = 'published' and coalesce(pk.config #>> '{access,explore}', 'free') = 'premium'
  order by pk.id;
$$;

-- Unità acquistabili di una destinazione: solo ciò che è davvero pubblicato e verificato. Si legge il manifest della
-- pubblicazione in linea (l'ultima riuscita, come public_bundle_index) nella lingua principale della destinazione; un
-- luogo non gratuito è un'unità se ha il suo file privato «unit» (i suoi racconti a pagamento: per un principale quelli
-- oltre la panoramica gratuita), se quel file è presente nel bucket «premium» e se contiene almeno un racconto con tutte
-- le affermazioni verificate (verifiedStories, scritto dalla pubblicazione). Contenuti in revisione, in bozza o non
-- ancora pubblicati non contano. Nessuna unità se l'esplorazione non è a pagamento o prima di una pubblicazione con i
-- file «unit».
create or replace function commerce_units(p_pack text)
returns table (node_id uuid, principal_id uuid) language sql stable security definer set search_path = public as $$
  with k as (
    select config, default_locale from packs
    where id = p_pack and kind = 'destination' and coalesce(config #>> '{access,explore}', 'free') = 'premium'),
  pub as (
    select p.bundle_ids from publications p
    where p.pack_id = p_pack and p.status = 'published'
    order by p.finished_at desc nulls last, p.created_at desc limit 1),
  f as (
    select e.value as f
    from pub cross join k
    join bundles b on b.id = any (pub.bundle_ids) and b.locale = k.default_locale
    cross join lateral jsonb_array_elements(coalesce(b.manifest -> 'premium', '[]'::jsonb)) e
    where e.value ->> 'kind' = 'unit'
      and coalesce(e.value ->> 'verifiedStories', '') ~ '^[1-9][0-9]{0,5}$'
      and exists (select 1 from storage.objects o where o.bucket_id = 'premium' and o.name = e.value ->> 'path'))
  select n.id, coalesce(place_parent(n.id), n.id)
  from f cross join k
  join nodes n on n.pack_id = p_pack and n.kind = 'place' and f.f ->> 'ref' = p_pack || ':' || n.slug
  where not coalesce(k.config -> 'access' -> 'freePlaces' ? n.slug, false)
  order by coalesce(place_parent(n.id), n.id), place_parent(n.id) is not null, n.slug;
$$;

-- Unità di un livello: «unit» una sola, «place» quelle del luogo principale, «explore» quelle della destinazione,
-- «all» quelle di tutte le destinazioni che vendono contenuti.
create or replace function commerce_scope_units(p_kind text, p_pack text, p_place uuid)
returns table (pack_id text, node_id uuid, principal_id uuid) language sql stable security definer set search_path = public as $$
  select p_pack, u.node_id, u.principal_id from commerce_units(p_pack) u
  where p_kind = 'explore' or (p_kind = 'place' and u.principal_id = p_place) or (p_kind = 'unit' and u.node_id = p_place)
  union all
  select d.pack_id, u.node_id, u.principal_id
  from commerce_destinations() d cross join lateral commerce_units(d.pack_id) u
  where p_kind = 'all';
$$;

-- Un diritto copre un'unità? «all» tutto, «explore» la sua destinazione, «place» il luogo principale (anche un diritto
-- su un luogo diventato sottoluogo: copre il suo principale, come has_place_right), «unit» solo quella.
create or replace function commerce_covers(e_scope text, e_pack text, e_place uuid, p_pack text, p_node uuid, p_principal uuid)
returns boolean language sql stable set search_path = public as $$
  select case e_scope
    when 'all' then true
    when 'explore' then e_pack = p_pack
    when 'place' then e_pack = p_pack and coalesce(place_parent(e_place), e_place) = p_principal
    when 'unit' then e_place = p_node
    else false end;
$$;

-- Prezzo di listino di un prodotto: il suo prezzo pubblicato se ce l'ha, altrimenti la tariffa pubblicata del livello.
create or replace function product_list_price(p_product uuid)
returns table (amount integer, price_id uuid, tier_id uuid) language sql stable security definer set search_path = public as $$
  select coalesce(pp.unit_amount, t.unit_amount), pp.id, case when pp.id is null then t.id end
  from products p
  left join product_prices pp on pp.product_id = p.id and pp.status = 'published' and pp.currency = 'EUR'
  left join price_tiers t on t.kind = p.kind and t.status = 'published' and t.currency = 'EUR'
  where p.id = p_product and (pp.id is not null or t.id is not null);
$$;

-- Prezzo del contenuto singolo di un'unità: il listino effettivo del suo prodotto «unit» in vendita (prezzo proprio o
-- tariffa); se non si vende da solo (luogo con un solo contenuto, prodotto non ancora creato), la tariffa del contenuto
-- singolo. Null se la tariffa del contenuto singolo non è pubblicata: senza, non c'è acquisto progressivo.
create or replace function commerce_single_price(p_node uuid)
returns integer language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from price_tiers t where t.kind = 'unit' and t.status = 'published') then
    coalesce(
      (select lp.amount from products p cross join lateral product_list_price(p.id) lp
       where p.kind = 'unit' and p.place_id = p_node and p.status = 'active' and p.availability <> 'hidden'
       order by p.created_at limit 1),
      (select t.unit_amount from price_tiers t where t.kind = 'unit' and t.status = 'published'))
  end;
$$;

-- Copertura di un livello per un utente: unità totali, possedute, somma dei prezzi dei singoli che mancano (null se la
-- tariffa del contenuto singolo non è pubblicata) e acquisti che hanno contribuito.
create or replace function commerce_coverage(p_user uuid, p_kind text, p_pack text, p_place uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with u as (select * from commerce_scope_units(p_kind, p_pack, p_place)),
  c as (
    select u.*, array(
             select distinct e.purchase_id from entitlements e
             where p_user is not null and e.user_id = p_user and e.status = 'active'
               and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now())
               and commerce_covers(e.scope, e.pack_id, e.place_id, u.pack_id, u.node_id, u.principal_id)) as by
    from u)
  select jsonb_build_object(
    'total', count(*),
    'owned', count(*) filter (where cardinality(c.by) > 0),
    'singles', case when exists (select 1 from price_tiers t where t.kind = 'unit' and t.status = 'published')
                    then coalesce(sum(commerce_single_price(c.node_id)) filter (where cardinality(c.by) = 0), 0) end,
    'basis', coalesce((select jsonb_agg(distinct x) from c c2, unnest(c2.by) x where x is not null), '[]'::jsonb))
  from c;
$$;

-- Quota più alta (punti base) registrata negli acquisti ancora validi dell'utente per quel livello.
create or replace function commerce_progress_floor(p_user uuid, p_key text)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(max((pu.progress ->> p_key)::integer), 0)
  from purchases pu
  where pu.user_id = p_user and pu.status in ('completed', 'partially_refunded') and pu.progress ? p_key
    and exists (select 1 from entitlements e where e.purchase_id = pu.id and e.status = 'active');
$$;

-- Avanzamento attuale dell'utente in ogni livello che vende contenuti (punti base, arrotondati per difetto).
create or replace function commerce_progress_snapshot(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with u as (
    select su.*, exists (
             select 1 from entitlements e
             where e.user_id = p_user and e.status = 'active'
               and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now())
               and commerce_covers(e.scope, e.pack_id, e.place_id, su.pack_id, su.node_id, su.principal_id)) as covered
    from commerce_scope_units('all', null, null) su),
  s as (
    select 'all' as k, count(*) as t, count(*) filter (where covered) as o from u
    union all
    select 'explore:' || pack_id, count(*), count(*) filter (where covered) from u group by pack_id
    union all
    select 'place:' || principal_id, count(*), count(*) filter (where covered) from u group by principal_id)
  select coalesce(jsonb_object_agg(k, (o * 10000) / t), '{}'::jsonb) from s where t > 0;
$$;

-- ---------------------------------------------------------------- prezzo
-- Ha già questo contenuto? Un acquisto pagato dello stesso prodotto, o un diritto che lo comprende.
create or replace function order_already_owned(p_user uuid, p_product uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from purchases where user_id = p_user and product_id = p_product
                 and status in ('completed', 'partially_refunded', 'disputed'))
      or (select case p.kind
            when 'all' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active' and e.scope = 'all')
            when 'explore' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                                        and (e.scope = 'all' or (e.scope = 'explore' and e.pack_id = p.pack_id)))
            when 'route' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                                      and e.scope = 'route' and e.route_id = p.route_id)
            when 'place' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                                      and e.scope in ('place', 'explore', 'all')
                                      and commerce_covers(e.scope, e.pack_id, e.place_id, p.pack_id, p.place_id, p.place_id))
            when 'unit' then exists (select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                                     and commerce_covers(e.scope, e.pack_id, e.place_id, p.pack_id, p.place_id,
                                                         coalesce(place_parent(p.place_id), p.place_id)))
            else not exists (select 1 from product_routes pr where pr.product_id = p.id and not exists (
                   select 1 from entitlements e where e.user_id = p_user and e.status = 'active'
                   and e.scope = 'route' and e.route_id = pr.route_id))
          end
          from products p where p.id = p_product);
$$;

-- Preventivo per un utente (null = visitatore senza account: prezzo di listino). Esiti:
--   ok · unpriced (nessun prezzo pubblicato) · owned (ce l'ha già) · complete (ha già tutte le unità del livello) ·
--   below_minimum (resta meno di 0,50 €: si comprano i singoli che mancano).
create or replace function commerce_quote(p_user uuid, p_product uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  p products;
  v_list integer;
  v_price uuid;
  v_tier uuid;
  c jsonb;
  v_total integer := 0;
  v_owned integer := 0;
  v_singles integer;
  v_floor integer := 0;
  v_amount integer;
  v_key text;
  v_progressive boolean;
  v_status text;
begin
  select * into p from products where id = p_product;
  if p.id is null then return null; end if;
  select lp.amount, lp.price_id, lp.tier_id into v_list, v_price, v_tier from product_list_price(p.id) lp;
  v_progressive := p.kind in ('place', 'explore', 'all');
  if v_progressive then
    c := commerce_coverage(p_user, p.kind, p.pack_id, p.place_id);
    v_total := (c ->> 'total')::integer;
    v_owned := (c ->> 'owned')::integer;
    v_singles := (c ->> 'singles')::integer;
    v_key := case p.kind when 'place' then 'place:' || p.place_id when 'explore' then 'explore:' || p.pack_id else 'all' end;
    if p_user is not null then v_floor := least(commerce_progress_floor(p_user, v_key), 10000); end if;
  end if;
  v_amount := v_list;
  -- Sconto e tetto dei singoli, allo stesso modo per luogo, destinazione e tutte: solo con la tariffa del contenuto
  -- singolo pubblicata (v_singles non nullo); senza, il pacchetto costa il suo listino.
  if v_list is not null and v_progressive and v_total > 0 and v_singles is not null then
    v_amount := round(v_list::numeric * least((v_total - v_owned)::numeric / v_total, (10000 - v_floor)::numeric / 10000))::integer;
    if v_singles < v_amount then v_amount := v_singles; end if;
  end if;
  v_status := case
    when v_list is null then 'unpriced'
    when p_user is not null and order_already_owned(p_user, p.id) then 'owned'
    when v_progressive and v_total > 0 and v_owned >= v_total then 'complete'
    when v_amount < 50 then 'below_minimum'
    else 'ok' end;
  return jsonb_build_object(
    'product', p.id, 'kind', p.kind, 'status', v_status,
    'list', v_list, 'amount', case when v_status in ('ok', 'below_minimum') then v_amount end,
    'total', v_total, 'owned', v_owned, 'floorBp', v_floor, 'singles', v_singles,
    'basis', coalesce(c -> 'basis', '[]'::jsonb), 'priceId', v_price, 'tierId', v_tier);
end;
$$;

-- ---------------------------------------------------------------- catalogo
create or replace function catalog_problem_unit(p_pack text, p_node uuid)
returns text language sql stable set search_path = public as $$
  select case
    when coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Vendita): il contenuto è già gratuito'
    when not exists (select 1 from commerce_units(p_pack) u where u.node_id = p_node)
      then format('«%s» non ha contenuti a pagamento pubblicati e verificati (luogo gratuito, racconti in revisione o non '
                  'ancora pubblicati: verifica i fatti, poi «Ripubblica con le modifiche»)', (select slug from nodes where id = p_node))
    when (select count(*) from commerce_units(p_pack) u
          where u.principal_id = coalesce(place_parent(p_node), p_node)) < 2
      then format('«%s» è l''unico contenuto del suo luogo: si vende il luogo, allo stesso prezzo del singolo',
                  (select slug from nodes where id = p_node))
  end
  from packs pk where pk.id = p_pack;
$$;

create or replace function catalog_problem_all()
returns text language sql stable set search_path = public as $$
  select case when (select count(*) from commerce_destinations()) < 2
    then 'servono almeno due destinazioni pubblicate con l''esplorazione a pagamento' end;
$$;

create or replace function catalog_problem_kind(p_kind text, p_pack text, p_place uuid, p_route uuid, p_product uuid)
returns text language sql stable set search_path = public as $$
  select case p_kind
    when 'place' then catalog_problem_place(p_pack, p_place)
    when 'unit' then catalog_problem_unit(p_pack, p_place)
    when 'all' then catalog_problem_all()
    else catalog_problem_of(p_kind, p_pack, p_route, p_product) end;
$$;

create or replace function catalog_problem(p_product uuid)
returns text language sql stable set search_path = public as $$
  select catalog_problem_kind(p.kind, p.pack_id, p.place_id, p.route_id, p.id) from products p where p.id = p_product;
$$;

create or replace function products_activation_guard()
returns trigger language plpgsql set search_path = public as $$
declare v_problem text;
begin
  if current_user <> 'authenticated' then return new; end if;
  if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active') then
    v_problem := catalog_problem_kind(new.kind, new.pack_id, new.place_id, new.route_id, new.id);
    if v_problem is not null then raise exception 'non si attiva: %', v_problem; end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'retired' and new.status <> 'retired' then
    raise exception 'un prodotto ritirato resta ritirato: creane uno nuovo';
  end if;
  return new;
end;
$$;

-- Catalogo pubblico di una destinazione, con «Tutte le destinazioni» quando è in vendita. Prezzo = listino; il prezzo
-- personale (con lo sconto) lo dà my_commerce_quotes a chi ha un account. «units»: contenuti a pagamento del livello.
create or replace function public_catalog(p_pack text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'slug', p.slug, 'kind', p.kind, 'labels', p.labels,
           'route', (select r.slug from routes r where r.id = p.route_id),
           'place', (select n.slug from nodes n where n.id = p.place_id),
           'principal', case when p.kind = 'unit' then (select n.slug from nodes n where n.id = place_parent(p.place_id)) end,
           'routes', coalesce((select jsonb_agg(r.slug order by r.slug) from product_routes pr join routes r on r.id = pr.route_id
                               where pr.product_id = p.id), '[]'),
           'price', jsonb_build_object('amount', lp.amount, 'currency', 'EUR'),
           'units', case when p.kind in ('place', 'explore', 'all')
                         then (select count(*) from commerce_scope_units(p.kind, p.pack_id, p.place_id)) end,
           'available', p.availability = 'available')
         order by p.kind = 'all', p.sort_order, p.kind, p.slug), '[]')
  from products p
  cross join lateral product_list_price(p.id) lp
  where (p.pack_id = p_pack or (p.kind = 'all' and exists (select 1 from commerce_destinations() d where d.pack_id = p_pack)))
    and p.status = 'active' and p.availability <> 'hidden' and catalog_problem(p.id) is null;
$$;

-- Preventivi dell'utente per i prodotti di una destinazione (e per «Tutte le destinazioni»), più le unità che possiede.
create or replace function my_commerce_quotes(p_pack text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then return jsonb_build_object('quotes', '[]'::jsonb, 'ownedUnits', '[]'::jsonb); end if;
  return jsonb_build_object(
    'quotes', coalesce((
      select jsonb_agg(commerce_quote(v_user, p.id) - 'basis' - 'priceId' - 'tierId' order by p.kind, p.slug)
      from products p
      where (p.pack_id = p_pack or p.kind = 'all') and p.kind in ('place', 'explore', 'all', 'unit')
        and p.status = 'active' and p.availability <> 'hidden' and catalog_problem(p.id) is null), '[]'::jsonb),
    'ownedUnits', coalesce((
      select jsonb_agg(n.slug order by n.slug)
      from commerce_units(p_pack) u join nodes n on n.id = u.node_id
      where exists (select 1 from entitlements e
                    where e.user_id = v_user and e.status = 'active'
                      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now())
                      and commerce_covers(e.scope, e.pack_id, e.place_id, p_pack, u.node_id, u.principal_id))), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------- checkout
-- Come prima, ma l'importo è quello del preventivo (commerce_quote), calcolato qui nel database.
create or replace function checkout_open(p_product uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  p products;
  q jsonb;
  v_id uuid := gen_random_uuid();
  v_snapshot jsonb;
  v_supersede jsonb;
  v_amount integer;
begin
  perform studio_require(v_user is not null, 'accedi per acquistare');
  -- Due richieste dello stesso utente passano una alla volta (anche per prodotti diversi: lo sconto dipende da tutti).
  perform pg_advisory_xact_lock(hashtext('checkout:' || v_user::text));
  select * into p from products where id = p_product;
  if p.id is null or p.status <> 'active' or p.availability = 'hidden' then raise exception 'prodotto non in vendita'; end if;
  if p.availability = 'sold_out' then raise exception 'prodotto esaurito'; end if;
  if catalog_problem(p.id) is not null then raise exception 'prodotto non in vendita'; end if;
  if p.kind <> 'all' and not exists (select 1 from destinations where pack_id = p.pack_id and status = 'published') then
    raise exception 'destinazione non ancora pubblicata';
  end if;
  q := commerce_quote(v_user, p.id);
  if q ->> 'status' = 'unpriced' then raise exception 'prodotto senza prezzo pubblicato'; end if;
  if q ->> 'status' = 'owned' then raise exception 'hai già acquistato questo contenuto'; end if;
  if q ->> 'status' = 'complete' then raise exception 'hai già tutti i contenuti di questo pacchetto'; end if;
  if q ->> 'status' = 'below_minimum' then
    raise exception 'quello che resta costa meno di 0,50 €, il minimo per un pagamento: acquista i contenuti singoli che mancano';
  end if;
  v_amount := (q ->> 'amount')::integer;

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
  insert into purchases (id, user_id, product_id, provider, provider_ref, status, unit_amount, currency, price_id, tier_id,
                         list_amount, discount, product_snapshot)
  values (v_id, v_user, p.id, 'stripe', v_id::text, 'pending', v_amount, 'EUR', (q ->> 'priceId')::uuid, (q ->> 'tierId')::uuid,
          (q ->> 'list')::integer,
          case when p.kind in ('place', 'explore', 'all')
               then jsonb_build_object('total', q -> 'total', 'owned', q -> 'owned', 'floorBp', q -> 'floorBp',
                                       'singles', q -> 'singles', 'basis', q -> 'basis') end,
          v_snapshot);
  return jsonb_build_object('order', v_id, 'amount', v_amount, 'currency', 'EUR', 'list', (q ->> 'list')::integer,
    'name', coalesce(p.labels #>> '{it,name}', p.slug), 'supersede', v_supersede);
end;
$$;

-- Diritti di un ordine pagato: anche il contenuto singolo e «Tutte le destinazioni». Al primo rilascio registra
-- l'avanzamento dell'utente (progress).
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
  elsif s ->> 'kind' = 'all' then
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id)
    values (o.user_id, o.product_id, 'purchase', o.id, 'all', null)
    on conflict do nothing;
    get diagnostics n = row_count;
  elsif s ->> 'kind' in ('place', 'unit') then
    -- Un luogo eliminato dopo l'acquisto non crea nulla (come i percorsi, D11).
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id, place_id)
    select o.user_id, o.product_id, 'purchase', o.id, s ->> 'kind', s ->> 'pack', pl.id
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
  if o.progress is null then
    update purchases set progress = commerce_progress_snapshot(o.user_id) where id = o.id;
  end if;
  return n;
end;
$$;

-- Concessioni manuali (admin_grant_product): anche contenuto singolo e «Tutte le destinazioni».
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
  elsif v.kind = 'all' then
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id, note)
    values (p_user, v.id, p_source, p_purchase, 'all', null, p_note)
    on conflict do nothing;
  elsif v.kind = 'route' then
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id, route_id, note)
    values (p_user, v.id, p_source, p_purchase, 'route', v.pack_id, v.route_id, p_note)
    on conflict do nothing;
  elsif v.kind in ('place', 'unit') then
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id, place_id, note)
    values (p_user, v.id, p_source, p_purchase, v.kind, v.pack_id, v.place_id, p_note)
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

-- ---------------------------------------------------------------- rimborsi da rivedere
-- Segna «da rivedere» gli acquisti il cui sconto si basava su questo ordine (revisione manuale, nessuna revoca).
create or replace function commerce_flag_dependents(p_order uuid, p_reason text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update purchases set review_reason = left(p_reason, 500), review_at = now(), review_done_at = null, review_done_by = null
  where id <> p_order and discount -> 'basis' ? p_order::text
    and status in ('completed', 'partially_refunded', 'disputed');
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function commerce_flag_dependents(uuid, text) from public, anon, authenticated;

create or replace function payment_refunded(p_payment_intent text, p_amount_refunded integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o purchases; v_to text; n integer := 0; f integer := 0;
begin
  select * into o from purchases where stripe_payment_intent_id = p_payment_intent for update;
  if o.id is null then return jsonb_build_object('order', null, 'changed', false); end if;
  if p_amount_refunded <= o.amount_refunded then
    return jsonb_build_object('order', o.id, 'status', o.status, 'changed', false);
  end if;
  v_to := case when p_amount_refunded >= coalesce(o.amount_total, o.unit_amount) then 'refunded' else 'partially_refunded' end;
  update purchases set amount_refunded = p_amount_refunded, updated_at = now() where id = o.id;
  f := commerce_flag_dependents(o.id, format('rimborso (%s di %s centesimi) dell''ordine %s, che ha contribuito allo sconto',
                                             p_amount_refunded, coalesce(o.amount_total, o.unit_amount), o.id));
  if not order_transition_allowed(o.status, v_to) then
    return jsonb_build_object('order', o.id, 'status', o.status, 'changed', false, 'flagged', f);
  end if;
  update purchases set status = v_to, refunded_at = case when v_to = 'refunded' then now() else refunded_at end where id = o.id;
  if v_to = 'refunded' then
    update entitlements set status = 'revoked', note = coalesce(note || ' · ', '') || 'revocato: rimborso'
    where purchase_id = o.id and status in ('active', 'suspended');
    get diagnostics n = row_count;
  end if;
  return jsonb_build_object('order', o.id, 'status', v_to, 'changed', true, 'revoked', n, 'flagged', f);
end;
$$;

create or replace function payment_dispute(p_payment_intent text, p_state text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o purchases; v_to text;
begin
  if p_state not in ('open', 'won', 'lost') then raise exception 'esito non valido: %', p_state; end if;
  select * into o from purchases where stripe_payment_intent_id = p_payment_intent for update;
  if o.id is null then return jsonb_build_object('order', null, 'changed', false); end if;
  v_to := case p_state when 'open' then 'disputed' when 'lost' then 'refunded'
          else case when o.amount_refunded > 0 then 'partially_refunded' else 'completed' end end;
  if p_state <> 'open' and o.status <> 'disputed' then
    return jsonb_build_object('order', o.id, 'status', o.status, 'changed', false);
  end if;
  if not order_transition_allowed(o.status, v_to) then
    return jsonb_build_object('order', o.id, 'status', o.status, 'changed', false);
  end if;
  update purchases set status = v_to, updated_at = now(),
    refunded_at = case when v_to = 'refunded' then now() else refunded_at end where id = o.id;
  if p_state = 'open' then
    update entitlements set status = 'suspended' where purchase_id = o.id and status = 'active';
  elsif p_state = 'won' then
    update entitlements set status = 'active' where purchase_id = o.id and status = 'suspended';
    perform grant_order(o.id);
  else
    update entitlements set status = 'revoked', note = coalesce(note || ' · ', '') || 'revocato: contestazione persa'
    where purchase_id = o.id and status in ('active', 'suspended');
    perform commerce_flag_dependents(o.id, format('contestazione persa sull''ordine %s, che ha contribuito allo sconto', o.id));
  end if;
  return jsonb_build_object('order', o.id, 'status', v_to, 'changed', true);
end;
$$;

-- ---------------------------------------------------------------- lettura dei file a pagamento
-- «explore» vale anche con «Tutte le destinazioni».
create or replace function has_active_right(p_scope text, p_pack text, p_route uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from entitlements e
    where e.user_id = auth.uid() and e.status = 'active'
      and ((e.scope = p_scope and e.pack_id = p_pack and e.route_id is not distinct from p_route)
           or (p_scope = 'explore' and e.scope = 'all'))
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now()));
$$;

-- File di un contenuto singolo: solo con il diritto su quel contenuto. Chi ha il luogo, la destinazione o tutte riceve
-- già gli stessi racconti dal file del luogo (place-<luogo>) o dell'esplorazione: niente copie doppie da scaricare.
create or replace function has_unit_right(p_pack text, p_node uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from entitlements e
    where e.user_id = auth.uid() and e.status = 'active' and e.scope = 'unit' and e.pack_id = p_pack and e.place_id = p_node
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now()));
$$;
revoke execute on function has_unit_right(text, uuid) from public, anon;
grant execute on function has_unit_right(text, uuid) to authenticated, service_role;

-- Nomi: anche unit-<luogo> (la parte di un contenuto singolo).
create or replace function premium_object_name_ok(p_name text)
returns boolean language sql immutable as $$
  select coalesce(p_name ~ ('^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}/'
                            '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
                            '(explore|(route|place|unit)-[a-z0-9]+(-[a-z0-9]+)*)\.[0-9a-f]{16,64}\.json$'), false);
$$;

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
  if v_file like 'unit-%' then
    return exists (select 1 from nodes n
                   where n.pack_id = v_pack and n.kind = 'place'
                     and n.slug = substring(v_file from '^unit-([a-z0-9-]+)\.[0-9a-f]+\.json$')
                     and has_unit_right(v_pack, n.id));
  end if;
  select r.id into v_route from routes r
  where r.pack_id = v_pack and r.slug = substring(v_file from '^route-([a-z0-9-]+)\.[0-9a-f]+\.json$');
  return v_route is not null and has_active_right('route', v_pack, v_route);
end;
$$;

-- ---------------------------------------------------------------- Studio (solo amministratore)
-- Listino, «Tutte le destinazioni» e ordini da rivedere.
create or replace function studio_commerce()
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform studio_require(is_platform_admin(), 'il listino lo gestisce l''amministratore della piattaforma');
  return jsonb_build_object(
    'tiers', (select jsonb_agg(jsonb_build_object(
                'kind', k.kind,
                'published', (select jsonb_build_object('amount', t.unit_amount, 'at', t.published_at) from price_tiers t
                              where t.kind = k.kind and t.status = 'published'),
                'draft', (select jsonb_build_object('amount', t.unit_amount) from price_tiers t
                          where t.kind = k.kind and t.status = 'draft')) order by k.o)
              from (values ('unit', 1), ('place', 2), ('explore', 3), ('all', 4)) k(kind, o)),
    'all', jsonb_build_object(
      'product', (select jsonb_build_object('id', p.id, 'slug', p.slug, 'status', p.status, 'labels', p.labels,
                                            'paidOrders', (select count(*) from purchases pu where pu.product_id = p.id and pu.status = 'completed'))
                  from products p where p.kind = 'all' and p.status <> 'retired'),
      'problem', catalog_problem_all(),
      'destinations', coalesce((select jsonb_agg(d.pack_id) from commerce_destinations() d), '[]'::jsonb),
      'units', (select count(*) from commerce_scope_units('all', null, null))),
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pu.id, 'product', coalesce(pu.product_snapshot #>> '{labels,it,name}', pu.product_snapshot ->> 'slug'),
               'kind', pu.product_snapshot ->> 'kind', 'status', pu.status, 'amount', pu.unit_amount, 'list', pu.list_amount,
               'paidAt', pu.paid_at, 'reason', pu.review_reason, 'at', pu.review_at) order by pu.review_at desc)
      from purchases pu where pu.review_reason is not null and pu.review_done_at is null), '[]'::jsonb));
end;
$$;

-- Tariffa in bozza di un livello (centesimi); null toglie la bozza.
create or replace function studio_price_tier_draft(p_kind text, p_amount integer)
returns void language plpgsql set search_path = public as $$
begin
  perform studio_require(is_platform_admin(), 'il listino lo gestisce l''amministratore della piattaforma');
  if p_kind not in ('unit', 'place', 'explore', 'all') then raise exception 'livello non valido: %', p_kind; end if;
  if p_amount is null then
    delete from price_tiers where kind = p_kind and status = 'draft';
    return;
  end if;
  if p_amount < 50 or p_amount > 99900 then raise exception 'prezzo fuori dai limiti: da 0,50 € a 999 €'; end if;
  update price_tiers set unit_amount = p_amount where kind = p_kind and status = 'draft';
  if not found then insert into price_tiers (kind, unit_amount, created_by) values (p_kind, p_amount, auth.uid()); end if;
end;
$$;

-- «Pubblica il listino»: ogni bozza diventa la tariffa del suo livello, la precedente va in archivio.
create or replace function studio_price_tiers_publish()
returns integer language plpgsql set search_path = public as $$
declare v_count integer;
begin
  perform studio_require(is_platform_admin(), 'il listino lo pubblica l''amministratore della piattaforma');
  perform pg_advisory_xact_lock(hashtext('price_tiers_publish'));
  update price_tiers t set status = 'archived', archived_at = now()
  where t.status = 'published' and exists (select 1 from price_tiers d where d.kind = t.kind and d.status = 'draft');
  update price_tiers set status = 'published', published_at = now(), published_by = auth.uid() where status = 'draft';
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'nessuna tariffa in bozza da pubblicare'; end if;
  -- Il tetto «mai più dei singoli» si calcola con la tariffa del contenuto singolo: senza, niente pacchetti a listino.
  if exists (select 1 from price_tiers where status = 'published' and kind <> 'unit')
     and not exists (select 1 from price_tiers where status = 'published' and kind = 'unit') then
    raise exception 'pubblica anche la tariffa del contenuto singolo: serve a calcolare il prezzo dei pacchetti';
  end if;
  return v_count;
end;
$$;

-- «Segui il listino»: il prodotto lascia il suo prezzo (pubblicato in archivio, bozza tolta) e usa la tariffa.
create or replace function studio_product_follow_tier(p_product uuid)
returns void language plpgsql set search_path = public as $$
declare p products;
begin
  perform studio_require(is_platform_admin(), 'i prezzi li gestisce l''amministratore della piattaforma');
  select * into p from products where id = p_product;
  if p.id is null then raise exception 'prodotto non trovato'; end if;
  if p.kind not in ('unit', 'place', 'explore', 'all') then raise exception 'percorsi e pacchetti non hanno una tariffa di listino'; end if;
  delete from product_prices where product_id = p.id and status = 'draft';
  update product_prices set status = 'archived', archived_at = now() where product_id = p.id and status = 'published';
end;
$$;

-- «Metti in vendita i contenuti singoli»: un prodotto attivo «Contenuto singolo», al prezzo di listino, per ogni unità
-- vendibile da sola (in luoghi con almeno due contenuti) che non ce l'ha; quelli che non sono più vendibili passano
-- a «ritirato». Restituisce { created, retired }.
create or replace function studio_units_on_sale(p_pack text)
returns jsonb language plpgsql set search_path = public as $$
declare
  k packs;
  r record;
  v_slug text;
  n integer := 0;
  v_retired integer;
begin
  perform studio_require(is_platform_admin(), 'il catalogo lo gestisce l''amministratore della piattaforma');
  select * into k from packs where id = p_pack;
  if k.id is null or k.kind <> 'destination' then raise exception 'si vende solo una destinazione'; end if;
  update products p set status = 'retired'
  where p.pack_id = k.id and p.kind = 'unit' and p.status <> 'retired' and catalog_problem_unit(k.id, p.place_id) is not null;
  get diagnostics v_retired = row_count;
  for r in
    select n2.id, n2.slug,
           coalesce((select nl.name from node_labels nl where nl.node_id = n2.id and nl.locale = 'it'), n2.slug) as name_it,
           (select nl.name from node_labels nl where nl.node_id = n2.id and nl.locale = 'en') as name_en
    from commerce_units(k.id) u join nodes n2 on n2.id = u.node_id
    where catalog_problem_unit(k.id, n2.id) is null
      and not exists (select 1 from products p where p.place_id = n2.id and p.kind = 'unit' and p.status <> 'retired')
    order by n2.slug
  loop
    v_slug := regexp_replace(k.id, '[^a-z0-9]+', '-', 'g') || '-unita-' || r.slug;
    if exists (select 1 from products where slug = v_slug) then
      v_slug := v_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;
    insert into products (slug, kind, pack_id, place_id, labels, status)
    values (v_slug, 'unit', k.id, r.id,
            jsonb_strip_nulls(jsonb_build_object('it', jsonb_build_object('name', r.name_it),
                                                 'en', case when r.name_en is not null then jsonb_build_object('name', r.name_en) end)),
            'active');
    n := n + 1;
  end loop;
  return jsonb_build_object('created', n, 'retired', v_retired);
end;
$$;

-- «Tutte le destinazioni»: crea il prodotto se manca e lo mette in vendita (attivo) o lo sospende (bozza).
create or replace function studio_all_product_set(p_active boolean)
returns uuid language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  perform studio_require(is_platform_admin(), 'il catalogo lo gestisce l''amministratore della piattaforma');
  select id into v_id from products where kind = 'all' and status <> 'retired';
  if v_id is null then
    insert into products (slug, kind, labels, status)
    values ('tutte-le-destinazioni-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6), 'all',
            '{"it":{"name":"Tutte le destinazioni"},"en":{"name":"All destinations"}}', 'draft')
    returning id into v_id;
  end if;
  update products set status = case when p_active then 'active' else 'draft' end where id = v_id;
  return v_id;
end;
$$;

-- Revisione fatta (l'amministratore ha controllato l'ordine segnalato).
create or replace function studio_order_review_done(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform studio_require(is_platform_admin(), 'gli ordini li rivede l''amministratore della piattaforma');
  update purchases set review_done_at = now(), review_done_by = auth.uid()
  where id = p_order and review_reason is not null and review_done_at is null;
  if not found then raise exception 'ordine non da rivedere'; end if;
end;
$$;

-- Catalogo dello Studio: come prima, più il prezzo di listino effettivo di ogni prodotto e le unità di ogni luogo.
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
    'units', (select count(*) from commerce_units(k.id)),
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
               'sellable', catalog_problem_place(k.id, n.id) is null,
               'parent', (select p.slug from nodes p where p.id = place_parent(n.id)),
               'subPlaces', (select count(*) from places cp where cp.part_of_node_id = n.id and place_parent(cp.node_id) = n.id),
               'isUnit', exists (select 1 from commerce_units(k.id) u where u.node_id = n.id),
               'units', (select count(*) from commerce_units(k.id) u where u.principal_id = n.id))
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
               'tier', (select jsonb_build_object('amount', t.unit_amount) from price_tiers t
                        where t.kind = p.kind and t.status = 'published'),
               'paidOrders', (select count(*) from purchases pu where pu.product_id = p.id and pu.status = 'completed'),
               'problem', catalog_problem(p.id))
             order by p.status = 'retired', p.sort_order, p.kind, p.slug)
      from products p where p.pack_id = k.id), '[]'),
    'drafts', (select count(*) from product_prices pp join products p on p.id = pp.product_id
               where p.pack_id = k.id and pp.status = 'draft'));
end;
$$;

-- ---------------------------------------------------------------- permessi
-- Quali contenuti si vendono e a che prezzo di listino: informazioni pubbliche (il bundle mostra già i luoghi bloccati).
grant execute on function commerce_destinations(), commerce_units(text), commerce_scope_units(text, text, uuid),
  product_list_price(uuid) to anon, authenticated, service_role;
-- Funzioni senza dati riservati, ma non pensate per l'API: niente esecuzione diretta.
revoke execute on function commerce_covers(text, text, uuid, text, uuid, uuid), price_tiers_guard() from public, anon, authenticated;
grant execute on function commerce_covers(text, text, uuid, text, uuid, uuid) to service_role;
grant execute on function commerce_single_price(uuid) to anon, authenticated, service_role;
-- Copertura, avanzamento e preventivo di un utente qualsiasi: solo il server e le funzioni qui sopra (my_commerce_quotes,
-- checkout_open), mai dall'API con un id utente scelto dal chiamante.
revoke execute on function commerce_coverage(uuid, text, text, uuid), commerce_progress_floor(uuid, text),
  commerce_progress_snapshot(uuid), commerce_quote(uuid, uuid) from public, anon, authenticated;
grant execute on function commerce_coverage(uuid, text, text, uuid), commerce_progress_floor(uuid, text),
  commerce_progress_snapshot(uuid), commerce_quote(uuid, uuid) to service_role;
revoke execute on function my_commerce_quotes(text) from public, anon;
grant execute on function my_commerce_quotes(text) to authenticated;
revoke execute on function studio_commerce(), studio_price_tier_draft(text, integer), studio_price_tiers_publish(),
  studio_product_follow_tier(uuid), studio_units_on_sale(text), studio_all_product_set(boolean),
  studio_order_review_done(uuid), catalog_problem_unit(text, uuid), catalog_problem_all(),
  catalog_problem_kind(text, text, uuid, uuid, uuid) from public, anon;
grant execute on function studio_commerce(), studio_price_tier_draft(text, integer), studio_price_tiers_publish(),
  studio_product_follow_tier(uuid), studio_units_on_sale(text), studio_all_product_set(boolean),
  studio_order_review_done(uuid), catalog_problem_unit(text, uuid), catalog_problem_all(),
  catalog_problem_kind(text, text, uuid, uuid, uuid) to authenticated;
