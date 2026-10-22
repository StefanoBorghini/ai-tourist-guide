-- Test degli ordini e dei pagamenti (20261026000000_orders.sql): checkout con la copia del prezzo, nessuna scrittura
-- diretta, webhook idempotente e monotono, diritti dalla copia nell'ordine, rimborsi e contestazioni (D2).
\set ON_ERROR_STOP 1

-- ---------------------------------------------------------------- dati di prova (come amministratore del DB)
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zo.ord', 'destination', (select id from organizations where kind = 'platform' order by created_at limit 1), 'it', '{it}', '{"it":"Ord"}',
   '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":["r1","r2"]}}'),
  ('zo.bozza', 'destination', (select id from organizations where kind = 'platform' order by created_at limit 1), 'it', '{it}', '{"it":"Bozza"}',
   '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":[]}}');
insert into destinations (pack_id, status) values ('zo.ord', 'published'), ('zo.bozza', 'draft');
insert into routes (id, pack_id, slug, duration_min, labels) values
  ('96000000-0000-0000-0000-0000000000a1', 'zo.ord', 'r1', 30, '{"it":{"name":"R1"}}'),
  ('96000000-0000-0000-0000-0000000000a2', 'zo.ord', 'r2', 30, '{"it":{"name":"R2"}}');
insert into products (id, slug, kind, pack_id, route_id, labels, status) values
  ('96000000-0000-0000-0000-0000000000e1', 'zo-esplora', 'explore', 'zo.ord', null, '{"it":{"name":"Esplorazione Ord"}}', 'active'),
  ('96000000-0000-0000-0000-0000000000e2', 'zo-r1', 'route', 'zo.ord', '96000000-0000-0000-0000-0000000000a1', '{"it":{"name":"Percorso R1"}}', 'active'),
  ('96000000-0000-0000-0000-0000000000e3', 'zo-tutti', 'bundle', 'zo.ord', null, '{"it":{"name":"Tutti i percorsi"}}', 'draft'),
  ('96000000-0000-0000-0000-0000000000e4', 'zo-bozza', 'explore', 'zo.bozza', null, '{"it":{"name":"Destinazione in bozza"}}', 'active');
insert into product_routes (product_id, route_id) values
  ('96000000-0000-0000-0000-0000000000e3', '96000000-0000-0000-0000-0000000000a1'),
  ('96000000-0000-0000-0000-0000000000e3', '96000000-0000-0000-0000-0000000000a2');
update products set status = 'active' where id = '96000000-0000-0000-0000-0000000000e3';
insert into product_prices (product_id, unit_amount, status) values
  ('96000000-0000-0000-0000-0000000000e1', 499, 'draft'), ('96000000-0000-0000-0000-0000000000e2', 299, 'draft'),
  ('96000000-0000-0000-0000-0000000000e3', 799, 'draft'), ('96000000-0000-0000-0000-0000000000e4', 199, 'draft');
update product_prices set status = 'published', published_at = now()
where product_id::text like '96000000-%';
insert into auth.users (id, email, raw_user_meta_data) values
  ('96000000-0000-0000-0000-000000000001', 'admin-ordini@prova.test', '{}'),
  ('96000000-0000-0000-0000-000000000002', 'cliente-a@prova.test', '{}'),
  ('96000000-0000-0000-0000-000000000003', 'cliente-b@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('96000000-0000-0000-0000-000000000001', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin', null);

create temporary table t96 (k text primary key, v uuid);
grant all on t96 to public;

-- ---------------------------------------------------------------- senza account: niente checkout
set role anon;
set request.jwt.claim.sub = '';
do $$ begin
  begin perform checkout_open('96000000-0000-0000-0000-0000000000e1'); raise exception 'FALLITO: un anonimo apre un checkout';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- cliente A: apertura, copia del prezzo, nessuna scrittura diretta
