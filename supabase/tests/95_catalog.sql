-- Test del catalogo (20261025000000_catalog.sql): solo l'amministratore scrive prodotti e prezzi; un prodotto si
-- attiva solo se vende qualcosa a pagamento; prezzi in bozza e pubblicati, storia immutabile; catalogo pubblico.
\set ON_ERROR_STOP 1

-- ---------------------------------------------------------------- dati di prova (come amministratore del DB)
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zc.cat', 'destination', (select id from organizations where kind = 'platform' order by created_at limit 1), 'it', '{it}', '{"it":"Cat"}',
   '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":["p1","p2"]}}'),
  ('zc.free', 'destination', (select id from organizations where kind = 'platform' order by created_at limit 1), 'it', '{it}', '{"it":"Gratis"}', '{}');
insert into destinations (pack_id) values ('zc.cat'), ('zc.free');
insert into routes (id, pack_id, slug, duration_min, labels) values
  ('95000000-0000-0000-0000-0000000000a1', 'zc.cat', 'p1', 30, '{"it":{"name":"P1"}}'),
  ('95000000-0000-0000-0000-0000000000a2', 'zc.cat', 'p2', 30, '{"it":{"name":"P2"}}'),
  ('95000000-0000-0000-0000-0000000000a3', 'zc.cat', 'p3', 30, '{"it":{"name":"P3, gratuito"}}');
insert into auth.users (id, email, raw_user_meta_data) values
  ('95000000-0000-0000-0000-000000000001', 'admin-catalogo@prova.test', '{}'),
  ('95000000-0000-0000-0000-000000000002', 'editor-catalogo@prova.test', '{}'),
  ('95000000-0000-0000-0000-000000000003', 'cliente-catalogo@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('95000000-0000-0000-0000-000000000001', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin', null),
  ('95000000-0000-0000-0000-000000000002', (select id from organizations where kind = 'platform' order by created_at limit 1), 'territory_editor', 'zc.cat');

create temporary table t95 (k text primary key, v uuid);
grant all on t95 to public;

-- ---------------------------------------------------------------- chi non è amministratore non tocca il catalogo
set role authenticated;
set request.jwt.claim.sub = '95000000-0000-0000-0000-000000000002';
do $$ begin
  begin perform studio_catalog('zc.cat'); raise exception 'FALLITO: un editor legge il catalogo';
  exception when insufficient_privilege then null; end;
  begin perform studio_product_save('zc.cat', '{"kind":"explore","name":{"it":"X"}}'); raise exception 'FALLITO: un editor crea un prodotto';
  exception when insufficient_privilege then null; end;
  begin perform studio_prices_publish('zc.cat'); raise exception 'FALLITO: un editor pubblica i prezzi';
  exception when insufficient_privilege then null; end;
  begin
    insert into products (slug, kind, pack_id, status) values ('zc-abusivo', 'explore', 'zc.cat', 'draft');
    raise exception 'FALLITO: un editor scrive un prodotto con un INSERT diretto';
  exception when insufficient_privilege then null; end;
end $$;

-- ---------------------------------------------------------------- l'amministratore crea e attiva
set request.jwt.claim.sub = '95000000-0000-0000-0000-000000000001';
do $$
declare v_explore uuid; v_route uuid; v_bundle uuid; c jsonb;
begin
  v_explore := studio_product_save('zc.cat', '{"kind":"explore","name":{"it":"Esplorazione di Cat","en":"Cat"},"status":"active"}');
  if (select status from products where id = v_explore) <> 'active' then raise exception 'FALLITO: esplorazione non attivata'; end if;
  begin
    perform studio_product_save('zc.cat', '{"kind":"explore","name":{"it":"Doppione"}}');
    raise exception 'FALLITO: due prodotti per la stessa esplorazione';
  exception when raise_exception then if sqlerrm like 'FALLITO%' or sqlerrm not like '%esiste già%' then raise; end if; end;
  begin
    perform studio_product_save('zc.free', '{"kind":"explore","name":{"it":"Gratis"},"status":"active"}');
    raise exception 'FALLITO: attivata la vendita di un''esplorazione gratuita';
  exception when raise_exception then if sqlerrm like 'FALLITO%' or sqlerrm not like 'non si attiva%' then raise; end if; end;
  begin
    perform studio_product_save('zc.cat', '{"kind":"route","route":"p3","name":{"it":"P3"},"status":"active"}');
    raise exception 'FALLITO: attivata la vendita di un percorso gratuito';
  exception when raise_exception then if sqlerrm like 'FALLITO%' or sqlerrm not like 'non si attiva%' then raise; end if; end;
  v_route := studio_product_save('zc.cat', '{"kind":"route","route":"p1","name":{"it":"Percorso P1"},"status":"active"}');
  begin
    perform studio_product_save('zc.cat', '{"kind":"bundle","routes":["p1","p3"],"name":{"it":"Misto"},"status":"active"}');
    raise exception 'FALLITO: attivato un pacchetto con un percorso gratuito';
  exception when raise_exception then if sqlerrm like 'FALLITO%' or sqlerrm not like 'non si attiva%' then raise; end if; end;
  v_bundle := studio_product_save('zc.cat', '{"kind":"bundle","routes":["p1","p2"],"name":{"it":"Tutti i percorsi"},"status":"active"}');
  if (select count(*) from product_routes where product_id = v_bundle) <> 2 then raise exception 'FALLITO: percorsi del pacchetto'; end if;
  begin
    perform studio_product_save('zc.cat', '{"kind":"explore","name":{"it":""}}');
    raise exception 'FALLITO: prodotto senza nome';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  insert into t95 values ('explore', v_explore), ('route', v_route), ('bundle', v_bundle);
  c := studio_catalog('zc.cat');
  -- I salvataggi rifiutati non lasciano bozze a metà: restano esplorazione, percorso P1 e pacchetto.
  if jsonb_array_length(c -> 'products') <> 3 then raise exception 'FALLITO: il catalogo dello Studio ha % prodotti', jsonb_array_length(c -> 'products'); end if;
