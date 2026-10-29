-- Test delle foto delle attività (20261106000000_business_photos.sql):
--   F1 registrazione: file nella cartella dell'attività e già caricato, testo alternativo nella lingua principale,
--      autore, accordo e indirizzo originale dove servono, mai «tutti i diritti riservati», non commerciali solo se
--      il territorio le ammette, al massimo 6;
--   F2 ordine ed eliminazione: «metti per prima», eliminazione che restituisce il file;
--   F3 permessi: redattore di un altro territorio e anon non leggono né scrivono, né le righe né i file;
--   F4 lettura pubblica: foto solo delle attività pubblicate, crediti sì, note interne e autore del caricamento no;
--   F5 proprietà delle funzioni.
-- Territori propri (zp.*); alla fine si ripulisce (righe e file), così la revoca resta provabile da run.sh.
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values
  ('9f000000-0000-0000-0000-00000000000e', 'institution', 'Comune P (prova)'),
  ('9f000000-0000-0000-0000-00000000000f', 'institution', 'Comune Q (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zp.borgo', 'destination', '9f000000-0000-0000-0000-00000000000e', 'it', '{it,en}', '{"it":"Borgo"}', '{}'),
  ('zp.altro', 'destination', '9f000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Altro"}', '{"media":{"allowNonCommercial":true}}');
