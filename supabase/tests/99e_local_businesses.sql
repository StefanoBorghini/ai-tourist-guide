-- Test della directory delle attività locali (20261105000000_local_businesses.sql):
--   B1 creazione e integrità: nome e categoria obbligatori, solo destinazioni, testi solo nelle lingue del territorio,
--      sito solo https, telefono ed email plausibili, nasce in bozza;
--   B2 permessi: expert, redattore di un'altra organizzazione e anon non leggono né scrivono;
--   B3 pubblicazione: niente senza verifica, stato e verifica solo dallo Studio, modifiche che azzerano la verifica,
--      ritiro, eliminazione solo delle bozze;
--   B4 lettura pubblica: solo pubblicate di destinazioni pubblicate, ordine alfabetico, campi pubblici, lingua;
--   B5 proprietà delle funzioni (definer, search_path, permessi).
-- Territori propri (zl.*); alla fine si ripulisce, così la revoca della migrazione resta provabile da run.sh.
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values
  ('9a100000-0000-0000-0000-00000000000e', 'institution', 'Comune L (prova)'),
  ('9a100000-0000-0000-0000-00000000000f', 'institution', 'Comune M (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zl.borgo', 'destination', '9a100000-0000-0000-0000-00000000000e', 'it', '{it,en}', '{"it":"Borgo"}', '{}'),
  ('zl.altro', 'destination', '9a100000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Altro"}', '{}'),
  ('zl.bozza', 'destination', '9a100000-0000-0000-0000-00000000000e', 'it', '{it}', '{"it":"Bozza"}', '{}'),
  ('zl.regione', 'region', '9a100000-0000-0000-0000-00000000000e', 'it', '{it}', '{"it":"Regione"}', '{}');
insert into destinations (pack_id, status) values ('zl.borgo', 'published'), ('zl.altro', 'published'), ('zl.bozza', 'draft');
insert into auth.users (id, email, raw_user_meta_data) values
  ('9a100000-0000-0000-0000-000000000001', 'admin-l@prova.test', '{}'),
  ('9a100000-0000-0000-0000-000000000002', 'redattore-l@prova.test', '{}'),
  ('9a100000-0000-0000-0000-000000000003', 'redattore-m@prova.test', '{}'),
  ('9a100000-0000-0000-0000-000000000004', 'esperto-l@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('9a100000-0000-0000-0000-000000000001', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin', null),
  ('9a100000-0000-0000-0000-000000000002', '9a100000-0000-0000-0000-00000000000e', 'territory_editor', null),
  ('9a100000-0000-0000-0000-000000000003', '9a100000-0000-0000-0000-00000000000f', 'territory_editor', 'zl.altro'),
  ('9a100000-0000-0000-0000-000000000004', '9a100000-0000-0000-0000-00000000000e', 'expert', 'zl.borgo');

-- ---------------------------------------------------------------- B1
set role authenticated;
set request.jwt.claim.sub = '9a100000-0000-0000-0000-000000000002';
do $$
declare
  b jsonb;
  bad jsonb;
