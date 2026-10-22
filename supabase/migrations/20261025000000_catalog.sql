-- Catalogo commerciale: prezzi in bozza e pubblicati, disponibilità, funzioni dello Studio e catalogo pubblico
-- (PIANO-COMMERCIALE.md §2–§3, migrazione 1). Nessun pagamento qui: checkout e webhook arrivano dopo (Stripe).
--
-- Regole:
-- - importi interi in centesimi di euro (D12: solo EUR), da 0,50 € a 999 €;
-- - per prodotto e valuta: al massimo un prezzo in bozza e uno pubblicato; i precedenti restano archiviati;
-- - un prezzo uscito dalla bozza non cambia più importo, valuta o prodotto (pubblicato → archiviato e basta);
-- - prezzi e prodotti li scrive solo l'amministratore della piattaforma (D9), anche con richieste dirette;
-- - un prodotto si attiva solo se vende davvero qualcosa a pagamento (config.access del territorio): esplorazione a
--   pagamento, percorso premium, pacchetto di soli percorsi premium. Il catalogo pubblico ripete il controllo, così
--   un prodotto non resta in vendita se poi l'accesso torna gratuito;
-- - un prodotto con ordini non si elimina: si ritira.

-- ---------------------------------------------------------------- prodotti: disponibilità e ordine
alter table products
  add column availability text not null default 'available' check (availability in ('available', 'hidden', 'sold_out')),
  add column sort_order integer not null default 0;
-- Un solo prodotto attivo o in bozza per l'esplorazione di una destinazione e per ciascun percorso.
create unique index products_one_explore on products (pack_id) where kind = 'explore' and status <> 'retired';
create unique index products_one_route on products (route_id) where kind = 'route' and status <> 'retired';

-- ---------------------------------------------------------------- prezzi
create table product_prices (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references products (id) on delete cascade,
  currency        text not null default 'EUR' check (currency = 'EUR'),
  unit_amount     integer not null check (unit_amount between 50 and 99900),
  status          text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  stripe_price_id text,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id) on delete set null,
  published_at    timestamptz,
  published_by    uuid references auth.users (id) on delete set null,
  archived_at     timestamptz,
  check ((status = 'draft') = (published_at is null)),
  check ((status = 'archived') = (archived_at is not null))
);
create unique index product_prices_one_draft on product_prices (product_id, currency) where status = 'draft';
create unique index product_prices_one_published on product_prices (product_id, currency) where status = 'published';

-- Un prezzo fuori dalla bozza è storia: non cambia importo, valuta né prodotto; va solo da pubblicato ad archiviato.
-- Si eliminano solo le bozze (l'eliminazione a cascata di un prodotto mai venduto resta possibile).
create or replace function product_prices_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'un prezzo nasce in bozza e si pubblica con «Pubblica i prezzi»'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and pg_trigger_depth() = 1 and current_user = 'authenticated' then
      raise exception 'un prezzo pubblicato o archiviato non si elimina';
    end if;
    return old;
  end if;
  if (new.product_id, new.currency) is distinct from (old.product_id, old.currency) then
    raise exception 'prodotto e valuta di un prezzo non cambiano';
  end if;
  if old.status <> 'draft' and new.unit_amount <> old.unit_amount then
    raise exception 'l''importo di un prezzo pubblicato non cambia: prepara un nuovo prezzo in bozza';
  end if;
  if old.status = 'archived' and new.status <> 'archived' then raise exception 'un prezzo archiviato resta archiviato'; end if;
  if old.status = 'published' and new.status = 'draft' then raise exception 'un prezzo pubblicato non torna in bozza'; end if;
  return new;
end;
$$;
create trigger product_prices_guard_trg before insert or update or delete on product_prices
  for each row execute function product_prices_guard();

alter table product_prices enable row level security;
-- Prezzi pubblicati di prodotti attivi: leggibili da tutti (sono il listino). Bozze e storico: solo l'amministratore.
create policy product_prices_public_read on product_prices for select
  using ((status = 'published' and exists (select 1 from products p where p.id = product_id and p.status = 'active'))
         or is_platform_admin());
create policy product_prices_admin_write on product_prices for all using (is_platform_admin()) with check (is_platform_admin());
revoke all on product_prices from anon;
grant select on product_prices to anon;

-- Un prodotto con ordini non si elimina (si ritira): l'ordine deve poter dire cosa è stato comprato.
create or replace function products_delete_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from purchases where product_id = old.id) then
    raise exception 'il prodotto ha degli ordini: non si elimina, si ritira';
  end if;
  return old;
end;
$$;
create trigger products_delete_guard_trg before delete on products for each row execute function products_delete_guard();

