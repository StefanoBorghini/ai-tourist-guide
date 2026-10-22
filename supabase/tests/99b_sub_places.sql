-- Test dei luoghi principali e dei sottoluoghi (20261101000000_sub_places.sql):
--   S1 la spunta dello Studio: solo chi modifica il territorio, un solo livello, solo luoghi della stessa destinazione;
--   S2 si vendono solo i luoghi principali (1,99 € proposto); i prodotti di chi diventa sottoluogo si ritirano;
--      un sottoluogo non si attiva né si compra da solo;
--   S4 un principale gratuito si vende se ha sottoluoghi a pagamento (20261102000000);
--   S3 il diritto sul principale apre il suo file, non quello di un altro principale; chi aveva comprato un luogo poi
--      diventato sottoluogo riceve il file del principale.
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values ('9b000000-0000-0000-0000-00000000000f', 'institution', 'Comune S (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zs.sigma', 'destination', '9b000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Sigma"}',
   '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":[]}}'),
  ('zs.tau', 'destination', '9b000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Tau"}', '{}');
insert into destinations (pack_id, status) values ('zs.sigma', 'published'), ('zs.tau', 'draft');
insert into nodes (id, pack_id, slug, kind) values
  ('9b000000-0000-0000-0000-0000000000a1', 'zs.sigma', 'isola', 'place'),
  ('9b000000-0000-0000-0000-0000000000a2', 'zs.sigma', 'grotta', 'place'),
  ('9b000000-0000-0000-0000-0000000000a3', 'zs.sigma', 'faro', 'place'),
  ('9b000000-0000-0000-0000-0000000000a4', 'zs.sigma', 'piazza', 'place'),
  ('9b000000-0000-0000-0000-0000000000a5', 'zs.tau', 'altrove', 'place');
insert into node_labels (node_id, locale, name) values
  ('9b000000-0000-0000-0000-0000000000a1', 'it', 'Isola'), ('9b000000-0000-0000-0000-0000000000a2', 'it', 'Grotta'),
  ('9b000000-0000-0000-0000-0000000000a3', 'it', 'Faro'), ('9b000000-0000-0000-0000-0000000000a4', 'it', 'Piazza');
insert into places (node_id, place_kind, location, importance, dwell_min, coordinate_method)
select id, 'poi', 'SRID=4326;POINT(9.9 44.1)', 3, 10, 'GPS' from nodes where pack_id in ('zs.sigma', 'zs.tau');
insert into auth.users (id, email, raw_user_meta_data) values
  ('9b000000-0000-0000-0000-000000000001', 'admin-s@prova.test', '{}'),
  ('9b000000-0000-0000-0000-000000000002', 'cliente-s@prova.test', '{}'),
  ('9b000000-0000-0000-0000-000000000003', 'estraneo-s@prova.test', '{}'),
  ('9b000000-0000-0000-0000-000000000004', 'editor-s@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('9b000000-0000-0000-0000-000000000001', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin', null),
  ('9b000000-0000-0000-0000-000000000004', '9b000000-0000-0000-0000-00000000000f', 'territory_editor', 'zs.sigma');

-- Prima della gerarchia: tutti e quattro i luoghi in vendita a 0,50 € (come con la migrazione 28); la cliente compra
-- la grotta (per S3, acquisto fatto quando la grotta era un luogo a sé).
set role authenticated;
set request.jwt.claim.sub = '9b000000-0000-0000-0000-000000000001';
do $$ begin
  if (studio_places_on_sale('zs.sigma', 50) ->> 'created')::int <> 4 then raise exception 'FALLITO S2: messa in vendita iniziale'; end if;
  perform studio_prices_publish('zs.sigma');
end $$;
reset role;
insert into purchases (id, user_id, product_id, provider, provider_ref, status) values
  ('9b000000-0000-0000-0000-0000000000c1', '9b000000-0000-0000-0000-000000000002',
   (select id from products where place_id = '9b000000-0000-0000-0000-0000000000a2' and status = 'active'), 'test', 's3', 'completed');
select grant_product('9b000000-0000-0000-0000-000000000002',
  (select id from products where place_id = '9b000000-0000-0000-0000-0000000000a2' and status = 'active'), 'purchase', '9b000000-0000-0000-0000-0000000000c1');

-- ---------------------------------------------------------------- S1: la spunta
set role authenticated;
set request.jwt.claim.sub = '9b000000-0000-0000-0000-000000000003';
do $$ begin
  perform studio_set_place_parent('zs.sigma', 'grotta', 'isola');
  raise exception 'FALLITO S1: un estraneo cambia la gerarchia';
exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end $$;
set request.jwt.claim.sub = '9b000000-0000-0000-0000-000000000004';
do $$
declare p jsonb;
begin
  p := studio_set_place_parent('zs.sigma', 'grotta', 'isola');
  if p ->> 'parent' <> 'isola' then raise exception 'FALLITO S1: la grotta non risulta sottoluogo dell''isola (%)', p; end if;
  perform studio_set_place_parent('zs.sigma', 'faro', 'isola');
  if studio_place('zs.sigma', 'isola') -> 'children' <> '["faro","grotta"]' then
    raise exception 'FALLITO S1: sottoluoghi dell''isola %', studio_place('zs.sigma', 'isola') -> 'children';
  end if;
  if (select x ->> 'parent' from jsonb_array_elements(studio_places('zs.sigma')) x where x ->> 'slug' = 'faro') <> 'isola' then
    raise exception 'FALLITO S1: l''elenco dei luoghi non mostra il principale';
  end if;
  -- Un solo livello, in entrambi i versi.
  begin
    perform studio_set_place_parent('zs.sigma', 'piazza', 'grotta');
    raise exception 'FALLITO S1: un sottoluogo fa da principale';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_set_place_parent('zs.sigma', 'isola', 'piazza');
    raise exception 'FALLITO S1: un luogo con sottoluoghi diventa sottoluogo';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_set_place_parent('zs.sigma', 'piazza', 'piazza');
    raise exception 'FALLITO S1: un luogo sottoluogo di sé stesso';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_set_place_parent('zs.sigma', 'piazza', 'altrove');
    raise exception 'FALLITO S1: principale di un''altra destinazione';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Si toglie e si rimette.
  perform studio_set_place_parent('zs.sigma', 'faro', null);
  if studio_place('zs.sigma', 'faro') ->> 'parent' is not null then raise exception 'FALLITO S1: la spunta non si toglie'; end if;
  perform studio_set_place_parent('zs.sigma', 'faro', 'isola');
end $$;
reset role;

-- ---------------------------------------------------------------- S2: vendita dei principali
set role authenticated;
set request.jwt.claim.sub = '9b000000-0000-0000-0000-000000000004';
do $$ begin
  perform studio_places_on_sale('zs.sigma');
  raise exception 'FALLITO S2: un redattore mette in vendita';
exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end $$;
set request.jwt.claim.sub = '9b000000-0000-0000-0000-000000000001';
do $$
declare r jsonb;
begin
  r := studio_places_on_sale('zs.sigma');
  if (r ->> 'retired')::int <> 2 or (r ->> 'created')::int <> 0 then
    raise exception 'FALLITO S2: atteso il ritiro di grotta e faro, nessun nuovo prodotto (%)', r;
  end if;
  if exists (select 1 from products where place_id in ('9b000000-0000-0000-0000-0000000000a2', '9b000000-0000-0000-0000-0000000000a3')
             and status <> 'retired') then
    raise exception 'FALLITO S2: un sottoluogo resta in vendita';
  end if;
  if (select x ->> 'subPlaces' from jsonb_array_elements(studio_catalog('zs.sigma') -> 'places') x where x ->> 'slug' = 'isola') <> '2' then
    raise exception 'FALLITO S2: il catalogo non conta i sottoluoghi dell''isola';
  end if;
  if (select (x ->> 'sellable')::boolean from jsonb_array_elements(studio_catalog('zs.sigma') -> 'places') x where x ->> 'slug' = 'grotta') then
    raise exception 'FALLITO S2: il catalogo dice vendibile un sottoluogo';
  end if;
  -- Anche scritto a mano dall'API, il prodotto di un sottoluogo non si attiva.
  begin
    insert into products (slug, kind, pack_id, place_id, status) values ('zs-grotta-2', 'place', 'zs.sigma', '9b000000-0000-0000-0000-0000000000a2', 'active');
    raise exception 'FALLITO S2: attivato il prodotto di un sottoluogo';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;
reset role;
-- Il prezzo proposto per un nuovo principale è 1,99 €.
delete from product_prices where product_id in (select id from products where place_id = '9b000000-0000-0000-0000-0000000000a4');
delete from products where place_id = '9b000000-0000-0000-0000-0000000000a4';
set role authenticated;
set request.jwt.claim.sub = '9b000000-0000-0000-0000-000000000001';
do $$ begin
  if (studio_places_on_sale('zs.sigma') ->> 'created')::int <> 1 then raise exception 'FALLITO S2: la piazza non torna in vendita'; end if;
  if (select pp.unit_amount from product_prices pp join products p on p.id = pp.product_id
      where p.place_id = '9b000000-0000-0000-0000-0000000000a4' and pp.status = 'draft') <> 199 then
    raise exception 'FALLITO S2: prezzo proposto diverso da 1,99 €';
  end if;
end $$;
reset role;
set role anon;
do $$ begin
  if exists (select 1 from jsonb_array_elements(public_catalog('zs.sigma')) x where x ->> 'place' in ('grotta', 'faro')) then
    raise exception 'FALLITO S2: un sottoluogo nel catalogo pubblico';
  end if;
  if not exists (select 1 from jsonb_array_elements(public_catalog('zs.sigma')) x where x ->> 'place' = 'isola') then
    raise exception 'FALLITO S2: l''isola non è nel catalogo pubblico';
  end if;