begin
  b := studio_save_local_business('zl.borgo', null, jsonb_build_object(
    'name', '  Trattoria del Porto  ', 'category', 'restaurant', 'subcategory', 'trattoria',
    'labels', jsonb_build_object('it', jsonb_build_object('description', 'Pesce del golfo', 'hours', 'Tutti i giorni 12–15, 19–23'),
                                 'fr', jsonb_build_object('description', 'Poisson')),
    'address', 'Calata Doria 1', 'lat', 44.05, 'lng', 9.83, 'phone', '+39 0187 000000', 'email', ' Info@Trattoria.Example.it ',
    'website', 'https://trattoria.example.it'));
  if b ->> 'publication' <> 'draft' or b ->> 'verifiedAt' is not null then raise exception 'FALLITO B1: non nasce in bozza da verificare'; end if;
  if b ->> 'name' <> 'Trattoria del Porto' or b ->> 'slug' <> 'trattoria-del-porto' or b ->> 'email' <> 'info@trattoria.example.it' then
    raise exception 'FALLITO B1: campi non ripuliti (%)', b;
  end if;
  if b -> 'labels' ? 'fr' then raise exception 'FALLITO B1: tenuta una lingua estranea al territorio'; end if;
  -- Stesso nome: identificativo libero.
  if studio_save_local_business('zl.borgo', null, '{"name":"Trattoria del Porto","category":"restaurant"}') ->> 'slug' <> 'trattoria-del-porto-2' then
    raise exception 'FALLITO B1: identificativo doppio';
  end if;
  perform studio_save_local_business('zl.borgo', null, '{"name":"Bar Alba","category":"bar","subcategory":"caffè"}');
  perform studio_save_local_business('zl.borgo', null, '{"name":"albergo Zeta","category":"accommodation"}');
  foreach bad in array array[
    '{"category":"bar"}'::jsonb, '{"name":"X"}', '{"name":"X","category":"casinò"}', '{"name":"X","category":"bar","website":"http://x.example.it"}',
    '{"name":"X","category":"bar","phone":"chiamami"}', '{"name":"X","category":"bar","email":"senza-chiocciola"}',
    '{"name":"X","category":"bar","lat":44}', '{"name":"X","category":"bar","lat":144,"lng":9}'
  ] loop
    begin
      perform studio_save_local_business('zl.borgo', null, bad);
      raise exception 'FALLITO B1: accettata %', bad;
    exception when raise_exception or check_violation or invalid_text_representation then
      if sqlerrm like 'FALLITO%' then raise; end if;
    end;
  end loop;
  begin
    perform studio_save_local_business('zl.regione', null, '{"name":"X","category":"bar"}');
    raise exception 'FALLITO B1: attività in una regione';
  exception when raise_exception or insufficient_privilege then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
end $$;
reset role;

-- ---------------------------------------------------------------- B2
set role authenticated;
set request.jwt.claim.sub = '9a100000-0000-0000-0000-000000000004';
do $$ begin
  if exists (select 1 from local_businesses) then raise exception 'FALLITO B2: l''esperto legge le attività'; end if;
  if jsonb_array_length(studio_local_businesses('zl.borgo')) <> 0 then raise exception 'FALLITO B2: l''esperto le legge dallo Studio'; end if;
  begin
    perform studio_save_local_business('zl.borgo', null, '{"name":"X","category":"bar"}');
    raise exception 'FALLITO B2: l''esperto crea un''attività';
  exception when insufficient_privilege then null; end;
end $$;
set request.jwt.claim.sub = '9a100000-0000-0000-0000-000000000003';
do $$ begin
  if exists (select 1 from local_businesses where pack_id = 'zl.borgo') then raise exception 'FALLITO B2: un''altra organizzazione legge le attività'; end if;
  update local_businesses set name = 'Manomesso' where pack_id = 'zl.borgo';
  begin
    perform studio_save_local_business('zl.borgo', null, '{"name":"X","category":"bar"}');
    raise exception 'FALLITO B2: un''altra organizzazione crea un''attività';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  if exists (select 1 from local_businesses where name = 'Manomesso') then raise exception 'FALLITO B2: modificata un''attività di un''altra organizzazione'; end if;
end $$;
set role anon;
do $$ begin
  begin
    perform 1 from local_businesses limit 1;
    raise exception 'FALLITO B2: anon legge la tabella';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_save_local_business('zl.borgo', null, '{}');
    raise exception 'FALLITO B2: anon usa le funzioni dello Studio';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- B3
set role authenticated;
set request.jwt.claim.sub = '9a100000-0000-0000-0000-000000000002';
do $$
declare
  t uuid := (select id from local_businesses where slug = 'trattoria-del-porto');
  b jsonb;
