-- Test dell'acquisto progressivo (20261107000000_progressive_purchase.sql):
--   G1 listino centrale: tariffe in bozza, solo l'amministratore le cambia e le pubblica; prezzo proprio prima della
--      tariffa; «Segui il listino»;
--   G2 unità acquistabili (criterio rigoroso): solo dalla pubblicazione in linea, con il file nel bucket e almeno un
--      racconto verificato; mai i gratuiti, mai i contenuti in revisione, mai quelli senza file o di una pubblicazione
--      non riuscita; contenuti singoli in vendita solo nei luoghi con almeno due contenuti;
--   G3 preventivo a conteggio: 2 contenuti su 4 → 1,50 € invece di 2,99 €; mai sopra la somma dei singoli (al prezzo
--      effettivo di ciascun singolo, anche se ha un prezzo proprio); luogo con un solo contenuto al prezzo del singolo;
--      sotto 0,50 € si comprano i singoli; il listino non si pubblica senza la tariffa del contenuto singolo;
--   G4 lo sconto raggiunto non scende quando si aggiungono contenuti;
--   G5 checkout al prezzo del preventivo, copia di listino, sconto e acquisti che hanno contribuito; diritto del luogo;
--   G6 file a pagamento per unità: unit-<luogo> solo con il singolo (chi ha il luogo usa il file del luogo);
--   G7 rimborso di un acquisto che ha contribuito: ordine successivo «da rivedere», nessuna revoca automatica;
--   G8 «Tutte le destinazioni»: diritto senza destinazione, vale anche per l'esplorazione di ciascuna;
--   G9 sicurezza: preventivi di altri utenti e funzioni interne non raggiungibili dall'API.
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values ('9a000000-0000-0000-0000-00000000000f', 'institution', 'Comune G (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zg.alfa', 'destination', '9a000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Alfa"}',
   '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":[],"freePlaces":["lapide"]}}'),
  ('zg.beta', 'destination', '9a000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Beta"}',
   '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":[]}}');
insert into destinations (pack_id, status) values ('zg.alfa', 'published'), ('zg.beta', 'published');
-- Alfa: borgo con torre, chiesa, castello, grotta (racconti solo in revisione), lapide (gratuita) e mura (file non
-- caricato); fezzano (solo la panoramica); palmaria con tino; grazie (nessun sottoluogo).
-- Unità pubblicate: borgo, torre, chiesa, castello · palmaria, tino · grazie = 7. Beta: molo con faro = 2.
insert into nodes (id, pack_id, slug, kind) values
  ('9a000000-0000-0000-0000-0000000000a1', 'zg.alfa', 'borgo', 'place'),
  ('9a000000-0000-0000-0000-0000000000a2', 'zg.alfa', 'torre', 'place'),
  ('9a000000-0000-0000-0000-0000000000a3', 'zg.alfa', 'chiesa', 'place'),
  ('9a000000-0000-0000-0000-0000000000a4', 'zg.alfa', 'castello', 'place'),
  ('9a000000-0000-0000-0000-0000000000a5', 'zg.alfa', 'grotta', 'place'),
  ('9a000000-0000-0000-0000-0000000000a6', 'zg.alfa', 'lapide', 'place'),
  ('9a000000-0000-0000-0000-0000000000a7', 'zg.alfa', 'fezzano', 'place'),
  ('9a000000-0000-0000-0000-0000000000a8', 'zg.alfa', 'palmaria', 'place'),
  ('9a000000-0000-0000-0000-0000000000a9', 'zg.alfa', 'tino', 'place'),
  ('9a000000-0000-0000-0000-0000000000aa', 'zg.alfa', 'grazie', 'place'),
  ('9a000000-0000-0000-0000-0000000000ab', 'zg.alfa', 'mura', 'place'),
  ('9a000000-0000-0000-0000-0000000000b1', 'zg.beta', 'molo', 'place'),
  ('9a000000-0000-0000-0000-0000000000b2', 'zg.beta', 'faro', 'place');
insert into places (node_id, place_kind, location, importance, dwell_min, coordinate_method, part_of_node_id)
select n.id, 'poi', 'SRID=4326;POINT(9.9 44.1)', 3, 10, 'GPS',
       case when n.slug in ('torre', 'chiesa', 'castello', 'grotta', 'lapide', 'mura') then '9a000000-0000-0000-0000-0000000000a1'::uuid
            when n.slug = 'tino' then '9a000000-0000-0000-0000-0000000000a8'::uuid
            when n.slug = 'faro' then '9a000000-0000-0000-0000-0000000000b1'::uuid end