insert into destinations (pack_id, status) values ('zp.borgo', 'published'), ('zp.altro', 'published');
insert into auth.users (id, email, raw_user_meta_data) values
  ('9f000000-0000-0000-0000-000000000002', 'redattore-fp@prova.test', '{}'),
  ('9f000000-0000-0000-0000-000000000003', 'redattore-fq@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('9f000000-0000-0000-0000-000000000002', '9f000000-0000-0000-0000-00000000000e', 'territory_editor', null),
  ('9f000000-0000-0000-0000-000000000003', '9f000000-0000-0000-0000-00000000000f', 'territory_editor', 'zp.altro');

set role authenticated;
set request.jwt.claim.sub = '9f000000-0000-0000-0000-000000000002';
create temp table ids (k text primary key, v uuid);
grant all on ids to authenticated;
insert into ids select 'pub', (studio_save_local_business('zp.borgo', null, '{"name":"Bar Pubblico","category":"bar"}', true) ->> 'id')::uuid;
insert into ids select 'draft', (studio_save_local_business('zp.borgo', null, '{"name":"Bar Bozza","category":"bar"}') ->> 'id')::uuid;
select studio_set_local_business_publication((select v from ids where k = 'pub'), 'published');
reset role;

-- ---------------------------------------------------------------- F1
-- Un file fuori dalla cartella di un'attività esistente, o con un nome non ammesso, non si carica.
set role authenticated;
set request.jwt.claim.sub = '9f000000-0000-0000-0000-000000000002';
do $$
declare
  pub uuid := (select v from ids where k = 'pub');
  bad text;
begin
  foreach bad in array array[
    'zp.borgo/' || gen_random_uuid() || '/foto-a1.jpg',          -- attività inesistente
    'zp.altro/' || pub || '/foto-a1.jpg',                        -- territorio sbagliato (e non suo)
    'zp.borgo/' || pub || '/Foto.JPG', 'zp.borgo/' || pub || '/foto.gif', 'zp.borgo/' || pub || '/../x.jpg',
    'zp.borgo/foto.jpg'
  ] loop
    begin
      insert into storage.objects (bucket_id, name) values ('business-photos', bad);
      raise exception 'FALLITO F1: caricato %', bad;
    exception when insufficient_privilege then null;
    end;
  end loop;
  for i in 1..7 loop
    insert into storage.objects (bucket_id, name) values ('business-photos', 'zp.borgo/' || pub || '/foto-' || i || '.jpg');
  end loop;
  insert into storage.objects (bucket_id, name)
    values ('business-photos', 'zp.borgo/' || (select v from ids where k = 'draft') || '/bozza-1.webp');
end $$;

do $$
declare
  pub uuid := (select v from ids where k = 'pub');
  base text := 'zp.borgo/' || (select v from ids where k = 'pub') || '/';
  r jsonb;
  bad jsonb;
begin
  r := studio_add_business_photo(pub, jsonb_build_object('path', base || 'foto-1.jpg',
    'alt', jsonb_build_object('it', '  Il bancone  ', 'en', 'The counter', 'fr', 'Le comptoir'),
    'author', 'Mario Rossi', 'license', 'cc-by-4.0', 'source', 'own_photo'));
  if r ->> 'path' <> base || 'foto-1.jpg' then raise exception 'FALLITO F1: risposta %', r; end if;
  if (select alt from local_business_photos where id = (r ->> 'id')::uuid) <> '{"it":"Il bancone","en":"The counter"}' then
    raise exception 'FALLITO F1: testo alternativo non ripulito';
  end if;
  if (select created_by from local_business_photos where id = (r ->> 'id')::uuid) is distinct from auth.uid() then
    raise exception 'FALLITO F1: autore del caricamento';
  end if;
  perform studio_add_business_photo(pub, jsonb_build_object('path', base || 'foto-2.jpg', 'alt', '{"it":"Sala"}'::jsonb,
    'license', 'public-domain', 'source', 'web', 'originalUrl', 'https://commons.example.org/sala.jpg'));
  perform studio_add_business_photo(pub, jsonb_build_object('path', base || 'foto-3.jpg', 'alt', '{"it":"Esterno"}'::jsonb,
    'author', 'Bar Pubblico', 'license', 'licensed', 'source', 'other', 'licenseNote', 'Autorizzazione scritta del 20/10/2026'));
  foreach bad in array array[
    jsonb_build_object('path', base || 'foto-4.jpg', 'alt', '{"en":"Only English"}'::jsonb, 'author', 'X', 'license', 'cc-by-4.0', 'source', 'own_photo'),
    jsonb_build_object('path', base || 'foto-4.jpg', 'alt', '{"it":"   "}'::jsonb, 'author', 'X', 'license', 'cc-by-4.0', 'source', 'own_photo'),
    jsonb_build_object('path', base || 'foto-4.jpg', 'alt', '{"it":"A"}'::jsonb, 'license', 'cc-by-4.0', 'source', 'own_photo'),
    jsonb_build_object('path', base || 'foto-4.jpg', 'alt', '{"it":"A"}'::jsonb, 'author', 'X', 'license', 'licensed', 'source', 'other'),
    jsonb_build_object('path', base || 'foto-4.jpg', 'alt', '{"it":"A"}'::jsonb, 'author', 'X', 'license', 'cc-by-4.0', 'source', 'web'),
    jsonb_build_object('path', base || 'foto-4.jpg', 'alt', '{"it":"A"}'::jsonb, 'author', 'X', 'license', 'cc-by-4.0', 'source', 'web', 'originalUrl', 'http://x.example.org/a.jpg'),
    jsonb_build_object('path', base || 'foto-4.jpg', 'alt', '{"it":"A"}'::jsonb, 'author', 'X', 'license', 'all-rights-reserved', 'source', 'own_photo'),
    jsonb_build_object('path', base || 'foto-4.jpg', 'alt', '{"it":"A"}'::jsonb, 'author', 'X', 'license', 'cc-by-nc-4.0', 'source', 'own_photo'),
    jsonb_build_object('path', base || 'foto-4.jpg', 'alt', '{"it":"A"}'::jsonb, 'author', 'X', 'license', 'mia', 'source', 'own_photo'),
    jsonb_build_object('path', base || 'mai-caricata.jpg', 'alt', '{"it":"A"}'::jsonb, 'author', 'X', 'license', 'cc-by-4.0', 'source', 'own_photo'),
    jsonb_build_object('path', 'zp.borgo/' || (select v from ids where k = 'draft') || '/bozza-1.webp', 'alt', '{"it":"A"}'::jsonb, 'author', 'X', 'license', 'cc-by-4.0', 'source', 'own_photo'),
    jsonb_build_object('path', base || 'foto-1.jpg', 'alt', '{"it":"Doppia"}'::jsonb, 'author', 'X', 'license', 'cc-by-4.0', 'source', 'own_photo')
  ] loop
    begin
      perform studio_add_business_photo(pub, bad);
      raise exception 'FALLITO F1: accettata %', bad;
    exception when raise_exception or check_violation or unique_violation or invalid_text_representation then
      if sqlerrm like 'FALLITO%' then raise; end if;
    end;
  end loop;
  -- Una foto non cambia attività né file.
  begin
    update local_business_photos set storage_path = base || 'foto-7.jpg' where id = (r ->> 'id')::uuid;
    raise exception 'FALLITO F1: cambiato il file di una foto';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  for i in 4..6 loop
    perform studio_add_business_photo(pub, jsonb_build_object('path', base || 'foto-' || i || '.jpg', 'alt', '{"it":"Foto"}'::jsonb,
      'author', 'Mario Rossi', 'license', 'cc0', 'source', 'own_photo'));
  end loop;
  begin
    perform studio_add_business_photo(pub, jsonb_build_object('path', base || 'foto-7.jpg', 'alt', '{"it":"Settima"}'::jsonb,
      'author', 'Mario Rossi', 'license', 'cc0', 'source', 'own_photo'));
    raise exception 'FALLITO F1: accettata la settima foto';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  perform studio_add_business_photo((select v from ids where k = 'draft'), jsonb_build_object(
    'path', 'zp.borgo/' || (select v from ids where k = 'draft') || '/bozza-1.webp', 'alt', '{"it":"Bozza"}'::jsonb,
    'author', 'Mario Rossi', 'license', 'cc0', 'source', 'own_photo'));
end $$;
reset role;

-- ---------------------------------------------------------------- F2
set role authenticated;
set request.jwt.claim.sub = '9f000000-0000-0000-0000-000000000002';
do $$
declare
  pub uuid := (select v from ids where k = 'pub');
  third uuid := (select id from local_business_photos where storage_path like '%/foto-3.jpg');
  j jsonb;
  p text;
begin
  perform studio_first_business_photo(third);
  j := studio_local_business_json((select b from local_businesses b where b.id = pub));
  if j -> 'photos' -> 0 ->> 'id' <> third::text or jsonb_array_length(j -> 'photos') <> 6 then
    raise exception 'FALLITO F2: prima foto (%)', j -> 'photos';
  end if;
  if j -> 'photos' -> 0 ->> 'licenseNote' is null then raise exception 'FALLITO F2: lo Studio non vede la nota della licenza'; end if;
  p := studio_delete_business_photo((select id from local_business_photos where storage_path like '%/foto-6.jpg'));
  if p not like '%/foto-6.jpg' then raise exception 'FALLITO F2: percorso restituito %', p; end if;
  delete from storage.objects where bucket_id = 'business-photos' and name = p;
  if found is false then raise exception 'FALLITO F2: il redattore non elimina il file'; end if;
  if (select count(*) from local_business_photos where business_id = pub) <> 5 then raise exception 'FALLITO F2: eliminazione'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------- F3
set role authenticated;
set request.jwt.claim.sub = '9f000000-0000-0000-0000-000000000003';
do $$
declare pub uuid := (select v from ids where k = 'pub');
begin
  if exists (select 1 from local_business_photos) then raise exception 'FALLITO F3: un altro territorio vede le foto'; end if;
  if exists (select 1 from storage.objects where bucket_id = 'business-photos') then raise exception 'FALLITO F3: un altro territorio vede i file'; end if;
  begin
    insert into storage.objects (bucket_id, name) values ('business-photos', 'zp.borgo/' || pub || '/intruso.jpg');
    raise exception 'FALLITO F3: file caricato in un altro territorio';
  exception when insufficient_privilege then null;
  end;
  begin
    perform studio_add_business_photo(pub, jsonb_build_object('path', 'zp.borgo/' || pub || '/foto-7.jpg', 'alt', '{"it":"X"}'::jsonb,
      'author', 'X', 'license', 'cc0', 'source', 'own_photo'));
    raise exception 'FALLITO F3: foto registrata in un altro territorio';
  exception when raise_exception or insufficient_privilege then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  begin
    perform studio_delete_business_photo((select id from local_business_photos limit 1));
    raise exception 'FALLITO F3: eliminata senza vederla';
  exception when raise_exception or insufficient_privilege then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  delete from storage.objects where bucket_id = 'business-photos';
  if found then raise exception 'FALLITO F3: file eliminati da un altro territorio'; end if;
end $$;
reset role;
do $$
declare third uuid := (select id from local_business_photos where storage_path like '%/foto-3.jpg');
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '9f000000-0000-0000-0000-000000000003', true);
  begin
    perform studio_delete_business_photo(third);
    raise exception 'FALLITO F3: eliminata da un altro territorio';
  exception when raise_exception or insufficient_privilege then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  begin
    perform studio_first_business_photo(third);
    raise exception 'FALLITO F3: riordinata da un altro territorio';
  exception when raise_exception or insufficient_privilege then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