-- ---------------------------------------------------------------- cosa vende un prodotto
-- Motivo per cui un prodotto non vende nulla a pagamento (null se è coerente con config.access del territorio).
-- Per tipo, destinazione e percorso dati (anche di una riga non ancora scritta); i percorsi di un pacchetto si leggono
-- da product_routes. Con i privilegi del chiamante: legge territorio e percorsi, già leggibili a chi vede il prodotto.
create or replace function catalog_problem_of(p_kind text, p_pack text, p_route uuid, p_product uuid)
returns text language sql stable set search_path = public as $$
  select case
    when p_kind = 'explore' and coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
      then 'l''esplorazione della destinazione è gratuita (pagina Accesso): il prodotto non vende nulla'
    when p_kind = 'route' and not coalesce(pk.config -> 'access' -> 'premiumRoutes' ? (select slug from routes where id = p_route), false)
      then format('il percorso «%s» non è premium (pagina Accesso)', (select slug from routes where id = p_route))
    when p_kind = 'bundle' and not exists (select 1 from product_routes pr where pr.product_id = p_product)
      then 'il pacchetto non contiene percorsi'
    when p_kind = 'bundle' and exists (
           select 1 from product_routes pr join routes br on br.id = pr.route_id
           where pr.product_id = p_product and not coalesce(pk.config -> 'access' -> 'premiumRoutes' ? br.slug, false))
      then 'il pacchetto contiene percorsi non premium (pagina Accesso)'
  end
  from packs pk where pk.id = p_pack;
$$;

create or replace function catalog_problem(p_product uuid)
returns text language sql stable set search_path = public as $$
  select catalog_problem_of(p.kind, p.pack_id, p.route_id, p.id) from products p where p.id = p_product;
$$;

-- Anche con richieste dirette all'API (ruolo authenticated) un prodotto si attiva solo se vende qualcosa a pagamento.
-- Le funzioni con i privilegi del proprietario e le importazioni non sono soggette al controllo (come le altre guardie).
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
create trigger products_activation_guard_trg before insert or update on products
  for each row execute function products_activation_guard();

-- ---------------------------------------------------------------- Studio: catalogo di una destinazione
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

-- Crea o aggiorna un prodotto della destinazione. p: {id?, kind, route?, routes?[], name: {it, en}, description: {it, en},
-- status, availability, sortOrder}. Tipo, destinazione e percorso si scelgono alla creazione e poi non cambiano.
create or replace function studio_product_save(p_pack text, p jsonb)
returns uuid language plpgsql set search_path = public as $$
declare
  k packs;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_old products;
  v_kind text;
  v_route uuid;
  v_status text := coalesce(p ->> 'status', 'draft');
  v_avail text := coalesce(p ->> 'availability', 'available');
  v_labels jsonb;
  v_slug text;
  v_routes text[];
  v_problem text;