begin
  begin
    perform studio_set_local_business_publication(t, 'published');
    raise exception 'FALLITO B3: pubblicata senza verifica';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    update local_businesses set verified_at = now(), verified_by = auth.uid() where id = t;
    raise exception 'FALLITO B3: verifica con un UPDATE diretto';
  exception when insufficient_privilege then null; end;
  b := studio_verify_local_business(t, 'telefonato il 28/10');
  if b ->> 'verifiedAt' is null or b ->> 'verifiedBy' <> '9a100000-0000-0000-0000-000000000002' then raise exception 'FALLITO B3: verifica non registrata'; end if;
  b := studio_set_local_business_publication(t, 'published');
  if b ->> 'publication' <> 'published' or b ->> 'publishedAt' is null then raise exception 'FALLITO B3: pubblicazione'; end if;
  begin
    update local_businesses set publication = 'draft' where id = t;
    raise exception 'FALLITO B3: stato cambiato con un UPDATE diretto';
  exception when insufficient_privilege then null; end;
  -- Cambiare i dati di una pubblicata senza riverificare: rifiutato; con la verifica: accettato.
  begin
    perform studio_save_local_business('zl.borgo', t, '{"name":"Trattoria del Porto","category":"restaurant","phone":"+39 0187 111111"}');
    raise exception 'FALLITO B3: dati cambiati senza verifica su una pubblicata';
  exception when raise_exception then if sqlerrm like 'FALLITO%' then raise; end if; end;
  b := studio_save_local_business('zl.borgo', t, jsonb_build_object('name', 'Trattoria del Porto', 'category', 'restaurant', 'subcategory', 'trattoria',
    'labels', jsonb_build_object('it', jsonb_build_object('description', 'Pesce del golfo', 'hours', 'Chiuso il martedì'),
                                 'en', jsonb_build_object('description', 'Fish from the gulf')),
    'address', 'Calata Doria 1', 'lat', 44.05, 'lng', 9.83, 'phone', '+39 0187 111111', 'website', 'https://trattoria.example.it'), true);
  if b ->> 'publication' <> 'published' or b ->> 'phone' <> '+39 0187 111111' then raise exception 'FALLITO B3: correzione verificata'; end if;
  -- Una bozza modificata perde la verifica.
  perform studio_verify_local_business((select id from local_businesses where slug = 'bar-alba'));
  perform studio_save_local_business('zl.borgo', (select id from local_businesses where slug = 'bar-alba'), '{"name":"Bar Alba","category":"bar","subcategory":"gelateria"}');
  if (select verified_at from local_businesses where slug = 'bar-alba') is not null then raise exception 'FALLITO B3: la modifica non azzera la verifica'; end if;
  perform studio_save_local_business('zl.borgo', (select id from local_businesses where slug = 'bar-alba'), '{"name":"Bar Alba","category":"bar","subcategory":"caffè"}', true);
  perform studio_set_local_business_publication((select id from local_businesses where slug = 'bar-alba'), 'published');
  -- Ritiro ed eliminazione.
  perform studio_verify_local_business((select id from local_businesses where slug = 'albergo-zeta'));
  perform studio_set_local_business_publication((select id from local_businesses where slug = 'albergo-zeta'), 'published');
  perform studio_set_local_business_publication((select id from local_businesses where slug = 'albergo-zeta'), 'withdrawn');
  begin
    perform studio_delete_local_business((select id from local_businesses where slug = 'albergo-zeta'));
    raise exception 'FALLITO B3: eliminata un''attività ritirata';
  exception when insufficient_privilege then null; end;
  perform studio_delete_local_business((select id from local_businesses where slug = 'trattoria-del-porto-2'));
  if exists (select 1 from local_businesses where slug = 'trattoria-del-porto-2') then raise exception 'FALLITO B3: bozza non eliminata'; end if;
  -- Un'attività nella destinazione non pubblicata, pubblicata: non deve comparire al pubblico.
  b := studio_save_local_business('zl.bozza', null, '{"name":"Nascosta","category":"shop"}', true);
  perform studio_set_local_business_publication((b ->> 'id')::uuid, 'published');
end $$;
reset role;