end $$;

-- Attivazione diretta dall'API di un prodotto che non vende nulla: rifiutata anche senza lo Studio.
do $$ begin
  -- In bozza un pacchetto misto si può preparare; attivarlo no.
  perform studio_product_save('zc.cat', '{"kind":"bundle","routes":["p1","p3"],"name":{"it":"Misto"}}');
  begin
    update products set status = 'active' where pack_id = 'zc.cat' and kind = 'bundle' and status = 'draft';
    if not found then raise exception 'FALLITO: nessun pacchetto in bozza da provare'; end if;
    raise exception 'FALLITO: attivato con un UPDATE diretto un pacchetto con un percorso gratuito';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    insert into products (slug, kind, pack_id, route_id, status) values ('zc-diretto', 'route', 'zc.cat', '95000000-0000-0000-0000-0000000000a3', 'active');
    raise exception 'FALLITO: venduto un percorso gratuito con un INSERT diretto';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    insert into products (slug, kind, pack_id, status) values ('zc-vuoto', 'bundle', 'zc.cat', 'active');
    raise exception 'FALLITO: pacchetto vuoto creato già attivo con un INSERT diretto';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;

-- ---------------------------------------------------------------- prezzi: bozza, limiti, pubblicazione, storia
do $$
declare v_id uuid := (select t.v from t95 t where t.k = 'explore'); n int;
begin
  begin perform studio_price_draft(v_id, 49); raise exception 'FALLITO: prezzo sotto 0,50 €';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin perform studio_price_draft(v_id, 99901); raise exception 'FALLITO: prezzo sopra 999 €';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  perform studio_price_draft(v_id, 450);
  perform studio_price_draft(v_id, 499);   -- la bozza si corregge, non si duplica
  if (select count(*) from product_prices where product_id = v_id) <> 1 then raise exception 'FALLITO: bozza duplicata'; end if;
  perform studio_price_draft((select t.v from t95 t where t.k = 'route'), 299);
  if jsonb_array_length(public_catalog('zc.cat')) <> 0 then raise exception 'FALLITO: una bozza è già nel catalogo pubblico'; end if;
  n := studio_prices_publish('zc.cat');
  if n <> 2 then raise exception 'FALLITO: pubblicati % prezzi invece di 2', n; end if;
  begin perform studio_prices_publish('zc.cat'); raise exception 'FALLITO: pubblicazione senza bozze';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Nuovo prezzo: il pubblicato resta finché non si pubblica, poi va in archivio.
  perform studio_price_draft(v_id, 599);
  if (select unit_amount from product_prices where product_id = v_id and status = 'published') <> 499 then raise exception 'FALLITO: la bozza ha cambiato il prezzo pubblicato'; end if;
  perform studio_prices_publish('zc.cat');
  if (select string_agg(status || ':' || unit_amount, ',' order by unit_amount) from product_prices where product_id = v_id) <> 'archived:499,published:599' then
    raise exception 'FALLITO: storia dei prezzi %', (select string_agg(status || ':' || unit_amount, ',' order by unit_amount) from product_prices where product_id = v_id);
  end if;
  -- La storia non si riscrive, nemmeno dall'amministratore con richieste dirette.
  begin
    update product_prices set unit_amount = 1 where product_id = v_id and status = 'published';
    raise exception 'FALLITO: cambiato l''importo di un prezzo pubblicato';
  exception when raise_exception or check_violation then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    update product_prices set status = 'published', archived_at = null where product_id = v_id and status = 'archived';
    raise exception 'FALLITO: un prezzo archiviato torna pubblicato';
  exception when raise_exception or check_violation or unique_violation then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    delete from product_prices where product_id = v_id and status = 'archived';
    raise exception 'FALLITO: eliminato un prezzo archiviato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    insert into product_prices (product_id, unit_amount, status, published_at) values (v_id, 100, 'published', now());
    raise exception 'FALLITO: prezzo inserito già pubblicato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;