set role authenticated;
set request.jwt.claim.sub = '96000000-0000-0000-0000-000000000002';
do $$
declare r jsonb; r2 jsonb; o purchases;
begin
  r := checkout_open('96000000-0000-0000-0000-0000000000e1');
  if (r ->> 'amount')::int <> 499 or r ->> 'currency' <> 'EUR' or r ->> 'name' <> 'Esplorazione Ord' then
    raise exception 'FALLITO: risposta del checkout %', r;
  end if;
  select * into o from purchases where id = (r ->> 'order')::uuid;
  if o.status <> 'pending' or o.unit_amount <> 499 or o.product_snapshot ->> 'pack' <> 'zo.ord' or o.user_id <> auth.uid() then
    raise exception 'FALLITO: ordine creato male';
  end if;
  begin perform checkout_attach((r ->> 'order')::uuid, 'non-una-sessione'); raise exception 'FALLITO: sessione non valida accettata';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  perform checkout_attach((r ->> 'order')::uuid, 'cs_test_ordineA1');
  begin perform checkout_attach((r ->> 'order')::uuid, 'cs_test_altra'); raise exception 'FALLITO: sessione ricollegata';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Secondo checkout dello stesso prodotto (doppio clic): il primo si chiude e la sua sessione va fatta scadere.
  r2 := checkout_open('96000000-0000-0000-0000-0000000000e1');
  if r2 -> 'supersede' <> '["cs_test_ordineA1"]'::jsonb then raise exception 'FALLITO: sessioni da far scadere %', r2 -> 'supersede'; end if;
  if (select status from purchases where id = (r ->> 'order')::uuid) <> 'canceled' then raise exception 'FALLITO: primo ordine ancora aperto'; end if;
  perform checkout_attach((r2 ->> 'order')::uuid, 'cs_test_ordineA2');
  insert into t96 values ('a1', (r ->> 'order')::uuid), ('a2', (r2 ->> 'order')::uuid);
  -- Scritture dirette: mai.
  begin
    insert into purchases (user_id, product_id, provider, provider_ref, status) values (auth.uid(), '96000000-0000-0000-0000-0000000000e1', 'stripe', 'x', 'completed');
    raise exception 'FALLITO: un cliente crea un ordine con un INSERT diretto';
  exception when insufficient_privilege then null; end;
  begin
    update purchases set status = 'completed' where id = (r2 ->> 'order')::uuid;
    raise exception 'FALLITO: un cliente segna pagato il proprio ordine';
  exception when insufficient_privilege then null; end;
  begin perform payment_paid((r2 ->> 'order')::uuid, 'cs_test_ordineA2', 'pi_a', 'cus_a', 499, 'eur');
    raise exception 'FALLITO: un cliente chiama le funzioni del webhook';
  exception when insufficient_privilege then null; end;
  begin perform grant_order((r2 ->> 'order')::uuid); raise exception 'FALLITO: un cliente si concede i diritti';
  exception when insufficient_privilege then null; end;
  -- Prodotti non vendibili.
  begin perform checkout_open('96000000-0000-0000-0000-0000000000e4'); raise exception 'FALLITO: venduta una destinazione non pubblicata';
  exception when raise_exception then if sqlerrm not like 'destinazione non ancora pubblicata%' then raise; end if; end;
  begin perform checkout_open('96000000-0000-0000-0000-0000000000ff'); raise exception 'FALLITO: prodotto inesistente';
  exception when raise_exception then if sqlerrm not like 'prodotto non in vendita%' then raise; end if; end;
end $$;
reset role;
update products set availability = 'sold_out' where id = '96000000-0000-0000-0000-0000000000e2';
set role authenticated;
set request.jwt.claim.sub = '96000000-0000-0000-0000-000000000002';
do $$ begin
  begin perform checkout_open('96000000-0000-0000-0000-0000000000e2'); raise exception 'FALLITO: venduto un prodotto esaurito';
  exception when raise_exception then if sqlerrm not like 'prodotto esaurito%' then raise; end if; end;
end $$;
reset role;
update products set availability = 'available' where id = '96000000-0000-0000-0000-0000000000e2';

