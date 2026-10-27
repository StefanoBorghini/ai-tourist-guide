-- Test delle informazioni pratiche dallo Studio (20261104000000_studio_practical.sql):
--   P1 un redattore del territorio le salva; la scheda del luogo e pack_snapshot() le restituiscono nel formato del pack;
--   P2 regole dello schema del Territory Pack: tipo, identificativo unico, testo nella lingua principale, data non nel
--      futuro, giorni di validità, fonte del territorio, numero massimo;
--   P3 permessi: redattore di un'altra organizzazione, esperto e anon non le scrivono;
--   P4 un elenco vuoto le toglie;
--   P5 proprietà della funzione (non definer, search_path, permessi).
-- Usa un territorio proprio (zk.*) e alla fine lo lascia: non contiene dati che fermino le revoche.
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values
  ('9d000000-0000-0000-0000-00000000000e', 'institution', 'Comune K (prova)'),
  ('9d000000-0000-0000-0000-00000000000f', 'institution', 'Comune K2 (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zk.pratico', 'destination', '9d000000-0000-0000-0000-00000000000e', 'it', '{it,en}', '{"it":"Pratico"}', '{}'),
  ('zk.altro', 'destination', '9d000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Altro"}', '{}');
insert into destinations (pack_id, status) values ('zk.pratico', 'published'), ('zk.altro', 'published');
insert into nodes (id, pack_id, slug, kind) values
  ('9d000000-0000-0000-0000-0000000000a1', 'zk.pratico', 'grotta', 'place');
insert into places (node_id, place_kind, location, importance, dwell_min) values
  ('9d000000-0000-0000-0000-0000000000a1', 'poi', 'SRID=4326;POINT(9.83 44.05)', 3, 5);
insert into sources (pack_id, slug, kind, title, reliability) values
  ('zk.pratico', 'parco', 'web', 'Sito del Parco (prova)', 'A'),
  ('zk.altro', 'comune', 'web', 'Sito del Comune (prova)', 'A');