-- ---------------------------------------------------------------- catalogo pubblico, senza account
reset role;
set role anon;
set request.jwt.claim.sub = '';
do $$
declare c jsonb := public_catalog('zc.cat');
begin
  if jsonb_array_length(c) <> 2 then raise exception 'FALLITO: catalogo pubblico con % prodotti invece di 2 (esplorazione e percorso con prezzo)', jsonb_array_length(c); end if;
  if (select (e -> 'price' ->> 'amount')::int from jsonb_array_elements(c) e where e ->> 'kind' = 'explore') <> 599 then
    raise exception 'FALLITO: prezzo pubblico dell''esplorazione';
  end if;
  if (select count(*) from product_prices where status <> 'published') <> 0 then raise exception 'FALLITO: un anonimo legge bozze o archivio'; end if;
  begin
    perform studio_catalog('zc.cat');
    raise exception 'FALLITO: un anonimo usa le funzioni dello Studio';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Nascosto: fuori dal catalogo; esaurito: visibile ma non acquistabile; accesso tornato gratuito: fuori.
update products set availability = 'hidden' where id = (select v from t95 where k = 'route');
update products set availability = 'sold_out' where id = (select v from t95 where k = 'explore');
do $$
declare c jsonb := public_catalog('zc.cat');
begin
  if jsonb_array_length(c) <> 1 or (c -> 0 ->> 'available')::boolean then raise exception 'FALLITO: nascosto o esaurito: %', c; end if;
end $$;
update packs set config = jsonb_set(config, '{access,explore}', '"free"') where id = 'zc.cat';
do $$ begin
  if jsonb_array_length(public_catalog('zc.cat')) <> 0 then raise exception 'FALLITO: in vendita un''esplorazione tornata gratuita'; end if;
end $$;

-- ---------------------------------------------------------------- ritiro ed eliminazione
set role authenticated;
set request.jwt.claim.sub = '95000000-0000-0000-0000-000000000001';
do $$
declare v_id uuid := (select t.v from t95 t where t.k = 'route');
begin
  perform studio_product_save('zc.cat', jsonb_build_object('id', v_id, 'name', '{"it":"Percorso P1"}'::jsonb, 'status', 'retired'));
  begin
    perform studio_product_save('zc.cat', jsonb_build_object('id', v_id, 'name', '{"it":"Percorso P1"}'::jsonb, 'status', 'active'));
    raise exception 'FALLITO: riattivato un prodotto ritirato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Ritirato il vecchio, se ne può creare uno nuovo per lo stesso percorso.
  perform studio_product_save('zc.cat', '{"kind":"route","route":"p1","name":{"it":"Percorso P1, nuovo"}}');
end $$;
reset role;
insert into purchases (user_id, product_id, provider, provider_ref, status)
values ('95000000-0000-0000-0000-000000000003', (select v from t95 where k = 'bundle'), 'test', 'catalogo-1', 'completed');
set role authenticated;
set request.jwt.claim.sub = '95000000-0000-0000-0000-000000000001';
do $$ begin
  begin
    delete from products where id = (select v from t95 where k = 'bundle');
    raise exception 'FALLITO: eliminato un prodotto con ordini';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  if ((studio_catalog('zc.cat') -> 'products') @> jsonb_build_array(jsonb_build_object('id', (select v from t95 where k = 'bundle'), 'paidOrders', 1))) is not true then
    raise exception 'FALLITO: ordini pagati non contati nel catalogo dello Studio';
  end if;
end $$;
reset role;

-- Pulizia dei dati di prova (la revoca della migrazione, provata dopo i test, si ferma se restano prezzi pubblicati).
delete from purchases where product_id in (select id from products where pack_id in ('zc.cat', 'zc.free'));
delete from products where pack_id in ('zc.cat', 'zc.free');
delete from memberships where user_id in ('95000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000002');
delete from routes where pack_id in ('zc.cat', 'zc.free');
delete from destinations where pack_id in ('zc.cat', 'zc.free');
delete from packs where id in ('zc.cat', 'zc.free');
delete from auth.users where id::text like '95000000-%';

select 'catalogo: tutti i controlli superati';