from nodes n where n.pack_id in ('zg.alfa', 'zg.beta');
insert into auth.users (id, email, raw_user_meta_data) values
  ('9a000000-0000-0000-0000-000000000001', 'admin-g@prova.test', '{}'),
  ('9a000000-0000-0000-0000-000000000002', 'cliente-g@prova.test', '{}'),
  ('9a000000-0000-0000-0000-000000000003', 'estraneo-g@prova.test', '{}'),
  ('9a000000-0000-0000-0000-000000000004', 'globale-g@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('9a000000-0000-0000-0000-000000000001', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin', null);

-- Compra un prodotto come farebbero checkout e webhook: apre l'ordine come utente, lo paga come servizio.
create or replace function pg_temp.buy(p_user uuid, p_product uuid) returns uuid language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  set local role authenticated;
  r := checkout_open(p_product);
  reset role;
  set local role service_role;
  perform payment_paid((r ->> 'order')::uuid, 'cs_test_' || replace(r ->> 'order', '-', ''), 'pi_' || replace(r ->> 'order', '-', ''),
                       'cus_g', (r ->> 'amount')::integer, 'eur');
  reset role;
  return (r ->> 'order')::uuid;
end $$;
create or replace function pg_temp.prod(p_kind text, p_slug text) returns uuid language sql as $$
  select p.id from products p join nodes n on n.id = p.place_id
  where p.kind = p_kind and n.slug = p_slug and n.pack_id in ('zg.alfa', 'zg.beta') and p.status = 'active';
$$;
create or replace function pg_temp.quote(p_user uuid, p_product uuid) returns jsonb language sql as $$
  select commerce_quote(p_user, p_product);
$$;


-- Pubblicazione simulata: un bundle «it» con i file «unit» nel manifest (racconti e racconti verificati, come li scrive
-- la pubblicazione dello Studio) e, salvo "upload": false, i file nel bucket «premium».
create or replace function pg_temp.publish(p_pack text, p_files jsonb, p_status text default 'published') returns uuid language plpgsql as $$
declare v_pub uuid := gen_random_uuid(); v_bundle uuid; v_list jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'unit', 'ref', p_pack || ':' || (f ->> 'slug'),
           'path', p_pack || '/it/' || v_pub || '/unit-' || (f ->> 'slug') || '.0123456789abcdef.json',
           'sha256', repeat('0', 64), 'bytes', 10,
           'stories', (f ->> 'stories')::int, 'verifiedStories', (f ->> 'verified')::int)), '[]'::jsonb)
  into v_list from jsonb_array_elements(p_files) f;
  insert into bundles (pack_id, locale, flavor, version, schema_version, min_app_version, kb_hash, manifest, total_bytes, url)
  values (p_pack, 'it', 'full', coalesce((select max(version) from bundles where pack_id = p_pack and locale = 'it' and flavor = 'full'), 0) + 1,
          1, '0.1.0', 'prova', jsonb_build_object('destination', p_pack, 'locale', 'it', 'premium', v_list), 1,
          '/pub/' || p_pack || '/it-full/' || v_pub || '/manifest.json')
  returning id into v_bundle;
  insert into publications (id, pack_id, status, requested_by, bundle_ids, finished_at)
  values (v_pub, p_pack, p_status::publication_status, '9a000000-0000-0000-0000-000000000001', array[v_bundle], clock_timestamp());
  insert into storage.objects (bucket_id, name)
  select 'premium', p_pack || '/it/' || v_pub || '/unit-' || (f ->> 'slug') || '.0123456789abcdef.json'
  from jsonb_array_elements(p_files) f where coalesce((f ->> 'upload')::boolean, true);
  return v_pub;
end $$;
-- File «unit» della pubblicazione in linea.
create or replace function pg_temp.unitfile(p_pack text, p_slug text) returns text language sql as $$
  select e ->> 'path' from publications p join bundles b on b.id = any (p.bundle_ids)
  cross join lateral jsonb_array_elements(b.manifest -> 'premium') e
  where p.pack_id = p_pack and p.status = 'published' and e ->> 'ref' = p_pack || ':' || p_slug
  order by p.finished_at desc limit 1;
$$;
create or replace function pg_temp.alfa(p_with_mura boolean) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('slug', 'borgo', 'stories', 2, 'verified', 2),
    jsonb_build_object('slug', 'torre', 'stories', 1, 'verified', 1),
    jsonb_build_object('slug', 'chiesa', 'stories', 1, 'verified', 1),
    jsonb_build_object('slug', 'castello', 'stories', 2, 'verified', 1),
    jsonb_build_object('slug', 'grotta', 'stories', 2, 'verified', 0),
    jsonb_build_object('slug', 'lapide', 'stories', 1, 'verified', 1),
    jsonb_build_object('slug', 'fezzano', 'stories', 0, 'verified', 0),
    jsonb_build_object('slug', 'palmaria', 'stories', 1, 'verified', 1),
    jsonb_build_object('slug', 'tino', 'stories', 1, 'verified', 1),
    jsonb_build_object('slug', 'grazie', 'stories', 1, 'verified', 1),
    jsonb_build_object('slug', 'mura', 'stories', 1, 'verified', 1, 'upload', p_with_mura));
