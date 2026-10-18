-- Test dell'acquisto di un singolo luogo (20261028000000_place_products.sql):
--   L1 si vendono solo i luoghi a pagamento (esplorazione a pagamento, non introduttivi); «Metti in vendita» a 0,50 €;
--   L2 il diritto su un luogo apre solo il file di quel luogo (non altri luoghi, non l'esplorazione, non i percorsi);
--   L3 ordine con la copia del luogo e diritto dal pagamento; L4 il rimborso revoca solo quel luogo;
--   L5 con l'esplorazione tornata gratuita il luogo esce dal catalogo pubblico.
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values ('98000000-0000-0000-0000-00000000000f', 'institution', 'Comune L (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zl.lambda', 'destination', '98000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Lambda"}',
   '{"access":{"explore":"premium","introPlaces":["porta"],"premiumRoutes":["giro"]}}');
insert into destinations (pack_id, status) values ('zl.lambda', 'published');
insert into nodes (id, pack_id, slug, kind) values
  ('98000000-0000-0000-0000-0000000000a1', 'zl.lambda', 'porta', 'place'),
  ('98000000-0000-0000-0000-0000000000a2', 'zl.lambda', 'torre', 'place'),
  ('98000000-0000-0000-0000-0000000000a3', 'zl.lambda', 'chiesa', 'place'),
  ('98000000-0000-0000-0000-0000000000a4', 'zl.lambda', 'vicolo', 'place');
-- Racconti: la porta (introduttiva), la torre e la chiesa; il vicolo non ne ha e non si vende.
insert into narrative_units (pack_id, slug, anchor_node_id, unit_type, locale, duration_s, text) values
  ('zl.lambda', 'porta-apertura', '98000000-0000-0000-0000-0000000000a1', 'opening', 'it', 20, 'Porta.'),
  ('zl.lambda', 'torre-apertura', '98000000-0000-0000-0000-0000000000a2', 'opening', 'it', 20, 'Torre.'),
  ('zl.lambda', 'chiesa-apertura', '98000000-0000-0000-0000-0000000000a3', 'opening', 'it', 20, 'Chiesa.');
insert into node_labels (node_id, locale, name) values
  ('98000000-0000-0000-0000-0000000000a2', 'it', 'Torre'), ('98000000-0000-0000-0000-0000000000a3', 'it', 'Chiesa');
insert into routes (id, pack_id, slug, duration_min, labels) values
  ('98000000-0000-0000-0000-0000000000b1', 'zl.lambda', 'giro', 30, '{"it":{"name":"Giro"}}');
insert into auth.users (id, email, raw_user_meta_data) values
  ('98000000-0000-0000-0000-000000000001', 'admin-l@prova.test', '{}'),
  ('98000000-0000-0000-0000-000000000002', 'cliente-l@prova.test', '{}'),
  ('98000000-0000-0000-0000-000000000003', 'altro-l@prova.test', '{}');
insert into memberships (user_id, organization_id, role) values
  ('98000000-0000-0000-0000-000000000001', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin');

-- ---------------------------------------------------------------- L1: cosa si vende
set role authenticated;
set request.jwt.claim.sub = '98000000-0000-0000-0000-000000000001';
do $$
declare n integer;
begin
  n := studio_places_on_sale('zl.lambda');
  if n <> 2 then raise exception 'FALLITO L1: messi in vendita % luoghi, attesi 2 (torre, chiesa; la porta è introduttiva, il vicolo senza racconti)', n; end if;
  if exists (select 1 from products where kind = 'place' and place_id = '98000000-0000-0000-0000-0000000000a4') then
    raise exception 'FALLITO L1: in vendita un luogo senza racconti';
  end if;
  if studio_places_on_sale('zl.lambda') <> 0 then raise exception 'FALLITO L1: un secondo «Metti in vendita» crea doppioni'; end if;
  if exists (select 1 from products where kind = 'place' and place_id = '98000000-0000-0000-0000-0000000000a1') then
    raise exception 'FALLITO L1: in vendita il luogo introduttivo (gratuito)';
  end if;
  if (select array_agg(distinct pp.unit_amount) from product_prices pp join products p on p.id = pp.product_id
      where p.pack_id = 'zl.lambda' and pp.status = 'draft') <> '{50}' then
    raise exception 'FALLITO L1: prezzo proposto diverso da 0,50 €';
  end if;
  begin
    perform studio_places_on_sale('zl.lambda', 19);
    raise exception 'FALLITO L1: accettato un prezzo sotto 0,50 €';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Un prodotto per il luogo introduttivo, anche scritto a mano dall'API, non si attiva.
  begin
    insert into products (slug, kind, pack_id, place_id, status) values ('zl-porta', 'place', 'zl.lambda', '98000000-0000-0000-0000-0000000000a1', 'active');
    raise exception 'FALLITO L1: attivato il prodotto del luogo introduttivo';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  perform studio_prices_publish('zl.lambda');
end $$;
reset role;
set role anon;
do $$ begin
  if (select count(*) from jsonb_array_elements(public_catalog('zl.lambda')) x where x ->> 'kind' = 'place') <> 2 then
    raise exception 'FALLITO L1: il catalogo pubblico non elenca i due luoghi';
  end if;
  if not exists (select 1 from jsonb_array_elements(public_catalog('zl.lambda')) x where x ->> 'place' = 'torre' and (x #>> '{price,amount}')::int = 50) then
    raise exception 'FALLITO L1: la torre non è in vendita a 0,50 €';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------- L3: ordine e pagamento
set role authenticated;
set request.jwt.claim.sub = '98000000-0000-0000-0000-000000000002';
do $$
declare o jsonb;
begin
  o := checkout_open((select id from products where place_id = '98000000-0000-0000-0000-0000000000a2' and status = 'active'));
  perform set_config('test.ordine', o ->> 'order', false);
end $$;
reset role;
do $$ begin
  if (select product_snapshot #>> '{place,slug}' from purchases where id = current_setting('test.ordine')::uuid) <> 'torre' then
    raise exception 'FALLITO L3: l''ordine non copia il luogo';
  end if;
  update purchases set status = 'completed' where id = current_setting('test.ordine')::uuid;
  if grant_order(current_setting('test.ordine')::uuid) <> 1 then raise exception 'FALLITO L3: nessun diritto dal pagamento'; end if;
  if grant_order(current_setting('test.ordine')::uuid) <> 0 then raise exception 'FALLITO L3: diritto concesso due volte'; end if;
end $$;
-- Un secondo acquisto dello stesso cliente: la chiesa (per L4).
insert into purchases (id, user_id, product_id, provider, provider_ref, status) values
  ('98000000-0000-0000-0000-0000000000c3', '98000000-0000-0000-0000-000000000002',
   (select id from products where place_id = '98000000-0000-0000-0000-0000000000a3' and status = 'active'), 'test', 'l3', 'completed');
select grant_product('98000000-0000-0000-0000-000000000002',
  (select id from products where place_id = '98000000-0000-0000-0000-0000000000a3' and status = 'active'), 'purchase', '98000000-0000-0000-0000-0000000000c3');

-- ---------------------------------------------------------------- L2: il diritto apre solo quel luogo
insert into storage.objects (bucket_id, name, owner) values
  ('premium', 'zl.lambda/it/98000000-0000-0000-0000-0000000000d1/explore.aaaaaaaaaaaaaaaa.json', null),
  ('premium', 'zl.lambda/it/98000000-0000-0000-0000-0000000000d1/route-giro.bbbbbbbbbbbbbbbb.json', null),
  ('premium', 'zl.lambda/it/98000000-0000-0000-0000-0000000000d1/place-torre.cccccccccccccccc.json', null),
  ('premium', 'zl.lambda/it/98000000-0000-0000-0000-0000000000d1/place-chiesa.dddddddddddddddd.json', null),
  ('premium', 'zl.lambda/it/98000000-0000-0000-0000-0000000000d1/place-porta.eeeeeeeeeeeeeeee.json', null);
create function pg_temp.visible(p_user text) returns text[] language plpgsql as $$
declare v text[];
begin
  perform set_config('request.jwt.claim.sub', p_user, true);
  execute 'set local role authenticated';
  select coalesce(array_agg(split_part(split_part(name, '/', 4), '.', 1) order by name), '{}') into v
  from storage.objects where bucket_id = 'premium' and name like 'zl.lambda/%';
  execute 'reset role';
  return v;
end $$;
do $$ begin
  if pg_temp.visible('98000000-0000-0000-0000-000000000002') <> '{place-chiesa,place-torre}' then
    raise exception 'FALLITO L2: chi ha comprato torre e chiesa vede %', pg_temp.visible('98000000-0000-0000-0000-000000000002');
  end if;
  if pg_temp.visible('98000000-0000-0000-0000-000000000003') <> '{}' then
    raise exception 'FALLITO L2: chi non ha comprato vede %', pg_temp.visible('98000000-0000-0000-0000-000000000003');
  end if;
end $$;
set role anon;
do $$ begin
  if exists (select 1 from storage.objects where bucket_id = 'premium') then raise exception 'FALLITO L2: un anonimo vede file a pagamento'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------- L4: rimborso di un solo luogo
do $$ begin
  if revoke_purchase(current_setting('test.ordine')::uuid, 'rimborso di prova') <> 1 then raise exception 'FALLITO L4: revoca'; end if;
  if pg_temp.visible('98000000-0000-0000-0000-000000000002') <> '{place-chiesa}' then
    raise exception 'FALLITO L4: dopo il rimborso della torre resta %', pg_temp.visible('98000000-0000-0000-0000-000000000002');
  end if;
end $$;

-- ---------------------------------------------------------------- L5: esplorazione gratuita → i luoghi non si vendono
update packs set config = config || '{"access":{"explore":"free","introPlaces":[],"premiumRoutes":["giro"]}}' where id = 'zl.lambda';
do $$ begin
  if exists (select 1 from jsonb_array_elements(public_catalog('zl.lambda')) x where x ->> 'kind' = 'place') then
    raise exception 'FALLITO L5: luoghi in vendita con l''esplorazione gratuita';
  end if;
end $$;

-- Pulizia (come amministratore del DB).
delete from storage.objects where bucket_id = 'premium' and name like 'zl.lambda/%';
delete from entitlements where pack_id = 'zl.lambda';
delete from purchases where product_id in (select id from products where pack_id = 'zl.lambda');
delete from product_prices where product_id in (select id from products where pack_id = 'zl.lambda');
delete from products where pack_id = 'zl.lambda';
delete from memberships where user_id::text like '98000000-%';
delete from routes where pack_id = 'zl.lambda';
delete from narrative_units where pack_id = 'zl.lambda';
delete from node_labels where node_id::text like '98000000-%';
delete from nodes where pack_id = 'zl.lambda';
delete from destinations where pack_id = 'zl.lambda';
delete from packs where id = 'zl.lambda';
delete from organizations where id = '98000000-0000-0000-0000-00000000000f';
delete from auth.users where id::text like '98000000-%';
select 'luoghi: L1–L5 superati';
