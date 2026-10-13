-- Diritti commerciali: cosa sblocca ogni prodotto, senza ambiguità (decisione D1, piano commerciale).
--
-- Prodotti (sempre di una destinazione):
--   explore  esplorazione completa della destinazione (i racconti esclusi dal bundle pubblico, config.access);
--   route    un percorso premium;
--   bundle   un pacchetto di percorsi premium (product_routes).
-- Diritti (entitlements), uno per ogni cosa sbloccata, con un ambito esplicito:
--   explore  sulla destinazione: NON concede i percorsi premium;
--   route    su un percorso: concede solo quel percorso (l'itinerario: vedi ACCESSO-CONTENUTI.md, «Percorsi»).
-- Un pacchetto crea un diritto «route» per ogni percorso che contiene AL MOMENTO della concessione: se poi il
-- pacchetto cambia, chi l'ha comprato conserva esattamente ciò che ha ricevuto, né più né meno.
-- Limite: l'acquisto non conserva una copia del contenuto del pacchetto al momento del pagamento (lo schema non ha un
-- campo per farlo). Se la concessione arriva dopo una modifica del pacchetto, vale il contenuto al momento della
-- concessione: per questo va fatta subito dopo il pagamento (vedi docs/v0.3-platform/ACCESSO-CONTENUTI.md).
--
-- Il catalogo delle attività locali è gratuito: non è un prodotto e non richiede diritti.
-- Prezzi, checkout e webhook non ci sono ancora: i diritti si concedono solo con grant_product() (ruolo di servizio,
-- cioè il server) o admin_grant_product() (amministratore della piattaforma, concessioni manuali). Nessuna scrittura
-- diretta da client. Per gli acquisti grant_product() è idempotente (un evento di pagamento ripetuto non duplica
-- nulla) e funziona anche se il prodotto è stato ritirato dopo il pagamento; un prodotto già acquistato non cambia
-- più tipo, destinazione o percorso.

-- ---------------------------------------------------------------- controllo iniziale
do $$ begin
  if exists (select 1 from products where kind not in ('explore', 'route', 'bundle')) then
    raise exception 'DIRITTI: esistono prodotti di tipo pack_access/route_access/feature: convertili prima (explore/route/bundle).';
  end if;
  if exists (select 1 from entitlements) then
    raise exception 'DIRITTI: esistono già dei diritti senza ambito: vanno rivisti a mano prima di questa migrazione.';
  end if;
end $$;

-- ---------------------------------------------------------------- prodotti
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'products'::regclass and contype = 'c' loop
    execute format('alter table products drop constraint %I', c);
  end loop;
end $$;
alter table products
  add constraint products_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  add constraint products_status_check check (status in ('draft', 'active', 'retired')),
  add constraint products_kind_check check (kind in ('explore', 'route', 'bundle')),
  add constraint products_pack_required check (pack_id is not null),
  add constraint products_route_only_for_route check ((kind = 'route') = (route_id is not null)),
  add constraint products_no_feature check (feature is null);

-- Percorsi di un pacchetto.
create table product_routes (
  product_id uuid not null references products (id) on delete cascade,
  route_id   uuid not null references routes (id),
  primary key (product_id, route_id)
);
alter table product_routes enable row level security;
create policy product_routes_public_read on product_routes for select
  using (exists (select 1 from products p where p.id = product_id and (p.status = 'active' or is_platform_admin())));
create policy product_routes_admin_write on product_routes for all using (is_platform_admin()) with check (is_platform_admin());