$$;

-- ---------------------------------------------------------------- G1: listino
do $$ begin
  if (select count(*) from price_tiers where status = 'draft') <> 4 or exists (select 1 from price_tiers where status <> 'draft') then
    raise exception 'FALLITO G1: le tariffe proposte devono nascere in bozza';
  end if;
  if (select string_agg(kind || '=' || unit_amount, ',' order by unit_amount) from price_tiers) <> 'unit=99,place=299,explore=999,all=1999' then
    raise exception 'FALLITO G1: tariffe proposte diverse da 0,99 / 2,99 / 9,99 / 19,99';
  end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000003';
do $$ begin
  begin perform studio_price_tier_draft('unit', 50); raise exception 'FALLITO G1: un estraneo cambia il listino';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin perform studio_price_tiers_publish(); raise exception 'FALLITO G1: un estraneo pubblica il listino';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin insert into price_tiers (kind, unit_amount) values ('unit', 50); raise exception 'FALLITO G1: un estraneo scrive una tariffa';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin perform studio_commerce(); raise exception 'FALLITO G1: un estraneo legge gli ordini da rivedere';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000001';
do $$ begin
  begin perform studio_price_tier_draft('unit', 49); raise exception 'FALLITO G1: tariffa sotto 0,50 €';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Senza la tariffa del contenuto singolo il listino non si pubblica (serve al tetto dei pacchetti).
  perform studio_price_tier_draft('unit', null);
  begin perform studio_price_tiers_publish(); raise exception 'FALLITO G1: listino pubblicato senza la tariffa del singolo';
  exception when others then
    if sqlerrm like 'FALLITO%' then raise; end if;
    if sqlerrm not like '%contenuto singolo%' then raise exception 'FALLITO G1: messaggio %', sqlerrm; end if;
  end;
  if exists (select 1 from price_tiers where status <> 'draft') then raise exception 'FALLITO G1: pubblicazione parziale del listino'; end if;
  perform studio_price_tier_draft('unit', 99);
  if studio_price_tiers_publish() <> 4 then raise exception 'FALLITO G1: pubblicazione del listino'; end if;
  if (studio_commerce() -> 'tiers' -> 1 #>> '{published,amount}') <> '299' then raise exception 'FALLITO G1: listino nello Studio'; end if;
  begin update price_tiers set unit_amount = 100 where kind = 'unit' and status = 'published';
    raise exception 'FALLITO G1: cambiato l''importo di una tariffa pubblicata';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- I luoghi principali in vendita come prima (prezzo proprio 1,99 €), poi borgo, palmaria e grazie seguono il listino.
  perform studio_places_on_sale('zg.alfa');
  perform studio_places_on_sale('zg.beta');
  perform studio_prices_publish('zg.alfa');
  perform studio_prices_publish('zg.beta');
end $$;
reset role;
do $$ begin
  if (select amount from product_list_price(pg_temp.prod('place', 'borgo'))) <> 199 then
    raise exception 'FALLITO G1: il prezzo proprio pubblicato deve restare (compatibilità)';
  end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000001';
do $$
declare s text;
begin
  foreach s in array array['borgo', 'palmaria', 'grazie'] loop perform studio_product_follow_tier(pg_temp.prod('place', s)); end loop;
  perform studio_product_follow_tier(pg_temp.prod('place', 'molo'));
end $$;
reset role;
do $$ begin
  if (select amount from product_list_price(pg_temp.prod('place', 'borgo'))) <> 299
     or (select tier_id from product_list_price(pg_temp.prod('place', 'borgo'))) is null then
    raise exception 'FALLITO G1: «Segui il listino» non porta alla tariffa';
  end if;
  if (select amount from product_list_price(pg_temp.prod('place', 'fezzano'))) <> 199 then raise exception 'FALLITO G1: fezzano cambiato'; end if;
  if exists (select 1 from product_prices where product_id = pg_temp.prod('place', 'borgo') and status = 'published') then
    raise exception 'FALLITO G1: il prezzo proprio di borgo non è in archivio';
  end if;
end $$;

-- ---------------------------------------------------------------- G2: unità
do $$
declare v text;
begin
  -- Prima di qualsiasi pubblicazione: nessuna unità (niente sconti, i pacchetti costano il listino).
  if exists (select 1 from commerce_units('zg.alfa')) then raise exception 'FALLITO G2: unità senza pubblicazione'; end if;
  perform pg_temp.publish('zg.alfa', pg_temp.alfa(false));
  perform pg_temp.publish('zg.beta', '[{"slug":"molo","stories":1,"verified":1},{"slug":"faro","stories":1,"verified":1}]');
  -- Una pubblicazione successiva non riuscita non conta, anche se dichiara più contenuti.
  perform pg_temp.publish('zg.alfa', '[{"slug":"grotta","stories":2,"verified":2},{"slug":"mura","stories":1,"verified":1}]', 'failed');
  select string_agg(n.slug, ',' order by n.slug) into v from commerce_units('zg.alfa') u join nodes n on n.id = u.node_id;
  if v <> 'borgo,castello,chiesa,grazie,palmaria,tino,torre' then raise exception 'FALLITO G2: unità di Alfa %', v; end if;
  if (select count(*) from commerce_scope_units('place', 'zg.alfa', '9a000000-0000-0000-0000-0000000000a1')) <> 4 then
    raise exception 'FALLITO G2: il borgo ha 4 unità';
  end if;
  if catalog_problem_unit('zg.alfa', '9a000000-0000-0000-0000-0000000000aa') is null then
    raise exception 'FALLITO G2: grazie ha un solo contenuto: non si vende il singolo';
  end if;
  if catalog_problem_unit('zg.alfa', '9a000000-0000-0000-0000-0000000000a6') is null then
    raise exception 'FALLITO G2: la lapide è gratuita';
  end if;
  if catalog_problem_unit('zg.alfa', '9a000000-0000-0000-0000-0000000000a5') not like '%verificati%' then
    raise exception 'FALLITO G2: la grotta (solo racconti in revisione) non si vende';
  end if;
  if exists (select 1 from commerce_units('zg.alfa') u where u.node_id = '9a000000-0000-0000-0000-0000000000ab') then
    raise exception 'FALLITO G2: le mura senza file nel bucket non contano';
  end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000001';
do $$
declare r jsonb;
begin
  r := studio_units_on_sale('zg.alfa');
  if (r ->> 'created')::int <> 6 then raise exception 'FALLITO G2: contenuti singoli creati %', r; end if;
  if (studio_units_on_sale('zg.alfa') ->> 'created')::int <> 0 then raise exception 'FALLITO G2: seconda messa in vendita non idempotente'; end if;
  perform studio_units_on_sale('zg.beta');
  -- Il singolo di un luogo con un solo contenuto non si attiva nemmeno a mano.
  begin
    insert into products (slug, kind, pack_id, place_id, status) values ('zg-grazie-x', 'unit', 'zg.alfa', '9a000000-0000-0000-0000-0000000000aa', 'active');
    raise exception 'FALLITO G2: attivato il singolo di grazie';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  if (select (x ->> 'units')::int from jsonb_array_elements(studio_catalog('zg.alfa') -> 'places') x where x ->> 'slug' = 'borgo') <> 4 then
    raise exception 'FALLITO G2: il catalogo dello Studio non conta le unità del borgo';
  end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from jsonb_array_elements(public_catalog('zg.alfa')) x where x ->> 'kind' = 'unit') <> 6 then
    raise exception 'FALLITO G2: catalogo pubblico senza i contenuti singoli';
  end if;
  if (select x #>> '{price,amount}' from jsonb_array_elements(public_catalog('zg.alfa')) x where x ->> 'kind' = 'unit' and x ->> 'place' = 'torre') <> '99'
     or (select x ->> 'principal' from jsonb_array_elements(public_catalog('zg.alfa')) x where x ->> 'kind' = 'unit' and x ->> 'place' = 'torre') <> 'borgo' then
    raise exception 'FALLITO G2: il singolo della torre nel catalogo pubblico';
  end if;
  if (select x ->> 'units' from jsonb_array_elements(public_catalog('zg.alfa')) x where x ->> 'kind' = 'place' and x ->> 'place' = 'borgo') <> '4' then
    raise exception 'FALLITO G2: il catalogo pubblico non dice quanti contenuti ha il borgo';
  end if;
end $$;

-- Tetto dei singoli al prezzo effettivo di ciascuno: Palmaria (palmaria + tino) per chi non ha nulla costa
-- 0,99 + 0,99 = 1,98 € (sotto 2,99 €); con il singolo di tino a 0,60 € (prezzo proprio) 1,59 €; poi tino torna al listino.
do $$ begin
  if (pg_temp.quote('9a000000-0000-0000-0000-000000000003', pg_temp.prod('place', 'palmaria')) ->> 'amount')::int <> 198 then
    raise exception 'FALLITO G3: tetto dei singoli su Palmaria %', pg_temp.quote('9a000000-0000-0000-0000-000000000003', pg_temp.prod('place', 'palmaria'));
  end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000001';
do $$ begin
  perform studio_price_draft(pg_temp.prod('unit', 'tino'), 60);
  perform studio_prices_publish('zg.alfa');
end $$;
reset role;
do $$ begin
  if (pg_temp.quote('9a000000-0000-0000-0000-000000000003', pg_temp.prod('place', 'palmaria')) ->> 'amount')::int <> 159 then
    raise exception 'FALLITO G3: il tetto non usa il prezzo proprio del singolo %', pg_temp.quote('9a000000-0000-0000-0000-000000000003', pg_temp.prod('place', 'palmaria'));
  end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000001';
do $$ begin perform studio_product_follow_tier(pg_temp.prod('unit', 'tino')); end $$;
reset role;

-- ---------------------------------------------------------------- G3: preventivo
-- Senza acquisti: listino. La cliente compra torre e chiesa (0,99 € ciascuno).
do $$
declare q jsonb; o1 uuid; o2 uuid;
begin
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000002', pg_temp.prod('place', 'borgo'));
  if (q ->> 'amount')::int <> 299 or q ->> 'status' <> 'ok' then raise exception 'FALLITO G3: borgo senza acquisti %', q; end if;
  -- Grazie (un solo contenuto): costa quanto il singolo.
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000002', pg_temp.prod('place', 'grazie'));
  if (q ->> 'amount')::int <> 99 then raise exception 'FALLITO G3: grazie deve costare quanto il singolo (%)', q; end if;
  -- Fezzano (nessuna unità, prezzo proprio): listino pieno, nessuno sconto.
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000002', pg_temp.prod('place', 'fezzano'));
  if (q ->> 'amount')::int <> 199 or (q ->> 'total')::int <> 0 then raise exception 'FALLITO G3: fezzano %', q; end if;
  o1 := pg_temp.buy('9a000000-0000-0000-0000-000000000002', pg_temp.prod('unit', 'torre'));
  o2 := pg_temp.buy('9a000000-0000-0000-0000-000000000002', pg_temp.prod('unit', 'chiesa'));
  if (select unit_amount from purchases where id = o1) <> 99 or (select status from purchases where id = o2) <> 'completed' then
    raise exception 'FALLITO G3: acquisto dei singoli';
  end if;
  if not exists (select 1 from entitlements where purchase_id = o1 and scope = 'unit' and place_id = '9a000000-0000-0000-0000-0000000000a2') then
    raise exception 'FALLITO G3: diritto sul singolo della torre';
  end if;
  if (select progress ->> 'place:9a000000-0000-0000-0000-0000000000a1' from purchases where id = o2) <> '5000' then
    raise exception 'FALLITO G3: avanzamento registrato (%)', (select progress from purchases where id = o2);
  end if;
  -- 2 su 4: 2,99 × 2/4 = 1,495 → 1,50 €.
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000002', pg_temp.prod('place', 'borgo'));
  if (q ->> 'amount')::int <> 150 or (q ->> 'owned')::int <> 2 or (q ->> 'total')::int <> 4 or (q ->> 'list')::int <> 299 then
    raise exception 'FALLITO G3: borgo dopo due singoli %', q;
  end if;
  if not (q -> 'basis' ? o1::text and q -> 'basis' ? o2::text) then raise exception 'FALLITO G3: acquisti che contribuiscono %', q; end if;
  -- Destinazione: 9,99 × 5/7 = 7,14 €, ma i 5 singoli che mancano costano 4,95 €: mai di più.
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000002', (select id from products where kind = 'explore' and pack_id = 'zg.alfa'));
  if q is not null and q ->> 'status' <> 'unpriced' then raise exception 'FALLITO G3: esplorazione senza prodotto (%)', q; end if;
  -- Il singolo già comprato: posseduto.
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000002', pg_temp.prod('unit', 'torre'));
  if q ->> 'status' <> 'owned' then raise exception 'FALLITO G3: torre già comprata %', q; end if;
  -- Chi non ha comprato nulla vede il listino.
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000003', pg_temp.prod('place', 'borgo'));
  if (q ->> 'amount')::int <> 299 then raise exception 'FALLITO G3: estraneo %', q; end if;
end $$;
-- Esplorazione di Alfa: con la tariffa (9,99 €) il tetto dei singoli; con un prezzo proprio basso, sotto 0,50 €.
insert into products (slug, kind, pack_id, labels, status) values ('zg-alfa-esplorazione', 'explore', 'zg.alfa', '{"it":{"name":"Alfa"}}', 'active');
do $$
declare q jsonb;
begin
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000002', (select id from products where slug = 'zg-alfa-esplorazione'));
  if (q ->> 'amount')::int <> 495 or (q ->> 'singles')::int <> 495 then raise exception 'FALLITO G3: tetto dei singoli %', q; end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000001';
do $$ begin
  perform studio_price_draft((select id from products where slug = 'zg-alfa-esplorazione'), 120);
  perform studio_prices_publish('zg.alfa');
end $$;
reset role;
do $$
declare q jsonb;
begin
  -- 1,20 € × 5/7 = 0,86 €: si vende ancora.
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000002', (select id from products where slug = 'zg-alfa-esplorazione'));
  if (q ->> 'amount')::int <> 86 or q ->> 'status' <> 'ok' then raise exception 'FALLITO G3: esplorazione a prezzo proprio %', q; end if;
  perform pg_temp.buy('9a000000-0000-0000-0000-000000000002', pg_temp.prod('unit', 'castello'));
  perform pg_temp.buy('9a000000-0000-0000-0000-000000000002', pg_temp.prod('unit', 'tino'));
  perform pg_temp.buy('9a000000-0000-0000-0000-000000000002', pg_temp.prod('unit', 'palmaria'));
  -- 5 su 7: 1,20 × 2/7 = 0,34 € → sotto il minimo: si comprano i singoli.
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000002', (select id from products where slug = 'zg-alfa-esplorazione'));
  if q ->> 'status' <> 'below_minimum' or (q ->> 'amount')::int <> 34 then raise exception 'FALLITO G3: sotto il minimo %', q; end if;
  -- Palmaria completa con i singoli: il luogo risulta completo.
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000002', pg_temp.prod('place', 'palmaria'));
  if q ->> 'status' <> 'complete' then raise exception 'FALLITO G3: palmaria completa %', q; end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000002';
do $$ begin
  perform checkout_open((select id from products where slug = 'zg-alfa-esplorazione'));
  raise exception 'FALLITO G3: aperto un checkout sotto il minimo';
exception when others then
  if sqlerrm like 'FALLITO%' then raise; end if;
  if sqlerrm not like '%0,50 €%' then raise exception 'FALLITO G3: messaggio sotto il minimo: %', sqlerrm; end if;
end $$;
do $$ begin
  perform checkout_open(pg_temp.prod('place', 'palmaria'));
  raise exception 'FALLITO G3: venduto un luogo già completo';
exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end $$;
reset role;

-- ---------------------------------------------------------------- G4: lo sconto non scende
-- Nuova pubblicazione con le mura (file caricato): 3 su 5 (ora 3 posseduti: torre, chiesa, castello) → 2,99 × 2/5 =
-- 1,20; prima 3 su 4 era il 75%: resta il 75% → 0,75 €.
select pg_temp.publish('zg.alfa', pg_temp.alfa(true)) is not null as ripubblicato;
do $$
declare q jsonb;
begin
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000002', pg_temp.prod('place', 'borgo'));
  if (q ->> 'total')::int <> 5 or (q ->> 'owned')::int <> 3 or (q ->> 'floorBp')::int <> 7500 or (q ->> 'amount')::int <> 75 then
    raise exception 'FALLITO G4: lo sconto raggiunto è sceso %', q;
  end if;
end $$;

-- ---------------------------------------------------------------- G5: checkout del luogo con lo sconto
do $$
declare o uuid; p purchases;
begin
  o := pg_temp.buy('9a000000-0000-0000-0000-000000000002', pg_temp.prod('place', 'borgo'));
  select * into p from purchases where id = o;
  if p.unit_amount <> 75 or p.list_amount <> 299 or p.tier_id is null or p.price_id is not null or p.status <> 'completed' then
    raise exception 'FALLITO G5: ordine del borgo % % % %', p.unit_amount, p.list_amount, p.tier_id, p.status;
  end if;
  if (p.discount ->> 'owned')::int <> 3 or jsonb_array_length(p.discount -> 'basis') <> 3 then
    raise exception 'FALLITO G5: sconto registrato %', p.discount;
  end if;
  if not exists (select 1 from entitlements where purchase_id = o and scope = 'place' and place_id = '9a000000-0000-0000-0000-0000000000a1') then
    raise exception 'FALLITO G5: diritto sul borgo';
  end if;
  if pg_temp.quote('9a000000-0000-0000-0000-000000000002', pg_temp.prod('place', 'borgo')) ->> 'status' <> 'owned' then
    raise exception 'FALLITO G5: borgo non risulta posseduto';
  end if;
  -- Il diritto del luogo copre anche le unità aggiunte dopo (mura) e quelle future.
  if pg_temp.quote('9a000000-0000-0000-0000-000000000002', pg_temp.prod('unit', 'torre')) ->> 'status' <> 'owned' then
    raise exception 'FALLITO G5: torre';
  end if;
end $$;

-- ---------------------------------------------------------------- G6: file per unità
insert into storage.objects (bucket_id, name, owner) values
  ('premium', 'zg.beta/it/9a000000-0000-0000-0000-0000000000f2/explore.0123456789abcdef.json', null);
-- Indirizzi dei file della pubblicazione in linea, letti prima di cambiare ruolo (le pubblicazioni sono della redazione).
create temp table g6 as
  select x.pack, x.slug, pg_temp.unitfile(x.pack, x.slug) as path
  from (values ('zg.alfa', 'torre'), ('zg.alfa', 'mura'), ('zg.alfa', 'grazie'), ('zg.beta', 'faro')) x(pack, slug);
grant select on g6 to authenticated;
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000002';
do $$
declare v text;
begin
  if not premium_object_readable((select path from g6 where slug = 'torre')) then
    raise exception 'FALLITO G6: il singolo della torre non si legge';
  end if;
  if premium_object_readable((select path from g6 where slug = 'mura')) then
    raise exception 'FALLITO G6: le mura arrivano dal file del borgo, non dal singolo';
  end if;
  if premium_object_readable((select path from g6 where slug = 'grazie')) or premium_object_readable((select path from g6 where slug = 'faro')) then
    raise exception 'FALLITO G6: letto un contenuto non comprato';
  end if;
  -- Visibili solo i file dei singoli comprati (di tutte le pubblicazioni).
  select string_agg(distinct substring(name from '/unit-([a-z]+)\.'), ',') into v
  from storage.objects where bucket_id = 'premium' and name like 'zg.%';
  if v is distinct from 'castello,chiesa,palmaria,tino,torre' then raise exception 'FALLITO G6: file visibili alla cliente: %', v; end if;
end $$;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000003';
do $$ begin
  if exists (select 1 from storage.objects where bucket_id = 'premium' and name like 'zg.%') then
    raise exception 'FALLITO G6: un estraneo vede file a pagamento';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------- G7: rimborso di un acquisto che ha contribuito
do $$
declare r jsonb; v_torre uuid; v_borgo uuid;
begin
  select pu.id into v_torre from purchases pu where pu.product_id = pg_temp.prod('unit', 'torre') and pu.status = 'completed';
  select pu.id into v_borgo from purchases pu where pu.product_id = pg_temp.prod('place', 'borgo') and pu.status = 'completed';
  set local role service_role;
  r := payment_refunded((select stripe_payment_intent_id from purchases where id = v_torre), 99);
  reset role;
  if r ->> 'status' <> 'refunded' or (r ->> 'flagged')::int <> 1 then raise exception 'FALLITO G7: rimborso %', r; end if;
  if (select review_reason from purchases where id = v_borgo) is null then raise exception 'FALLITO G7: borgo non da rivedere'; end if;
  -- Nessuna revoca automatica dell'acquisto successivo.
  if not exists (select 1 from entitlements where purchase_id = v_borgo and status = 'active') then
    raise exception 'FALLITO G7: il diritto del borgo è stato revocato';
  end if;
  if exists (select 1 from entitlements where purchase_id = v_torre and status = 'active') then
    raise exception 'FALLITO G7: il diritto del singolo rimborsato è ancora attivo';
  end if;
  -- Lo stesso evento ripetuto non segnala di nuovo.
  set local role service_role;
  r := payment_refunded((select stripe_payment_intent_id from purchases where id = v_torre), 99);
  reset role;
  if (r ->> 'changed')::boolean then raise exception 'FALLITO G7: rimborso ripetuto'; end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000001';
do $$
declare v jsonb;
begin
  v := studio_commerce() -> 'reviews';
  if jsonb_array_length(v) < 1 or not exists (select 1 from jsonb_array_elements(v) x where x ->> 'product' = 'borgo') then
    raise exception 'FALLITO G7: lo Studio non mostra l''ordine da rivedere (%)', v;
  end if;
  perform studio_order_review_done((select x ->> 'id' from jsonb_array_elements(v) x where x ->> 'product' = 'borgo')::uuid);
  if exists (select 1 from jsonb_array_elements(studio_commerce() -> 'reviews') x where x ->> 'product' = 'borgo') then
    raise exception 'FALLITO G7: revisione non chiusa';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------- G8: tutte le destinazioni
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000001';
do $$
declare v uuid;
begin
  v := studio_all_product_set(true);
  if (select status from products where id = v) <> 'active' then raise exception 'FALLITO G8: «Tutte» non in vendita'; end if;
  if studio_all_product_set(true) <> v then raise exception 'FALLITO G8: creato un secondo prodotto «Tutte»'; end if;
  if (studio_commerce() #>> '{all,product,id}')::uuid <> v then raise exception 'FALLITO G8: Studio'; end if;
end $$;
reset role;
do $$
declare q jsonb; v uuid; o uuid; n integer;
begin
  select id into v from products where kind = 'all' and status = 'active';
  if not exists (select 1 from jsonb_array_elements(public_catalog('zg.beta')) x where x ->> 'kind' = 'all') then
    raise exception 'FALLITO G8: «Tutte» non è nel catalogo di Beta';
  end if;
  n := (select count(*) from commerce_scope_units('all', null, null));
  q := pg_temp.quote('9a000000-0000-0000-0000-000000000004', v);
  if (q ->> 'total')::int <> n or (q ->> 'amount')::int <> least(1999, 99 * n) then raise exception 'FALLITO G8: preventivo %', q; end if;
  o := pg_temp.buy('9a000000-0000-0000-0000-000000000004', v);
  if not exists (select 1 from entitlements where purchase_id = o and scope = 'all' and pack_id is null) then
    raise exception 'FALLITO G8: diritto «all»';
  end if;
  if pg_temp.quote('9a000000-0000-0000-0000-000000000004', pg_temp.prod('place', 'molo')) ->> 'status' <> 'owned' then
    raise exception 'FALLITO G8: il molo non risulta posseduto con «Tutte»';
  end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000004';
do $$ begin
  if not has_active_right('explore', 'zg.beta', null) or not can_access_explore('zg.alfa') then
    raise exception 'FALLITO G8: «Tutte» non apre l''esplorazione';
  end if;
  if not premium_object_readable('zg.beta/it/9a000000-0000-0000-0000-0000000000f2/explore.0123456789abcdef.json') then
    raise exception 'FALLITO G8: «Tutte» non apre il file dell''esplorazione di Beta';
  end if;
end $$;

-- ---------------------------------------------------------------- G9: sicurezza
do $$ begin
  begin perform commerce_quote('9a000000-0000-0000-0000-000000000002', (select id from products where kind = 'all' and status = 'active'));
    raise exception 'FALLITO G9: preventivo di un altro utente dall''API';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin perform commerce_coverage('9a000000-0000-0000-0000-000000000002', 'explore', 'zg.alfa', null);
    raise exception 'FALLITO G9: copertura di un altro utente dall''API';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin perform commerce_flag_dependents('9a000000-0000-0000-0000-000000000002', 'x');
    raise exception 'FALLITO G9: segnalazione dall''API';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin update purchases set review_done_at = now(); raise exception 'FALLITO G9: ordini scritti dall''API';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;
-- I propri preventivi sì: la globale ha tutto, la cliente vede le sue unità.
do $$ begin
  if exists (select 1 from jsonb_array_elements(my_commerce_quotes('zg.alfa') -> 'quotes') x where x ->> 'status' not in ('owned', 'complete')) then
    raise exception 'FALLITO G9: con «Tutte» qualcosa resta da comprare (%)', my_commerce_quotes('zg.alfa');
  end if;
end $$;
set request.jwt.claim.sub = '9a000000-0000-0000-0000-000000000002';
do $$
declare v jsonb := my_commerce_quotes('zg.alfa');
begin
  if v -> 'ownedUnits' <> '["borgo", "castello", "chiesa", "mura", "palmaria", "tino", "torre"]' then
    raise exception 'FALLITO G9: unità della cliente %', v -> 'ownedUnits';
  end if;
  if (select x ->> 'amount' from jsonb_array_elements(v -> 'quotes') x where x ->> 'kind' = 'place'
      and x ->> 'product' = pg_temp.prod('place', 'grazie')::text) <> '99' then
    raise exception 'FALLITO G9: preventivo di grazie per la cliente';
  end if;
end $$;
reset role;
set role anon;
do $$ begin
  if (my_commerce_quotes('zg.alfa') -> 'quotes') <> '[]' then raise exception 'FALLITO G9: preventivi a un anonimo'; end if;
exception when insufficient_privilege then null; end $$;
do $$ begin
  if jsonb_array_length(public_catalog('zg.alfa')) = 0 then raise exception 'FALLITO G9: catalogo pubblico vuoto per un anonimo'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------- pulizia (come amministratore del DB)
delete from storage.objects where bucket_id = 'premium' and name like 'zg.%';
delete from entitlements where user_id::text like '9a000000-%';
delete from purchases where user_id::text like '9a000000-%';
delete from product_prices where product_id in (select id from products where pack_id in ('zg.alfa', 'zg.beta') or kind = 'all');
delete from products where pack_id in ('zg.alfa', 'zg.beta') or kind = 'all';
-- Il listino torna com'era dopo la migrazione: le quattro tariffe proposte in bozza.
delete from price_tiers;
insert into price_tiers (kind, unit_amount) values ('unit', 99), ('place', 299), ('explore', 999), ('all', 1999);
delete from memberships where user_id::text like '9a000000-%';
delete from publications where pack_id in ('zg.alfa', 'zg.beta');
delete from bundles where pack_id in ('zg.alfa', 'zg.beta');
delete from places where node_id::text like '9a000000-%';
delete from nodes where pack_id in ('zg.alfa', 'zg.beta');
delete from destinations where pack_id in ('zg.alfa', 'zg.beta');
delete from packs where id in ('zg.alfa', 'zg.beta');
delete from organizations where id = '9a000000-0000-0000-0000-00000000000f';
delete from auth.users where id::text like '9a000000-%';
select 'acquisto progressivo: G1–G9 superati';