begin
  perform studio_require(is_platform_admin(), 'il catalogo lo gestisce l''amministratore della piattaforma');
  select * into k from packs where id = p_pack;
  if k.id is null then raise exception 'territorio non trovato: %', p_pack; end if;
  if k.kind <> 'destination' then raise exception 'si vende solo una destinazione'; end if;
  if v_status not in ('draft', 'active', 'retired') then raise exception 'stato: bozza, attivo o ritirato'; end if;
  if v_avail not in ('available', 'hidden', 'sold_out') then raise exception 'disponibilità non valida'; end if;
  if length(trim(coalesce(p #>> '{name,it}', ''))) = 0 then raise exception 'serve il nome in italiano'; end if;
  if greatest(length(coalesce(p #>> '{name,it}', '')), length(coalesce(p #>> '{name,en}', ''))) > 80 then
    raise exception 'nome: al massimo 80 caratteri';
  end if;
  if greatest(length(coalesce(p #>> '{description,it}', '')), length(coalesce(p #>> '{description,en}', ''))) > 500 then
    raise exception 'descrizione: al massimo 500 caratteri';
  end if;
  v_labels := jsonb_strip_nulls(jsonb_build_object(
    'it', jsonb_build_object('name', trim(p #>> '{name,it}'), 'description', nullif(trim(coalesce(p #>> '{description,it}', '')), '')),
    'en', case when length(trim(coalesce(p #>> '{name,en}', ''))) > 0
               then jsonb_build_object('name', trim(p #>> '{name,en}'), 'description', nullif(trim(coalesce(p #>> '{description,en}', '')), '')) end));

  if v_id is null then
    v_kind := p ->> 'kind';
    if v_kind not in ('explore', 'route', 'bundle') then raise exception 'tipo: esplorazione, percorso o pacchetto'; end if;
    if v_kind = 'route' then
      select id into v_route from routes where pack_id = k.id and slug = p ->> 'route';
      if v_route is null then raise exception 'percorso inesistente: %', p ->> 'route'; end if;
    end if;
    v_slug := regexp_replace(k.id, '[^a-z0-9]+', '-', 'g') || '-' || case v_kind
      when 'explore' then 'esplorazione'
      when 'route' then 'percorso-' || regexp_replace(p ->> 'route', '[^a-z0-9]+', '-', 'g')
      else 'pacchetto-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8) end;
    if exists (select 1 from products where slug = v_slug) then
      v_slug := v_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;
    begin
      -- Nasce in bozza: lo stato richiesto si applica sotto, dopo i percorsi del pacchetto.
      insert into products (slug, kind, pack_id, route_id, labels, status, availability, sort_order)
      values (v_slug, v_kind, k.id, v_route, v_labels, 'draft', v_avail, coalesce((p ->> 'sortOrder')::int, 0))
      returning id into v_id;
    exception when unique_violation then
      raise exception '%', case v_kind when 'explore' then 'esiste già un prodotto per l''esplorazione (ritiralo prima di crearne un altro)'
                                       else 'esiste già un prodotto per questo percorso (ritiralo prima di crearne un altro)' end;
    end;
  else
    select * into v_old from products where id = v_id and pack_id = k.id;
    if v_old.id is null then raise exception 'prodotto non trovato in questa destinazione'; end if;
    v_kind := v_old.kind;
    if v_old.status = 'retired' and v_status <> 'retired' then
      raise exception 'un prodotto ritirato resta ritirato: creane uno nuovo';
    end if;
    update products set labels = v_labels, availability = v_avail, sort_order = coalesce((p ->> 'sortOrder')::int, sort_order)
    where id = v_id;
  end if;

  if v_kind = 'bundle' and p ? 'routes' then
    v_routes := array(select distinct x from jsonb_array_elements_text(coalesce(p -> 'routes', '[]')) x);
    if exists (select 1 from unnest(v_routes) x where not exists (select 1 from routes r where r.pack_id = k.id and r.slug = x)) then
      raise exception 'il pacchetto contiene un percorso inesistente';
    end if;
    delete from product_routes where product_id = v_id and route_id not in (select id from routes where pack_id = k.id and slug = any (v_routes));
    insert into product_routes (product_id, route_id)
    select v_id, r.id from routes r where r.pack_id = k.id and r.slug = any (v_routes)
    on conflict do nothing;
  end if;

  if v_status = 'active' then
    v_problem := catalog_problem(v_id);
    if v_problem is not null then raise exception 'non si attiva: %', v_problem; end if;
  end if;
  begin
    update products set status = v_status where id = v_id;
  exception when unique_violation then
    raise exception 'esiste già un prodotto non ritirato per lo stesso contenuto';
  end;
  return v_id;
end;
$$;

-- Prezzo in bozza (centesimi) di un prodotto; null toglie la bozza. Il prezzo pubblicato non cambia fino a «Pubblica».
create or replace function studio_price_draft(p_product uuid, p_amount integer)
returns void language plpgsql set search_path = public as $$
begin
  perform studio_require(is_platform_admin(), 'i prezzi li gestisce l''amministratore della piattaforma');
  if not exists (select 1 from products where id = p_product) then raise exception 'prodotto non trovato'; end if;
  if exists (select 1 from products where id = p_product and status = 'retired') then raise exception 'il prodotto è ritirato'; end if;
  if p_amount is null then
    delete from product_prices where product_id = p_product and status = 'draft';
    return;
  end if;
  if p_amount < 50 or p_amount > 99900 then raise exception 'prezzo fuori dai limiti: da 0,50 € a 999 €'; end if;
  update product_prices set unit_amount = p_amount where product_id = p_product and status = 'draft';
  if not found then
    insert into product_prices (product_id, unit_amount, created_by) values (p_product, p_amount, auth.uid());
  end if;
end;
$$;

-- «Pubblica i prezzi» della destinazione: per ogni prodotto con una bozza, il prezzo pubblicato va in archivio e la
-- bozza diventa il nuovo prezzo. Tutto insieme o niente. Restituisce quanti prezzi sono stati pubblicati.
create or replace function studio_prices_publish(p_pack text)
returns integer language plpgsql set search_path = public as $$
declare v_count integer;
begin
  perform studio_require(is_platform_admin(), 'i prezzi li pubblica l''amministratore della piattaforma');
  -- Due pubblicazioni in contemporanea sulla stessa destinazione non si sovrappongono.
  perform pg_advisory_xact_lock(hashtext('catalog_publish:' || p_pack));
  update product_prices pp set status = 'archived', archived_at = now()
  where pp.status = 'published'
    and exists (select 1 from product_prices d where d.product_id = pp.product_id and d.currency = pp.currency and d.status = 'draft')
    and pp.product_id in (select id from products where pack_id = p_pack);
  update product_prices pp set status = 'published', published_at = now(), published_by = auth.uid()
  where pp.status = 'draft' and pp.product_id in (select id from products where pack_id = p_pack and status <> 'retired');
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'nessun prezzo in bozza da pubblicare'; end if;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- catalogo pubblico
-- Ciò che è davvero in vendita in una destinazione: prodotti attivi, non nascosti, con un prezzo pubblicato e
-- coerenti con l'accesso attuale. «Esaurito» compare ma non si compra. Leggibile da tutti, senza account.
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

revoke execute on function studio_catalog(text), studio_product_save(text, jsonb), studio_price_draft(uuid, integer),
  studio_prices_publish(text), catalog_problem(uuid), catalog_problem_of(text, text, uuid, uuid) from public, anon;
grant execute on function studio_catalog(text), studio_product_save(text, jsonb), studio_price_draft(uuid, integer),
  studio_prices_publish(text), catalog_problem(uuid), catalog_problem_of(text, text, uuid, uuid) to authenticated;
revoke execute on function public_catalog(text) from public;
grant execute on function public_catalog(text) to anon, authenticated;