-- ---------------------------------------------------------------- webhook: idempotenza e macchina a stati
set role service_role;
do $$
declare r jsonb; a2 uuid := (select v from t96 where k = 'a2'); a1 uuid := (select v from t96 where k = 'a1');
begin
  if payment_event_begin('evt_test_1', 'checkout.session.completed') <> 'new' then raise exception 'FALLITO: evento nuovo'; end if;
  if payment_event_begin('evt_test_1', 'checkout.session.completed') <> 'retry' then raise exception 'FALLITO: evento non finito da riprovare'; end if;
  -- Importo diverso da quello dell'ordine: nessun diritto, ordine da verificare.
  r := payment_paid(a2, 'cs_test_ordineA2', 'pi_a', 'cus_a', 1, 'eur');
  if r ->> 'problem' is null or (select status from purchases where id = a2) <> 'pending' then raise exception 'FALLITO: importo diverso accettato %', r; end if;
  -- Sessione di un altro ordine: rifiutata.
  begin perform payment_paid(a2, 'cs_test_ordineA1', 'pi_a', 'cus_a', 499, 'eur'); raise exception 'FALLITO: sessione scambiata';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  r := payment_paid(a2, 'cs_test_ordineA2', 'pi_a', 'cus_a', 499, 'eur');
  if r ->> 'status' <> 'completed' or (r ->> 'granted')::int <> 1 then raise exception 'FALLITO: pagamento %', r; end if;
  perform payment_event_end('evt_test_1', 'processed', a2);
  if payment_event_begin('evt_test_1', 'checkout.session.completed') <> 'done' then raise exception 'FALLITO: evento ripetuto non riconosciuto'; end if;
  -- Ripetuto e fuori ordine: nessun effetto.
  r := payment_paid(a2, 'cs_test_ordineA2', 'pi_a', 'cus_a', 499, 'eur');
  if (r ->> 'changed')::boolean or (r ->> 'granted')::int <> 0 then raise exception 'FALLITO: pagamento ripetuto %', r; end if;
  r := payment_unpaid(a2, 'failed');
  if (r ->> 'changed')::boolean or (select status from purchases where id = a2) <> 'completed' then raise exception 'FALLITO: «failed» dopo il pagamento'; end if;
  r := payment_unpaid(a1, 'expired');
  if (select status from purchases where id = a1) <> 'canceled' then raise exception 'FALLITO: un ordine sostituito è diventato scaduto'; end if;
  if (select count(*) from entitlements where purchase_id = a2) <> 1 then raise exception 'FALLITO: diritti dell''esplorazione'; end if;
end $$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '96000000-0000-0000-0000-000000000002';
do $$ begin
  if not can_access_explore('zo.ord') then raise exception 'FALLITO: esplorazione pagata ma non accessibile'; end if;
  if can_access_route('96000000-0000-0000-0000-0000000000a1') then raise exception 'FALLITO: l''esplorazione sblocca un percorso premium'; end if;
  begin perform checkout_open('96000000-0000-0000-0000-0000000000e1'); raise exception 'FALLITO: ricomprato un prodotto già acquistato';
  exception when raise_exception then if sqlerrm not like 'hai già acquistato%' then raise; end if; end;
  if jsonb_array_length(export_my_data() -> 'purchases') <> 2 then raise exception 'FALLITO: ordini nell''esportazione dei dati'; end if;
end $$;
-- Cliente B: non vede gli ordini di A.
set request.jwt.claim.sub = '96000000-0000-0000-0000-000000000003';
do $$
declare r jsonb;
begin
  if exists (select 1 from purchases where user_id = '96000000-0000-0000-0000-000000000002') then raise exception 'FALLITO: B vede gli ordini di A'; end if;
  if exists (select 1 from entitlements where user_id = '96000000-0000-0000-0000-000000000002') then raise exception 'FALLITO: B vede i diritti di A'; end if;
  if can_access_explore('zo.ord') then raise exception 'FALLITO: B accede senza aver pagato'; end if;
  begin perform checkout_attach((select v from t96 where k = 'a2'), 'cs_test_rubata'); raise exception 'FALLITO: B tocca l''ordine di A';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Pacchetto: la copia nell'ordine vale anche se il pacchetto cambia prima del pagamento.
  r := checkout_open('96000000-0000-0000-0000-0000000000e3');
  if (r ->> 'amount')::int <> 799 then raise exception 'FALLITO: prezzo del pacchetto'; end if;
  perform checkout_attach((r ->> 'order')::uuid, 'cs_test_ordineB1');
  insert into t96 values ('b1', (r ->> 'order')::uuid);
