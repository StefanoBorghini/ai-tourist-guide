-- Test dei diritti commerciali (20261024000000_entitlements.sql): l'esplorazione non concede percorsi; un percorso
-- concede solo quel percorso; un pacchetto solo i percorsi che conteneva al momento; nessuna scrittura diretta.
\set ON_ERROR_STOP 1

-- ---------------------------------------------------------------- dati di prova (come amministratore del DB)
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zf.phi', 'destination', (select id from organizations where kind = 'platform' order by created_at limit 1), 'it', '{it}', '{"it":"Phi"}',
   '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":["r1","r2","r4"]}}'),
  ('zf.psi', 'destination', (select id from organizations where kind = 'platform' order by created_at limit 1), 'it', '{it}', '{"it":"Psi"}', '{}');
insert into destinations (pack_id) values ('zf.phi'), ('zf.psi');
insert into routes (id, pack_id, slug, duration_min, labels) values
  ('90000000-0000-0000-0000-0000000000a1', 'zf.phi', 'r1', 30, '{"it":{"name":"R1"}}'),
  ('90000000-0000-0000-0000-0000000000a2', 'zf.phi', 'r2', 30, '{"it":{"name":"R2"}}'),
  ('90000000-0000-0000-0000-0000000000a3', 'zf.phi', 'r3', 30, '{"it":{"name":"R3, gratuito"}}'),
  ('90000000-0000-0000-0000-0000000000a4', 'zf.phi', 'r4', 30, '{"it":{"name":"R4"}}'),
  ('90000000-0000-0000-0000-0000000000b1', 'zf.psi', 's1', 30, '{"it":{"name":"S1"}}');
insert into products (id, slug, kind, pack_id, route_id, status) values
  ('90000000-0000-0000-0000-0000000000e1', 'phi-esplora', 'explore', 'zf.phi', null, 'active'),
  ('90000000-0000-0000-0000-0000000000e2', 'phi-r1', 'route', 'zf.phi', '90000000-0000-0000-0000-0000000000a1', 'active'),
  ('90000000-0000-0000-0000-0000000000e3', 'phi-pacchetto', 'bundle', 'zf.phi', null, 'active');
insert into product_routes (product_id, route_id) values
  ('90000000-0000-0000-0000-0000000000e3', '90000000-0000-0000-0000-0000000000a1'),
  ('90000000-0000-0000-0000-0000000000e3', '90000000-0000-0000-0000-0000000000a2');
insert into auth.users (id, email, raw_user_meta_data) values
  ('90000000-0000-0000-0000-000000000001', 'esplora@prova.test', '{}'),
  ('90000000-0000-0000-0000-000000000002', 'percorso@prova.test', '{}'),
  ('90000000-0000-0000-0000-000000000003', 'pacchetto@prova.test', '{}'),
  ('90000000-0000-0000-0000-000000000004', 'nessuno@prova.test', '{}'),
  ('90000000-0000-0000-0000-000000000005', 'admin-diritti@prova.test', '{}'),
  ('90000000-0000-0000-0000-000000000006', 'ritirato@prova.test', '{}');