end $$;
set role anon;
do $$
begin
  begin
    perform 1 from local_business_photos;
    raise exception 'FALLITO F3: anon legge le foto';
  exception when insufficient_privilege then null;
  end;
  begin
    perform studio_add_business_photo(gen_random_uuid(), '{}');
    raise exception 'FALLITO F3: anon registra foto';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('business-photos', 'zp.borgo/' || gen_random_uuid() || '/anon.jpg');
    raise exception 'FALLITO F3: anon carica file';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ---------------------------------------------------------------- F4
set role anon;
do $$
declare
  r jsonb := public_local_businesses('zp.borgo', 'en');
  b jsonb;
  f jsonb;
begin
  if jsonb_array_length(r -> 'businesses') <> 1 then raise exception 'FALLITO F4: attività pubbliche %', r; end if;
  b := r -> 'businesses' -> 0;
  if jsonb_array_length(b -> 'photos') <> 5 then raise exception 'FALLITO F4: foto pubbliche %', b -> 'photos'; end if;
  f := b -> 'photos' -> 0;
  if f ->> 'path' not like 'zp.borgo/%/foto-3.jpg' or f ->> 'author' <> 'Bar Pubblico' or f ->> 'license' <> 'licensed' then
    raise exception 'FALLITO F4: prima foto %', f;
  end if;
  if f ? 'licenseNote' or f ? 'id' or f ? 'createdBy' or f ? 'source' then raise exception 'FALLITO F4: campi interni %', f; end if;
  -- Lingua: in inglese dove c'è, altrimenti nella principale.
  if (select x ->> 'alt' from jsonb_array_elements(b -> 'photos') x where x ->> 'path' like '%/foto-1.jpg') <> 'The counter'
     or (select x ->> 'alt' from jsonb_array_elements(b -> 'photos') x where x ->> 'path' like '%/foto-2.jpg') <> 'Sala' then
    raise exception 'FALLITO F4: testo alternativo nella lingua %', b -> 'photos';
  end if;
  if (select x ->> 'originalUrl' from jsonb_array_elements(b -> 'photos') x where x ->> 'path' like '%/foto-2.jpg') <> 'https://commons.example.org/sala.jpg' then
    raise exception 'FALLITO F4: indirizzo originale';
  end if;