end $$;
reset role;
delete from product_routes where product_id = '96000000-0000-0000-0000-0000000000e3' and route_id = '96000000-0000-0000-0000-0000000000a2';
set role service_role;
do $$
declare r jsonb; b1 uuid := (select v from t96 where k = 'b1');
begin
  r := payment_paid(b1, 'cs_test_ordineB1', 'pi_b', 'cus_b', 799, 'EUR');
  if (r ->> 'granted')::int <> 2 then raise exception 'FALLITO: diritti del pacchetto dalla copia %', r; end if;
  -- Rimborso parziale: nessuna revoca; totale: revoca; ripetuto: nulla.
  r := payment_refunded('pi_b', 100);
  if r ->> 'status' <> 'partially_refunded' or (select count(*) from entitlements where purchase_id = b1 and status = 'active') <> 2 then
    raise exception 'FALLITO: rimborso parziale %', r;
  end if;
  r := payment_refunded('pi_b', 799);
  if r ->> 'status' <> 'refunded' or (r ->> 'revoked')::int <> 2 then raise exception 'FALLITO: rimborso totale %', r; end if;
  r := payment_refunded('pi_b', 799);
  if (r ->> 'changed')::boolean then raise exception 'FALLITO: rimborso ripetuto'; end if;
  -- Un pagamento ripetuto dopo il rimborso non fa rivivere nulla.
  r := payment_paid(b1, 'cs_test_ordineB1', 'pi_b', 'cus_b', 799, 'EUR');
  if (select status from purchases where id = b1) <> 'refunded' or exists (select 1 from entitlements where purchase_id = b1 and status = 'active') then
    raise exception 'FALLITO: pagamento ripetuto dopo il rimborso';
  end if;
  -- Contestazione su A: sospende, vinta ripristina, persa revoca.
  r := payment_dispute('pi_a', 'open');
  if r ->> 'status' <> 'disputed' or not exists (select 1 from entitlements where purchase_id = (select v from t96 where k = 'a2') and status = 'suspended') then
    raise exception 'FALLITO: contestazione aperta %', r;
  end if;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '96000000-0000-0000-0000-000000000002';
do $$ begin
  if can_access_explore('zo.ord') then raise exception 'FALLITO: accesso durante la contestazione'; end if;
  if exists (select 1 from payment_events) then raise exception 'FALLITO: un cliente legge gli eventi di pagamento'; end if;
end $$;
reset role;
set role service_role;
do $$
declare r jsonb; a2 uuid := (select v from t96 where k = 'a2');
begin
  r := payment_dispute('pi_a', 'won');
  if r ->> 'status' <> 'completed' or not exists (select 1 from entitlements where purchase_id = a2 and status = 'active') then
    raise exception 'FALLITO: contestazione vinta %', r;
  end if;
  r := payment_dispute('pi_a', 'lost');
  if (r ->> 'changed')::boolean then raise exception 'FALLITO: esito di una contestazione non aperta'; end if;
  perform payment_dispute('pi_a', 'open');
  r := payment_dispute('pi_a', 'lost');
  if r ->> 'status' <> 'refunded' or exists (select 1 from entitlements where purchase_id = a2 and status <> 'revoked') then
    raise exception 'FALLITO: contestazione persa %', r;
  end if;
  if payment_event_begin('evt_test_2', 'charge.refunded') <> 'new' then raise exception 'FALLITO: secondo evento'; end if;
  perform payment_event_end('evt_test_2', 'error', null, repeat('x', 900));
  if payment_event_begin('evt_test_2', 'charge.refunded') <> 'retry' then raise exception 'FALLITO: evento in errore non riprovato'; end if;
  if (select attempts from payment_events where stripe_event_id = 'evt_test_2') <> 2 then raise exception 'FALLITO: tentativi'; end if;
end $$;
reset role;

-- Un percorso ricevuto in omaggio conta come posseduto: non si vende di nuovo.
set role authenticated;
set request.jwt.claim.sub = '96000000-0000-0000-0000-000000000001';
select admin_grant_product('96000000-0000-0000-0000-000000000003', '96000000-0000-0000-0000-0000000000e2', 'omaggio di prova');
-- L'amministratore legge gli eventi (diagnosi); il cliente no (provato sopra).
do $$ begin
  if (select count(*) from payment_events where stripe_event_id like 'evt_test_%') <> 2 then raise exception 'FALLITO: l''amministratore non legge gli eventi'; end if;
end $$;
set request.jwt.claim.sub = '96000000-0000-0000-0000-000000000003';
do $$ begin
  begin perform checkout_open('96000000-0000-0000-0000-0000000000e2'); raise exception 'FALLITO: venduto un percorso già posseduto';
  exception when raise_exception then if sqlerrm not like 'hai già acquistato%' then raise; end if; end;
end $$;
reset role;

-- ---------------------------------------------------------------- pulizia
delete from payment_events where stripe_event_id like 'evt_test_%';
delete from entitlements where product_id::text like '96000000-%';
delete from purchases where product_id::text like '96000000-%';
delete from product_prices where product_id::text like '96000000-%';
delete from product_routes where product_id::text like '96000000-%';
delete from products where id::text like '96000000-%';
delete from memberships where user_id::text like '96000000-%';
delete from routes where pack_id in ('zo.ord', 'zo.bozza');
delete from destinations where pack_id in ('zo.ord', 'zo.bozza');
delete from packs where id in ('zo.ord', 'zo.bozza');
delete from auth.users where id::text like '96000000-%';

select 'ordini: tutti i controlli superati';