-- Coerenza: il prodotto è di una destinazione; il percorso (di un prodotto «route» o di un pacchetto) è della stessa.
-- Con i privilegi del proprietario: il controllo vede tutto, i permessi restano alle policy (scrive solo l'amministratore).
-- Dopo il primo acquisto, cosa sblocca un prodotto (tipo, destinazione, percorso) non cambia più: l'acquisto punta
-- al prodotto e questi campi sono l'unico dato affidabile su cosa è stato comprato (non c'è una copia nell'acquisto).
-- Restano modificabili nome, descrizione e stato (si può ritirare un prodotto dalla vendita).
create or replace function products_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE'
     and (new.kind, new.pack_id, new.route_id) is distinct from (old.kind, old.pack_id, old.route_id)
     and exists (select 1 from purchases where product_id = old.id) then
    raise exception 'il prodotto è già stato acquistato: tipo, destinazione e percorso non si cambiano (creane uno nuovo)';
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
create trigger products_guard_trg before insert or update on products for each row execute function products_guard();

create or replace function product_routes_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_product products;
begin
  select * into v_product from products where id = new.product_id;
  if v_product.kind <> 'bundle' then raise exception 'solo un pacchetto contiene più percorsi'; end if;
  if not exists (select 1 from routes where id = new.route_id and pack_id = v_product.pack_id) then
    raise exception 'un pacchetto contiene solo percorsi della sua destinazione';
  end if;
  return new;
end;
$$;
create trigger product_routes_guard_trg before insert or update on product_routes for each row execute function product_routes_guard();

-- ---------------------------------------------------------------- diritti
alter table entitlements
  add column scope text check (scope in ('explore', 'route')),
  add column pack_id text references packs (id),
  add column route_id uuid references routes (id);
alter table entitlements
  alter column scope set not null,
  alter column pack_id set not null,
  add constraint entitlements_scope_target check ((scope = 'route') = (route_id is not null));
create index entitlements_scope_idx on entitlements (user_id, scope, pack_id, route_id) where status = 'active';
-- Un acquisto concede ogni ambito una volta sola, qualunque sia lo stato del diritto: un evento di pagamento ripetuto
-- non duplica i diritti e non fa rivivere quelli revocati (rimborso, contestazione).
create unique index entitlements_purchase_scope_key on entitlements
  (purchase_id, scope, coalesce(route_id, '00000000-0000-0000-0000-000000000000'::uuid)) where purchase_id is not null;

create or replace function entitlements_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.route_id is not null and not exists (select 1 from routes where id = new.route_id and pack_id = new.pack_id) then
    raise exception 'il percorso del diritto è di un''altra destinazione';
  end if;
  return new;
end;
$$;
create trigger entitlements_guard_trg before insert or update on entitlements for each row execute function entitlements_guard();

-- Nessuna scrittura diretta: nemmeno l'amministratore scrive le righe a mano (usa admin_grant_product).
drop policy if exists entitlements_admin_write on entitlements;
revoke insert, update, delete on entitlements from anon, authenticated;

-- ---------------------------------------------------------------- concessione e revoca
-- Diritti concessi da un prodotto: esplorazione, un percorso, o i percorsi del pacchetto in questo momento.
--
-- Acquisti (p_source = 'purchase'): idempotente. Lo stesso acquisto concede i suoi diritti una volta sola: le
-- chiamate successive (evento di pagamento ripetuto, anche in parallelo) non creano nulla e restituiscono 0, anche se
-- intanto il pacchetto è cambiato o i diritti sono stati revocati. Un acquisto completato concede i diritti anche se
-- il prodotto nel frattempo è stato ritirato dalla vendita: il pagamento è avvenuto.
-- Altre origini (concessioni manuali, promozioni, partner): solo prodotti attivi; ogni chiamata è una concessione.
-- Restituisce il numero di diritti creati da questa chiamata.
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

-- Concessione manuale (omaggi, assistenza): solo l'amministratore della piattaforma.
create or replace function admin_grant_product(p_user uuid, p_product uuid, p_note text)
returns integer language plpgsql security definer set search_path = public as $$
begin
  perform studio_require(is_platform_admin(), 'solo l''amministratore della piattaforma concede diritti');
  if coalesce(trim(p_note), '') = '' then raise exception 'indica il motivo della concessione'; end if;
  return grant_product(p_user, p_product, 'grant', null, p_note);
end;
$$;

-- Revoca dei diritti di un acquisto (rimborso, contestazione persa).
create or replace function revoke_purchase(p_purchase uuid, p_reason text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update entitlements set status = 'revoked', note = coalesce(note || ' · ', '') || 'revocato: ' || p_reason
  where purchase_id = p_purchase and status = 'active';
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function grant_product(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function revoke_purchase(uuid, text) from public, anon, authenticated;
grant execute on function grant_product(uuid, uuid, text, uuid, text) to service_role;
grant execute on function revoke_purchase(uuid, text) to service_role;
revoke execute on function admin_grant_product(uuid, uuid, text) from public, anon;
grant execute on function admin_grant_product(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------- accesso
create or replace function has_active_right(p_scope text, p_pack text, p_route uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from entitlements e
    where e.user_id = auth.uid() and e.status = 'active' and e.scope = p_scope and e.pack_id = p_pack
      and e.route_id is not distinct from p_route
      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now()));
$$;

-- Esplorazione completa di una destinazione: libera se non è a pagamento, altrimenti serve il diritto «explore».
create or replace function can_access_explore(p_pack text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select coalesce(pk.config #>> '{access,explore}', 'free') <> 'premium'
        or has_active_right('explore', pk.id, null)
    from packs pk where pk.id = p_pack and pk.kind = 'destination'), false);
$$;

-- Un percorso: libero se non è tra i premium della destinazione, altrimenti serve il diritto su QUEL percorso.
-- L'esplorazione completa non lo concede (prima lo concedeva pack_access).
create or replace function can_access_route(p_route uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select not coalesce(pk.config -> 'access' -> 'premiumRoutes' ? r.slug, false)
        or has_active_right('route', r.pack_id, r.id)
    from routes r join packs pk on pk.id = r.pack_id where r.id = p_route), false);
$$;

revoke execute on function has_active_right(text, text, uuid) from public, anon;
grant execute on function has_active_right(text, text, uuid) to authenticated, service_role;
