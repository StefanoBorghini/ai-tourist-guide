-- Test del bucket privato «premium» (20261027000000_premium_storage.sql), uno per ciascuna verifica richiesta
-- prima di applicare la migrazione al database reale:
--   V1 senza diritti nessun file a pagamento si legge (anonimo, visitatore, altra destinazione, diritto scaduto);
--   V2 l'acquisto di un percorso non apre gli altri percorsi né l'esplorazione;
--   V3 il percorso acquistato si legge senza l'esplorazione (i racconti delle tappe sono nel suo file: test del bundle);
--   V4 un rimborso revoca solo i diritti di quell'acquisto;
--   V5 bucket privato, scrittura solo della pipeline nella propria pubblicazione, nessun file a pagamento nel bucket
--      pubblico «bundles».
\set ON_ERROR_STOP 1

-- ---------------------------------------------------------------- dati di prova (come amministratore del DB)
insert into organizations (id, kind, name) values ('97000000-0000-0000-0000-00000000000f', 'institution', 'Comune P (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zp.pi', 'destination', '97000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Pi"}',
   '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":["giro-a","giro-b"]}}'),
  ('zp.rho', 'destination', '97000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Rho"}',
   '{"access":{"explore":"premium","introPlaces":[],"premiumRoutes":[]}}');
insert into destinations (pack_id) values ('zp.pi'), ('zp.rho');
insert into routes (id, pack_id, slug, duration_min, labels) values
  ('97000000-0000-0000-0000-0000000000a1', 'zp.pi', 'giro-a', 30, '{"it":{"name":"Giro A"}}'),
  ('97000000-0000-0000-0000-0000000000a2', 'zp.pi', 'giro-b', 30, '{"it":{"name":"Giro B"}}');
insert into products (id, slug, kind, pack_id, route_id, status) values
  ('97000000-0000-0000-0000-0000000000e1', 'pi-esplora', 'explore', 'zp.pi', null, 'active'),
  ('97000000-0000-0000-0000-0000000000e2', 'pi-giro-a', 'route', 'zp.pi', '97000000-0000-0000-0000-0000000000a1', 'active'),
  ('97000000-0000-0000-0000-0000000000e3', 'rho-esplora', 'explore', 'zp.rho', null, 'active');