insert into auth.users (id, email, raw_user_meta_data) values
  ('9d000000-0000-0000-0000-000000000002', 'pratiche-redattore@prova.test', '{}'),
  ('9d000000-0000-0000-0000-000000000003', 'pratiche-altro@prova.test', '{}'),
  ('9d000000-0000-0000-0000-000000000004', 'pratiche-esperto@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('9d000000-0000-0000-0000-000000000002', '9d000000-0000-0000-0000-00000000000e', 'territory_editor', 'zk.pratico'),
  ('9d000000-0000-0000-0000-000000000003', '9d000000-0000-0000-0000-00000000000f', 'territory_editor', 'zk.altro'),
  ('9d000000-0000-0000-0000-000000000004', '9d000000-0000-0000-0000-00000000000e', 'expert', 'zk.pratico');

-- ---------------------------------------------------------------- P1 e P2
set role authenticated;
set request.jwt.claim.sub = '9d000000-0000-0000-0000-000000000002';
do $$
declare
  ok jsonb := jsonb_build_array(
    jsonb_build_object('id', 'orari', 'kind', 'opening_hours', 'text', jsonb_build_object('it', '  Aperta dalle 9 alle 18.  ', 'en', 'Open 9 to 6.', 'xx', 'lingua ignorata'),
                       'checkedAt', to_char(current_date - 3, 'YYYY-MM-DD'), 'recheckAfterDays', 60, 'source', 'parco'),
    jsonb_build_object('id', 'accesso', 'kind', 'access', 'text', jsonb_build_object('it', 'Solo in barca.'), 'checkedAt', to_char(current_date, 'YYYY-MM-DD')));
  p jsonb;
  bad jsonb;
  item jsonb;
  msgs text[] := array[
    'tipo non valido', 'identificativo non valido', 'ripetuta', 'manca il testo in it', 'nel futuro',
    'data del controllo non valida', 'da ricontrollare dopo 1–730 giorni', 'fonte non trovata', 'serve un elenco', 'al massimo 30'];
  cases jsonb[];
  k int;
begin
  p := studio_set_practical('zk.pratico', 'grotta', ok);
  if jsonb_array_length(p -> 'practical') <> 2 then raise exception 'FALLITO P1: scheda senza le due informazioni'; end if;
  item := p -> 'practical' -> 0;
  if item <> jsonb_build_object('id', 'orari', 'kind', 'opening_hours', 'text', jsonb_build_object('it', 'Aperta dalle 9 alle 18.', 'en', 'Open 9 to 6.'),
                                'checkedAt', to_char(current_date - 3, 'YYYY-MM-DD'), 'recheckAfterDays', 60, 'source', 'parco') then
    raise exception 'FALLITO P1: formato salvato inatteso: %', item;
  end if;
  if (p -> 'practical' -> 1 ->> 'recheckAfterDays')::int <> 90 or p -> 'practical' -> 1 ? 'source' then
    raise exception 'FALLITO P1: valori predefiniti inattesi: %', p -> 'practical' -> 1;
  end if;

  cases := array[
    jsonb_build_array(jsonb_set(ok -> 0, '{kind}', '"meteo"')),
    jsonb_build_array(jsonb_set(ok -> 0, '{id}', '"Orari!"')),
    jsonb_build_array(ok -> 0, ok -> 0),
    jsonb_build_array(jsonb_set(ok -> 0, '{text}', '{"en":"Only English"}')),
    jsonb_build_array(jsonb_set(ok -> 0, '{checkedAt}', to_jsonb(to_char(current_date + 5, 'YYYY-MM-DD')))),
    jsonb_build_array(jsonb_set(ok -> 0, '{checkedAt}', '"27/10/2026"')),
    jsonb_build_array(jsonb_set(ok -> 0, '{recheckAfterDays}', '0')),
    jsonb_build_array(jsonb_set(ok -> 0, '{source}', '"comune"')),
    '{"id":"orari"}'::jsonb,
    (select jsonb_agg(jsonb_set(ok -> 1, '{id}', to_jsonb('a' || g))) from generate_series(1, 31) g)];
  for k in 1 .. array_length(cases, 1) loop
    begin
      perform studio_set_practical('zk.pratico', 'grotta', cases[k]);
      raise exception 'FALLITO P2: accettato il caso «%»', msgs[k];
    exception when others then
      if sqlerrm like 'FALLITO%' then raise; end if;
      if sqlerrm not like '%' || msgs[k] || '%' then raise exception 'FALLITO P2: per «%» messaggio inatteso: %', msgs[k], sqlerrm; end if;
    end;
  end loop;
  -- Nessun caso rifiutato ha cambiato i dati.
  if jsonb_array_length(studio_place('zk.pratico', 'grotta') -> 'practical') <> 2 then raise exception 'FALLITO P2: dati cambiati da un rifiuto'; end if;
end $$;
reset role;

-- Il formato salvato è quello del Territory Pack: pack_snapshot() lo esporta così com'è.
do $$ begin
  if (select pl -> 'practical' from jsonb_array_elements(pack_snapshot('zk.pratico') -> 'places') pl where pl ->> 'id' = 'grotta') is distinct from
     (select practical from places where node_id = '9d000000-0000-0000-0000-0000000000a1') then
    raise exception 'FALLITO P1: pack_snapshot non esporta le informazioni pratiche salvate';
  end if;
end $$;

-- ---------------------------------------------------------------- P3
set role authenticated;
do $$
declare u text;
begin
  foreach u in array array['9d000000-0000-0000-0000-000000000003', '9d000000-0000-0000-0000-000000000004'] loop
    perform set_config('request.jwt.claim.sub', u, true);
    begin
      perform studio_set_practical('zk.pratico', 'grotta', '[]');
      raise exception 'FALLITO P3: % ha modificato le informazioni pratiche', u;
    exception when others then
      if sqlerrm like 'FALLITO%' then raise; end if;
      if sqlerrm not like '%non hai i permessi%' then raise exception 'FALLITO P3: messaggio inatteso: %', sqlerrm; end if;
    end;
  end loop;
end $$;
reset role;
do $$ begin
  if has_function_privilege('anon', 'studio_set_practical(text,text,jsonb)', 'execute') then raise exception 'FALLITO P3: anon esegue studio_set_practical'; end if;
  if jsonb_array_length((select practical from places where node_id = '9d000000-0000-0000-0000-0000000000a1')) <> 2 then
    raise exception 'FALLITO P3: dati cambiati da un utente senza permessi';
  end if;
end $$;

-- ---------------------------------------------------------------- P4
set role authenticated;
set request.jwt.claim.sub = '9d000000-0000-0000-0000-000000000002';
do $$ begin
  if jsonb_array_length(studio_set_practical('zk.pratico', 'grotta', '[]') -> 'practical') <> 0 then raise exception 'FALLITO P4: elenco vuoto non le toglie'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------- P5
do $$ begin
  if not has_function_privilege('authenticated', 'studio_set_practical(text,text,jsonb)', 'execute') then raise exception 'FALLITO P5: authenticated non esegue'; end if;
  if (select prosecdef from pg_proc where oid = 'studio_set_practical(text,text,jsonb)'::regprocedure) then raise exception 'FALLITO P5: SECURITY DEFINER'; end if;
  if (select proconfig from pg_proc where oid = 'studio_set_practical(text,text,jsonb)'::regprocedure) is distinct from array['search_path=public, extensions'] then
    raise exception 'FALLITO P5: search_path';
  end if;
end $$;
\echo 'informazioni pratiche: P1–P5 superati'