insert into memberships (user_id, organization_id, role) values
  ('90000000-0000-0000-0000-000000000005', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin');
insert into purchases (id, user_id, product_id, provider, provider_ref, status) values
  ('90000000-0000-0000-0000-0000000000c1', '90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000e1', 'test', 'p1', 'completed'),
  ('90000000-0000-0000-0000-0000000000c2', '90000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-0000000000e2', 'test', 'p2', 'completed'),
  ('90000000-0000-0000-0000-0000000000c3', '90000000-0000-0000-0000-000000000003', '90000000-0000-0000-0000-0000000000e3', 'test', 'p3', 'completed'),
  ('90000000-0000-0000-0000-0000000000c4', '90000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-0000000000e1', 'test', 'p4', 'pending'),
  ('90000000-0000-0000-0000-0000000000c6', '90000000-0000-0000-0000-000000000006', '90000000-0000-0000-0000-0000000000e2', 'test', 'p6', 'completed');

-- ---------------------------------------------------------------- prodotti coerenti
do $$ begin
  begin
    insert into products (slug, kind, pack_id, status) values ('senza-percorso', 'route', 'zf.phi', 'active');
    raise exception 'FALLITO: prodotto «route» senza percorso';
  exception when check_violation then null; end;
  begin
    insert into products (slug, kind, pack_id, route_id, status) values ('esplora-con-percorso', 'explore', 'zf.phi', '90000000-0000-0000-0000-0000000000a1', 'active');
    raise exception 'FALLITO: esplorazione legata a un percorso';
  exception when check_violation then null; end;
  begin
    insert into products (slug, kind, pack_id, route_id, status) values ('percorso-altrui', 'route', 'zf.phi', '90000000-0000-0000-0000-0000000000b1', 'active');
    raise exception 'FALLITO: percorso di un''altra destinazione';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    insert into product_routes values ('90000000-0000-0000-0000-0000000000e3', '90000000-0000-0000-0000-0000000000b1');
    raise exception 'FALLITO: pacchetto con un percorso di un''altra destinazione';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    insert into product_routes values ('90000000-0000-0000-0000-0000000000e2', '90000000-0000-0000-0000-0000000000a2');
    raise exception 'FALLITO: percorsi aggiunti a un prodotto che non è un pacchetto';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    insert into products (slug, kind, status) values ('senza-destinazione', 'explore', 'active');
    raise exception 'FALLITO: prodotto senza destinazione';
  exception when check_violation or raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;

-- ---------------------------------------------------------------- concessione: solo il server, solo acquisti validi
set role authenticated;
set request.jwt.claim.sub = '90000000-0000-0000-0000-000000000004';
do $$ begin
  begin
    perform grant_product('90000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-0000000000e1', 'grant');
    raise exception 'FALLITO: un utente si concede un diritto';
  exception when insufficient_privilege then null; end;
  begin
    insert into entitlements (user_id, product_id, source, scope, pack_id) values
      ('90000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-0000000000e1', 'grant', 'explore', 'zf.phi');
    raise exception 'FALLITO: un utente scrive un diritto con un INSERT diretto';
  exception when insufficient_privilege then null; end;
  begin
    perform admin_grant_product('90000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-0000000000e1', 'omaggio');
    raise exception 'FALLITO: un utente usa la concessione manuale';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set role service_role;
do $$ begin
  perform grant_product('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000e1', 'purchase', '90000000-0000-0000-0000-0000000000c1');
  perform grant_product('90000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-0000000000e2', 'purchase', '90000000-0000-0000-0000-0000000000c2');
  if grant_product('90000000-0000-0000-0000-000000000003', '90000000-0000-0000-0000-0000000000e3', 'purchase', '90000000-0000-0000-0000-0000000000c3') <> 2 then
    raise exception 'FALLITO: il pacchetto concede un diritto per ciascuno dei suoi percorsi';
  end if;
  begin
    perform grant_product('90000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-0000000000e1', 'purchase', '90000000-0000-0000-0000-0000000000c4');
    raise exception 'FALLITO: diritto da un acquisto non completato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform grant_product('90000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-0000000000e1', 'purchase', '90000000-0000-0000-0000-0000000000c1');
    raise exception 'FALLITO: diritto dall''acquisto di un altro utente';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;
reset role;

-- Il pacchetto cambia dopo l'acquisto: chi l'ha comprato non riceve il percorso aggiunto.
insert into product_routes values ('90000000-0000-0000-0000-0000000000e3', '90000000-0000-0000-0000-0000000000a4');

-- ---------------------------------------------------------------- eventi di pagamento ripetuti (M2)
-- Il fornitore di pagamento può consegnare lo stesso evento più volte: nessun diritto in più, nessun errore,
-- nemmeno se nel frattempo il pacchetto ha un percorso in più (r4).
create temp table prima_90 as select purchase_id, scope, route_id, id from entitlements where purchase_id is not null;
set role service_role;
do $$ begin
  for i in 1..3 loop
    if grant_product('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000e1', 'purchase', '90000000-0000-0000-0000-0000000000c1') <> 0
       or grant_product('90000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-0000000000e2', 'purchase', '90000000-0000-0000-0000-0000000000c2') <> 0
       or grant_product('90000000-0000-0000-0000-000000000003', '90000000-0000-0000-0000-0000000000e3', 'purchase', '90000000-0000-0000-0000-0000000000c3') <> 0 then
      raise exception 'FALLITO: un evento ripetuto crea altri diritti';
    end if;
  end loop;
end $$;
reset role;
do $$ begin
  if exists (select purchase_id, scope, route_id, id from entitlements where purchase_id is not null
             except select * from prima_90)
     or (select count(*) from entitlements where purchase_id is not null) <> (select count(*) from prima_90) then
    raise exception 'FALLITO: i diritti degli acquisti sono cambiati dopo gli eventi ripetuti';
  end if;
  -- Anche scrivendo direttamente (senza grant_product) lo stesso acquisto non concede due volte lo stesso ambito.
  begin
    insert into entitlements (user_id, product_id, source, purchase_id, scope, pack_id)
    values ('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-0000000000e1', 'purchase', '90000000-0000-0000-0000-0000000000c1', 'explore', 'zf.phi');
    raise exception 'FALLITO: diritto duplicato per lo stesso acquisto';
  exception when unique_violation then null; end;
end $$;

-- ---------------------------------------------------------------- cosa sblocca ciascun acquisto
create temp table attese_90 (utente uuid, esplora boolean, r1 boolean, r2 boolean, r3 boolean, r4 boolean, psi boolean);
insert into attese_90 values
  ('90000000-0000-0000-0000-000000000001', true,  false, false, true, false, true),  -- esplorazione: nessun percorso premium
  ('90000000-0000-0000-0000-000000000002', false, true,  false, true, false, true),  -- percorso r1: solo r1
  ('90000000-0000-0000-0000-000000000003', false, true,  true,  true, false, true),  -- pacchetto: r1 e r2, non r4 (aggiunto dopo)
  ('90000000-0000-0000-0000-000000000004', false, false, false, true, false, true);  -- niente: solo il gratuito
grant select on attese_90 to authenticated;

create or replace function pg_temp.verifica_90(p_user uuid) returns void language plpgsql as $$
declare a record;
begin
  select * into a from attese_90 where utente = p_user;
  if can_access_explore('zf.phi') is distinct from a.esplora
     or can_access_route('90000000-0000-0000-0000-0000000000a1') is distinct from a.r1
     or can_access_route('90000000-0000-0000-0000-0000000000a2') is distinct from a.r2
     or can_access_route('90000000-0000-0000-0000-0000000000a3') is distinct from a.r3
     or can_access_route('90000000-0000-0000-0000-0000000000a4') is distinct from a.r4
     or can_access_explore('zf.psi') is distinct from a.psi
     or can_access_route('90000000-0000-0000-0000-0000000000b1') is distinct from true then
    raise exception 'FALLITO: diritti di % diversi da quelli acquistati', p_user;
  end if;
end;
$$;

set role authenticated;
set request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';
select pg_temp.verifica_90('90000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from entitlements) <> 1 then raise exception 'FALLITO: un utente vede i diritti degli altri'; end if;
  -- Nessuna scrittura diretta sui diritti (20261024000000): rifiutata, non solo senza effetto.
  begin
    update entitlements set valid_until = now() + interval '10 years';
    raise exception 'FALLITO: un utente modifica i propri diritti';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claim.sub = '90000000-0000-0000-0000-000000000002';
select pg_temp.verifica_90('90000000-0000-0000-0000-000000000002');
set request.jwt.claim.sub = '90000000-0000-0000-0000-000000000003';
select pg_temp.verifica_90('90000000-0000-0000-0000-000000000003');
set request.jwt.claim.sub = '90000000-0000-0000-0000-000000000004';
select pg_temp.verifica_90('90000000-0000-0000-0000-000000000004');
reset role;

-- Anonimo: solo i contenuti gratuiti.
set role anon;
do $$ begin
  if can_access_explore('zf.phi') or can_access_route('90000000-0000-0000-0000-0000000000a1')
     or not can_access_route('90000000-0000-0000-0000-0000000000a3') or not can_access_explore('zf.psi') then
    raise exception 'FALLITO: accesso anonimo';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------- revoca e concessione manuale
set role service_role;
do $$ begin
  if revoke_purchase('90000000-0000-0000-0000-0000000000c2', 'rimborso') <> 1 then raise exception 'FALLITO: revoca dell''acquisto'; end if;
  -- L'evento di pagamento ripetuto dopo la revoca non fa rivivere il diritto (M2).
  if grant_product('90000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-0000000000e2', 'purchase', '90000000-0000-0000-0000-0000000000c2') <> 0 then
    raise exception 'FALLITO: un evento ripetuto fa rivivere un diritto revocato';
  end if;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '90000000-0000-0000-0000-000000000002';
do $$ begin
  if can_access_route('90000000-0000-0000-0000-0000000000a1') then raise exception 'FALLITO: diritto revocato ancora valido'; end if;
end $$;
set request.jwt.claim.sub = '90000000-0000-0000-0000-000000000005';
do $$ begin
  begin
    perform admin_grant_product('90000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-0000000000e2', '');
    raise exception 'FALLITO: concessione manuale senza motivo';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  if admin_grant_product('90000000-0000-0000-0000-000000000004', '90000000-0000-0000-0000-0000000000e2', 'assistenza') <> 1 then
    raise exception 'FALLITO: concessione manuale dell''amministratore';
  end if;
end $$;
set request.jwt.claim.sub = '90000000-0000-0000-0000-000000000004';
do $$ begin
  if not can_access_route('90000000-0000-0000-0000-0000000000a1') or can_access_route('90000000-0000-0000-0000-0000000000a2')
     or can_access_explore('zf.phi') then
    raise exception 'FALLITO: la concessione manuale sblocca solo il prodotto concesso';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------- prodotto ritirato dopo il pagamento (M4)
-- Ritirare un prodotto dalla vendita non toglie nulla a chi l'ha già comprato, né a chi l'ha pagato ma non ha ancora
-- ricevuto il diritto (evento elaborato dopo il ritiro). Le concessioni manuali invece vogliono un prodotto attivo.
update products set status = 'retired' where id in ('90000000-0000-0000-0000-0000000000e1', '90000000-0000-0000-0000-0000000000e2');
set role service_role;
do $$ begin
  if grant_product('90000000-0000-0000-0000-000000000006', '90000000-0000-0000-0000-0000000000e2', 'purchase', '90000000-0000-0000-0000-0000000000c6') <> 1 then
    raise exception 'FALLITO: acquisto completato senza diritto perché il prodotto è stato ritirato';
  end if;
  begin
    perform grant_product('90000000-0000-0000-0000-000000000006', '90000000-0000-0000-0000-0000000000e1', 'promo');
    raise exception 'FALLITO: promozione su un prodotto ritirato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '90000000-0000-0000-0000-000000000006';
do $$ begin
  if not can_access_route('90000000-0000-0000-0000-0000000000a1') or can_access_route('90000000-0000-0000-0000-0000000000a2')
     or can_access_explore('zf.phi') then
    raise exception 'FALLITO: diritto dell''acquisto di un prodotto ritirato';
  end if;
end $$;
set request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';
do $$ begin
  if not can_access_explore('zf.phi') then raise exception 'FALLITO: il ritiro del prodotto toglie il diritto già concesso'; end if;
end $$;
reset role;
-- Un prodotto già acquistato non cambia cosa sblocca; nome, descrizione e stato sì.
do $$ begin
  begin
    update products set route_id = '90000000-0000-0000-0000-0000000000a2' where id = '90000000-0000-0000-0000-0000000000e2';
    raise exception 'FALLITO: cambiato il percorso di un prodotto già acquistato';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    update products set kind = 'bundle', route_id = null where id = '90000000-0000-0000-0000-0000000000e2';
    raise exception 'FALLITO: cambiato il tipo di un prodotto già acquistato';
  exception when raise_exception or check_violation then if sqlerrm like 'FALLITO%' then raise; end if; end;
  update products set labels = '{"it":{"name":"R1 (non più in vendita)"}}', status = 'active' where id = '90000000-0000-0000-0000-0000000000e2';
end $$;

-- Pulizia dei dati di prova (i pacchetti non sopravvivono alla revoca della migrazione, provata dopo i test).
delete from entitlements where pack_id in ('zf.phi', 'zf.psi');
delete from purchases where product_id in (select id from products where pack_id in ('zf.phi', 'zf.psi'));
delete from products where pack_id in ('zf.phi', 'zf.psi');
update packs set config = config - 'access' where id = 'zf.phi';

select 'diritti: tutti i controlli superati';