insert into auth.users (id, email, raw_user_meta_data) values
  ('97000000-0000-0000-0000-000000000001', 'nessun-diritto@prova.test', '{}'),
  ('97000000-0000-0000-0000-000000000002', 'giro-a@prova.test', '{}'),
  ('97000000-0000-0000-0000-000000000003', 'esplora-e-giro@prova.test', '{}'),
  ('97000000-0000-0000-0000-000000000004', 'altra-destinazione@prova.test', '{}'),
  ('97000000-0000-0000-0000-000000000005', 'scaduto@prova.test', '{}'),
  ('97000000-0000-0000-0000-000000000006', 'editor-pi@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('97000000-0000-0000-0000-000000000006', '97000000-0000-0000-0000-00000000000f', 'territory_editor', 'zp.pi');
insert into purchases (id, user_id, product_id, provider, provider_ref, status) values
  ('97000000-0000-0000-0000-0000000000c2', '97000000-0000-0000-0000-000000000002', '97000000-0000-0000-0000-0000000000e2', 'test', 'q2', 'completed'),
  ('97000000-0000-0000-0000-0000000000c3', '97000000-0000-0000-0000-000000000003', '97000000-0000-0000-0000-0000000000e1', 'test', 'q3', 'completed'),
  ('97000000-0000-0000-0000-0000000000c4', '97000000-0000-0000-0000-000000000003', '97000000-0000-0000-0000-0000000000e2', 'test', 'q4', 'completed'),
  ('97000000-0000-0000-0000-0000000000c5', '97000000-0000-0000-0000-000000000004', '97000000-0000-0000-0000-0000000000e3', 'test', 'q5', 'completed'),
  ('97000000-0000-0000-0000-0000000000c6', '97000000-0000-0000-0000-000000000005', '97000000-0000-0000-0000-0000000000e1', 'test', 'q6', 'completed');
select grant_product('97000000-0000-0000-0000-000000000002', '97000000-0000-0000-0000-0000000000e2', 'purchase', '97000000-0000-0000-0000-0000000000c2');
select grant_product('97000000-0000-0000-0000-000000000003', '97000000-0000-0000-0000-0000000000e1', 'purchase', '97000000-0000-0000-0000-0000000000c3');
select grant_product('97000000-0000-0000-0000-000000000003', '97000000-0000-0000-0000-0000000000e2', 'purchase', '97000000-0000-0000-0000-0000000000c4');
select grant_product('97000000-0000-0000-0000-000000000004', '97000000-0000-0000-0000-0000000000e3', 'purchase', '97000000-0000-0000-0000-0000000000c5');
select grant_product('97000000-0000-0000-0000-000000000005', '97000000-0000-0000-0000-0000000000e1', 'purchase', '97000000-0000-0000-0000-0000000000c6');
-- Diritto scaduto (valido fino a ieri): la scadenza si controlla al momento della lettura.
update entitlements set valid_from = now() - interval '2 days', valid_until = now() - interval '1 day'
where user_id = '97000000-0000-0000-0000-000000000005';

-- Una pubblicazione conclusa di Pi con i suoi file a pagamento.
insert into publications (id, pack_id, status, requested_by, finished_at) values
  ('97000000-0000-0000-0000-0000000000b1', 'zp.pi', 'published', '97000000-0000-0000-0000-000000000006', now());
insert into storage.objects (bucket_id, name, owner) values
  ('premium', 'zp.pi/it/97000000-0000-0000-0000-0000000000b1/explore.aaaaaaaaaaaaaaaa.json', null),
  ('premium', 'zp.pi/it/97000000-0000-0000-0000-0000000000b1/route-giro-a.bbbbbbbbbbbbbbbb.json', null),
  ('premium', 'zp.pi/it/97000000-0000-0000-0000-0000000000b1/route-giro-b.cccccccccccccccc.json', null),
  ('premium', 'zp.rho/it/97000000-0000-0000-0000-0000000000b1/explore.dddddddddddddddd.json', null);

create function pg_temp.visible(p_user text) returns text[] language plpgsql as $$
declare v text[];
begin
  perform set_config('request.jwt.claim.sub', p_user, true);
  execute 'set local role authenticated';
  select coalesce(array_agg(split_part(name, '/', 1) || ':' || split_part(split_part(name, '/', 4), '.', 1) order by name), '{}')
    into v from storage.objects where bucket_id = 'premium';
  execute 'reset role';
  return v;
end $$;

-- ---------------------------------------------------------------- V5 (parte 1): bucket privato
do $$ begin
  if (select public from storage.buckets where id = 'premium') then raise exception 'FALLITO V5: il bucket premium è pubblico'; end if;
end $$;

-- ---------------------------------------------------------------- V1: senza diritti, niente
set role anon;
do $$ begin
  if exists (select 1 from storage.objects where bucket_id = 'premium') then raise exception 'FALLITO V1: un anonimo vede file a pagamento'; end if;
end $$;
reset role;
do $$ begin
  if pg_temp.visible('97000000-0000-0000-0000-000000000001') <> '{}' then
    raise exception 'FALLITO V1: un visitatore senza diritti vede %', pg_temp.visible('97000000-0000-0000-0000-000000000001');
  end if;
  -- Il diritto su un'altra destinazione apre solo quella.
  if pg_temp.visible('97000000-0000-0000-0000-000000000004') <> '{zp.rho:explore}' then
    raise exception 'FALLITO V1: diritto di un''altra destinazione: %', pg_temp.visible('97000000-0000-0000-0000-000000000004');
  end if;
  if pg_temp.visible('97000000-0000-0000-0000-000000000005') <> '{}' then
    raise exception 'FALLITO V1: diritto scaduto: %', pg_temp.visible('97000000-0000-0000-0000-000000000005');
  end if;
end $$;

-- ---------------------------------------------------------------- V2 e V3: un percorso apre solo quel percorso
do $$ begin
  if pg_temp.visible('97000000-0000-0000-0000-000000000002') <> '{zp.pi:route-giro-a}' then
    raise exception 'FALLITO V2/V3: chi ha comprato il giro A vede %', pg_temp.visible('97000000-0000-0000-0000-000000000002');
  end if;
end $$;

-- ---------------------------------------------------------------- V4: il rimborso toglie solo quell'acquisto
do $$ begin
  if pg_temp.visible('97000000-0000-0000-0000-000000000003') <> '{zp.pi:explore,zp.pi:route-giro-a}' then
    raise exception 'FALLITO V4 (prima): %', pg_temp.visible('97000000-0000-0000-0000-000000000003');
  end if;
  if revoke_purchase('97000000-0000-0000-0000-0000000000c4', 'rimborso di prova') <> 1 then raise exception 'FALLITO V4: revoca'; end if;
  if pg_temp.visible('97000000-0000-0000-0000-000000000003') <> '{zp.pi:explore}' then
    raise exception 'FALLITO V4: dopo il rimborso del giro A resta %', pg_temp.visible('97000000-0000-0000-0000-000000000003');
  end if;
  -- Chi aveva solo il giro A, comprato a parte, non perde nulla per il rimborso di un altro.
  if pg_temp.visible('97000000-0000-0000-0000-000000000002') <> '{zp.pi:route-giro-a}' then raise exception 'FALLITO V4: rimborso altrui'; end if;
end $$;

-- ---------------------------------------------------------------- V5 (parte 2): chi scrive e dove
-- Un visitatore, anche con diritti, non scrive né cancella file a pagamento.
set role authenticated;
set request.jwt.claim.sub = '97000000-0000-0000-0000-000000000003';
do $$ begin
  begin
    insert into storage.objects (bucket_id, name) values ('premium', 'zp.pi/it/97000000-0000-0000-0000-0000000000b1/explore.eeeeeeeeeeeeeeee.json');
    raise exception 'FALLITO V5: un visitatore scrive nel bucket premium';
  exception when insufficient_privilege then null; end;
  delete from storage.objects where bucket_id = 'premium';
  update storage.objects set name = name || 'x' where bucket_id = 'premium';
end $$;
reset role;
do $$ begin
  if (select count(*) from storage.objects where bucket_id = 'premium') <> 4
     or exists (select 1 from storage.objects where bucket_id = 'premium' and name like '%x') then
    raise exception 'FALLITO V5: un visitatore cancella o modifica file a pagamento';
  end if;
end $$;

-- La pipeline: solo nella propria pubblicazione in corso, mai in una conclusa, mai sovrascrivendo.
insert into publications (id, pack_id, status, requested_by, report) values
  ('97000000-0000-0000-0000-0000000000b2', 'zp.pi', 'building', '97000000-0000-0000-0000-000000000006', jsonb_build_object('startedAt', now()));
set role authenticated;
set request.jwt.claim.sub = '97000000-0000-0000-0000-000000000006';
do $$ begin
  insert into storage.objects (bucket_id, name) values ('premium', 'zp.pi/it/97000000-0000-0000-0000-0000000000b2/route-giro-b.ffffffffffffffff.json');
  begin
    insert into storage.objects (bucket_id, name) values ('premium', 'zp.pi/it/97000000-0000-0000-0000-0000000000b1/route-giro-b.9999999999999999.json');
    raise exception 'FALLITO V5: scritto un file in una pubblicazione già conclusa';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name) values ('premium', 'zp.rho/it/97000000-0000-0000-0000-0000000000b2/explore.ffffffffffffffff.json');
    raise exception 'FALLITO V5: scritto un file di un territorio fuori ambito';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name) values ('premium', 'zp.pi/it/97000000-0000-0000-0000-0000000000b2/qualsiasi.json');
    raise exception 'FALLITO V5: accettato un nome di file non previsto';
  exception when insufficient_privilege then null; end;
  -- Un file a pagamento nel bucket pubblico «bundles»: rifiutato (il nome non è tra quelli dei bundle).
  begin
    insert into storage.objects (bucket_id, name) values ('bundles', 'zp.pi/it/97000000-0000-0000-0000-0000000000b2/explore.ffffffffffffffff.json');
    raise exception 'FALLITO V5: un file a pagamento entra nel bucket pubblico';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects (bucket_id, name) values ('bundles', 'zp.pi/it-full/97000000-0000-0000-0000-0000000000b2/explore.ffffffffffffffff.json');
    raise exception 'FALLITO V5: un file a pagamento entra nel bucket pubblico (cartella dei bundle)';
  exception when insufficient_privilege then null; end;
  -- La pubblicazione conclusa e in linea non si cancella.
  delete from storage.objects where bucket_id = 'premium' and name like 'zp.pi/it/97000000-0000-0000-0000-0000000000b1/%';