end $$;
reset role;
-- Un sottoluogo non si compra (prodotto ritirato).
set role authenticated;
set request.jwt.claim.sub = '9b000000-0000-0000-0000-000000000003';
do $$ begin
  perform checkout_open((select id from products where place_id = '9b000000-0000-0000-0000-0000000000a3' order by status = 'retired' desc limit 1));
  raise exception 'FALLITO S2: comprato un sottoluogo';
exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end $$;
reset role;

-- ---------------------------------------------------------------- S3: file a pagamento
insert into storage.objects (bucket_id, name, owner) values
  ('premium', 'zs.sigma/it/9b000000-0000-0000-0000-0000000000d1/place-isola.aaaaaaaaaaaaaaaa.json', null),
  ('premium', 'zs.sigma/it/9b000000-0000-0000-0000-0000000000d1/place-piazza.bbbbbbbbbbbbbbbb.json', null);
create function pg_temp.visible_s(p_user text) returns text[] language plpgsql as $$
declare v text[];
begin
  perform set_config('request.jwt.claim.sub', p_user, true);
  execute 'set local role authenticated';
  select coalesce(array_agg(split_part(split_part(name, '/', 4), '.', 1) order by name), '{}') into v
  from storage.objects where bucket_id = 'premium' and name like 'zs.sigma/%';
  execute 'reset role';
  return v;
end $$;
do $$ begin
  -- Comprata la grotta quando era a sé: ora riceve il file dell'isola (che la contiene), non quello della piazza.
  if pg_temp.visible_s('9b000000-0000-0000-0000-000000000002') <> '{place-isola}' then
    raise exception 'FALLITO S3: chi aveva comprato la grotta vede %', pg_temp.visible_s('9b000000-0000-0000-0000-000000000002');
  end if;
  if pg_temp.visible_s('9b000000-0000-0000-0000-000000000003') <> '{}' then
    raise exception 'FALLITO S3: chi non ha comprato vede %', pg_temp.visible_s('9b000000-0000-0000-0000-000000000003');
  end if;
end $$;
-- Chi compra l'isola vede l'isola, non la piazza.
select grant_product('9b000000-0000-0000-0000-000000000003',
  (select id from products where place_id = '9b000000-0000-0000-0000-0000000000a1' and status = 'active'), 'grant', null, 'prova S3');
do $$ begin
  if pg_temp.visible_s('9b000000-0000-0000-0000-000000000003') <> '{place-isola}' then
    raise exception 'FALLITO S3: chi ha l''isola vede %', pg_temp.visible_s('9b000000-0000-0000-0000-000000000003');
  end if;
end $$;

-- ---------------------------------------------------------------- S4: principale gratuito con sottoluoghi a pagamento
-- (20261102000000) L'isola gratuita si vende lo stesso, per i suoi sottoluoghi; la piazza gratuita senza sottoluoghi no.
update packs set config = config || '{"access":{"explore":"premium","introPlaces":[],"freePlaces":["isola","piazza"],"premiumRoutes":[]}}' where id = 'zs.sigma';
do $$ begin
  if catalog_problem_place('zs.sigma', '9b000000-0000-0000-0000-0000000000a1') is not null then
    raise exception 'FALLITO S4: l''isola gratuita con sottoluoghi a pagamento non si vende (%)', catalog_problem_place('zs.sigma', '9b000000-0000-0000-0000-0000000000a1');
  end if;
  if catalog_problem_place('zs.sigma', '9b000000-0000-0000-0000-0000000000a4') is null then
    raise exception 'FALLITO S4: si vende la piazza gratuita senza sottoluoghi';
  end if;
end $$;
-- Gratuiti anche tutti i sottoluoghi: l'isola non ha più niente da sbloccare.
update packs set config = config || '{"access":{"explore":"premium","introPlaces":[],"freePlaces":["isola","grotta","faro"],"premiumRoutes":[]}}' where id = 'zs.sigma';
do $$ begin
  if catalog_problem_place('zs.sigma', '9b000000-0000-0000-0000-0000000000a1') is null then
    raise exception 'FALLITO S4: si vende l''isola gratuita con i sottoluoghi tutti gratuiti';
  end if;
end $$;

-- Pulizia (come amministratore del DB).
delete from storage.objects where bucket_id = 'premium' and name like 'zs.sigma/%';
delete from entitlements where pack_id = 'zs.sigma';
delete from purchases where product_id in (select id from products where pack_id = 'zs.sigma');
delete from product_prices where product_id in (select id from products where pack_id = 'zs.sigma');
delete from products where pack_id = 'zs.sigma';
delete from memberships where user_id::text like '9b000000-%';
delete from node_labels where node_id::text like '9b000000-%';
delete from places where node_id::text like '9b000000-%';
delete from nodes where pack_id in ('zs.sigma', 'zs.tau');
delete from destinations where pack_id in ('zs.sigma', 'zs.tau');
delete from packs where id in ('zs.sigma', 'zs.tau');
delete from organizations where id = '9b000000-0000-0000-0000-00000000000f';
delete from auth.users where id::text like '9b000000-%';
select 'sottoluoghi: S1–S4 superati';