end $$;
reset role;
-- Licenze non commerciali: solo dove il territorio le ammette.
set role authenticated;
set request.jwt.claim.sub = '9f000000-0000-0000-0000-000000000003';
do $$
declare b uuid := (studio_save_local_business('zp.altro', null, '{"name":"Negozio Q","category":"shop"}') ->> 'id')::uuid;
begin
  insert into storage.objects (bucket_id, name) values ('business-photos', 'zp.altro/' || b || '/nc.png');
  perform studio_add_business_photo(b, jsonb_build_object('path', 'zp.altro/' || b || '/nc.png', 'alt', '{"it":"Vetrina"}'::jsonb,
    'author', 'Anna', 'license', 'cc-by-nc-4.0', 'source', 'own_photo'));
end $$;
reset role;

-- ---------------------------------------------------------------- F5
do $$
declare f record;
begin
  for f in select * from (values
      ('studio_add_business_photo(uuid,jsonb)', false, true, false, array['search_path=public']),
      ('studio_delete_business_photo(uuid)', false, true, false, array['search_path=public']),
      ('studio_first_business_photo(uuid)', false, true, false, array['search_path=public']),
      ('business_photo_file_exists(text)', false, true, true, array['search_path=public, storage']),
      ('local_business_photos_prepare()', false, false, false, array['search_path=public'])
    ) as t(sig, anon_exec, auth_exec, definer, cfg) loop
    if has_function_privilege('anon', f.sig, 'execute') is distinct from f.anon_exec then raise exception 'FALLITO F5: anon su %', f.sig; end if;
    if has_function_privilege('authenticated', f.sig, 'execute') is distinct from f.auth_exec then raise exception 'FALLITO F5: authenticated su %', f.sig; end if;
    if (select prosecdef from pg_proc where oid = f.sig::regprocedure) is distinct from f.definer then raise exception 'FALLITO F5: SECURITY DEFINER di %', f.sig; end if;
    if (select proconfig from pg_proc where oid = f.sig::regprocedure) is distinct from f.cfg then raise exception 'FALLITO F5: search_path di %', f.sig; end if;
  end loop;
  if not (select public from storage.buckets where id = 'business-photos') then raise exception 'FALLITO F5: bucket non pubblico'; end if;
  if has_table_privilege('anon', 'local_business_photos', 'select') then raise exception 'FALLITO F5: anon sulla tabella'; end if;
end $$;

-- ---------------------------------------------------------------- pulizia (la revoca si ferma se restano foto o file)
delete from local_businesses where pack_id like 'zp.%';
delete from storage.objects where bucket_id = 'business-photos';
\echo 'foto delle attività: F1–F5 superati'