end $$;
reset role;
do $$ begin
  if (select count(*) from storage.objects where bucket_id = 'premium' and name like 'zp.pi/it/97000000-0000-0000-0000-0000000000b1/%') <> 3 then
    raise exception 'FALLITO V5: cancellati i file della pubblicazione in linea';
  end if;
  if not exists (select 1 from storage.objects where name = 'zp.pi/it/97000000-0000-0000-0000-0000000000b2/route-giro-b.ffffffffffffffff.json') then
    raise exception 'FALLITO V5: la pipeline non scrive nella propria pubblicazione in corso';
  end if;
end $$;

-- Pulizia dei dati di prova (i diritti e gli acquisti non si cancellano dall'API: qui si è amministratori del DB).
delete from storage.objects where bucket_id = 'premium' and name like 'zp.%';
delete from entitlements where product_id::text like '97000000-%';
delete from purchases where product_id::text like '97000000-%';
delete from products where id::text like '97000000-%';
delete from publications where pack_id in ('zp.pi', 'zp.rho');
delete from memberships where user_id::text like '97000000-%';
delete from routes where pack_id in ('zp.pi', 'zp.rho');
delete from destinations where pack_id in ('zp.pi', 'zp.rho');
delete from packs where id in ('zp.pi', 'zp.rho');
delete from organizations where id = '97000000-0000-0000-0000-00000000000f';
delete from auth.users where id::text like '97000000-%';
select 'premium: V1–V5 superati';