-- ---------------------------------------------------------------- B4
set role anon;
do $$
declare r jsonb;
begin
  r := public_local_businesses('zl.borgo', 'en');
  if r ->> 'lang' <> 'en' then raise exception 'FALLITO B4: lingua'; end if;
  -- Solo pubblicate (non la ritirata), in ordine alfabetico senza badge né priorità.
  if (select jsonb_agg(x ->> 'slug') from jsonb_array_elements(r -> 'businesses') x) <> '["bar-alba","trattoria-del-porto"]' then
    raise exception 'FALLITO B4: elenco o ordine (%)', r -> 'businesses';
  end if;
  if (select x ->> 'description' from jsonb_array_elements(r -> 'businesses') x where x ->> 'slug' = 'trattoria-del-porto') <> 'Fish from the gulf'
     or (select x ->> 'hours' from jsonb_array_elements(r -> 'businesses') x where x ->> 'slug' = 'trattoria-del-porto') <> 'Chiuso il martedì' then
    raise exception 'FALLITO B4: testi nella lingua chiesta con ripiego sulla principale';
  end if;
  if exists (select 1 from jsonb_array_elements(r -> 'businesses') x, jsonb_object_keys(x) k
             where k not in ('id', 'slug', 'name', 'category', 'subcategory', 'description', 'hours', 'address', 'lat', 'lng',
                             'phone', 'email', 'website', 'verifiedAt')) then
    raise exception 'FALLITO B4: campi non pubblici nella risposta';
  end if;
  if public_local_businesses('zl.bozza') is not null then raise exception 'FALLITO B4: destinazione non pubblicata'; end if;
  if public_local_businesses('zl.sconosciuto') is not null then raise exception 'FALLITO B4: territorio sconosciuto'; end if;
  if jsonb_array_length(public_local_businesses('zl.altro') -> 'businesses') <> 0 then raise exception 'FALLITO B4: isolamento tra territori'; end if;
  begin
    perform public_local_businesses('zl.borgo', 'fr');
    raise exception 'FALLITO B4: lingua estranea accettata';
  exception when sqlstate '22023' then null; end;
  begin
    perform public_local_businesses('../x');
    raise exception 'FALLITO B4: territorio malformato accettato';
  exception when sqlstate '22023' then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- B5
do $$
declare f record;
begin
  for f in select * from (values
      ('public_local_businesses(text,text)', true, true, true, true),
      ('studio_local_businesses(text)', false, true, true, false),
      ('studio_save_local_business(text,uuid,jsonb,boolean)', false, true, true, false),
      ('studio_set_local_business_publication(uuid,text)', false, true, true, false),
      ('studio_verify_local_business(uuid,text)', false, true, true, false),
      ('studio_delete_local_business(uuid)', false, true, true, false),
      ('local_businesses_guard()', false, false, null, false),
      ('local_businesses_prepare()', false, false, null, false)
    ) as t(sig, anon_exec, auth_exec, service_exec, definer) loop
    if has_function_privilege('anon', f.sig, 'execute') is distinct from f.anon_exec then raise exception 'FALLITO B5: anon su %', f.sig; end if;
    if has_function_privilege('authenticated', f.sig, 'execute') is distinct from f.auth_exec then raise exception 'FALLITO B5: authenticated su %', f.sig; end if;
    if f.service_exec is not null and has_function_privilege('service_role', f.sig, 'execute') is distinct from f.service_exec then
      raise exception 'FALLITO B5: service_role su %', f.sig;
    end if;
    if (select prosecdef from pg_proc where oid = f.sig::regprocedure) is distinct from f.definer then raise exception 'FALLITO B5: SECURITY DEFINER di %', f.sig; end if;
    if (select proconfig from pg_proc where oid = f.sig::regprocedure) is distinct from array['search_path=public'] then
      raise exception 'FALLITO B5: search_path di %', f.sig;
    end if;
  end loop;
  if has_table_privilege('anon', 'local_businesses', 'select') or has_table_privilege('anon', 'local_businesses', 'insert') then
    raise exception 'FALLITO B5: anon ha privilegi sulla tabella delle attività';
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'local_businesses'
             and column_name ~ '(affili|sponsor|partner|priority|rank|featured)') then
    raise exception 'FALLITO B5: colonna di affiliazione o priorità nella tabella pubblica';
  end if;
end $$;

-- ---------------------------------------------------------------- pulizia (la revoca si ferma se restano attività)
delete from local_businesses where pack_id like 'zl.%';
\echo 'attività locali: B1–B5 superati'
