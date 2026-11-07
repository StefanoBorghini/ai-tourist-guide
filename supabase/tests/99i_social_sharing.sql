-- Test della condivisione su Instagram (20261110000000_social_sharing.sql):
--   S1 chi pubblica salva account e hashtag: «@» e «#» tolti, doppioni tolti, ordine mantenuto, il resto di
--      packs.config non cambia; account vuoto = chiave «social» tolta;
--   S2 valori rifiutati: account non valido, hashtag con spazi o punteggiatura, solo cifre, più di 5, non elenco;
--      solo sulle destinazioni;
--   S3 chi non pubblica (collaboratore) non cambia nulla, nemmeno con una scrittura diretta su packs.config;
--   S4 permessi delle funzioni nuove.
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values ('8f000000-0000-0000-0000-00000000000f', 'institution', 'Comune S (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zs.borgo', 'destination', '8f000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Borgo S"}', '{"guide":{"defaultMode":"ask"}}'),
  ('zs.area', 'area', '8f000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Area S"}', '{}');
insert into destinations (pack_id, status) values ('zs.borgo', 'published');
insert into auth.users (id, email, raw_user_meta_data) values
  ('8f000000-0000-0000-0000-000000000002', 'redattore-social@prova.test', '{}'),
  ('8f000000-0000-0000-0000-000000000003', 'collaboratore-social@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('8f000000-0000-0000-0000-000000000002', '8f000000-0000-0000-0000-00000000000f', 'territory_editor', null),
  ('8f000000-0000-0000-0000-000000000003', '8f000000-0000-0000-0000-00000000000f', 'contributor', 'zs.borgo');

-- ---------------------------------------------------------------- S1 / S2 con l'identità di chi pubblica
set role authenticated;
set request.jwt.claim.sub = '8f000000-0000-0000-0000-000000000002';
do $$
declare
  r jsonb;
  bad jsonb;
begin
  r := studio_set_social('zs.borgo', '{"handle": " @borgo_s.it ", "hashtags": ["#BorgoS", "borgos", "Città_2026", " #Mare "]}');
  if r ->> 'handle' <> 'borgo_s.it' or r -> 'hashtags' <> '["BorgoS", "Città_2026", "Mare"]'::jsonb or not (r ->> 'canEdit')::boolean then
    raise exception 'FALLITO S1: salvataggio normalizzato: %', r;
  end if;
  if (select config from packs where id = 'zs.borgo')
     <> '{"guide":{"defaultMode":"ask"},"social":{"instagram":{"handle":"borgo_s.it","hashtags":["BorgoS","Città_2026","Mare"]}}}'::jsonb then
    raise exception 'FALLITO S1: packs.config: %', (select config from packs where id = 'zs.borgo');
  end if;

  for bad in select x from jsonb_array_elements('[
      {"handle": "con spazio"}, {"handle": ".punto"}, {"handle": "punto."}, {"handle": "due..punti"},
      {"handle": "trentunocaratteri_trentunocarat"},
      {"handle": "ok", "hashtags": ["con spazio"]}, {"handle": "ok", "hashtags": ["punto.virgola"]},
      {"handle": "ok", "hashtags": ["2026"]}, {"handle": "ok", "hashtags": ["a", "b", "c", "d", "e", "f"]},
      {"handle": "ok", "hashtags": "Mare"}]'::jsonb) x loop
    begin
      perform studio_set_social('zs.borgo', bad);
      raise exception 'FALLITO S2: accettato %', bad;
    exception when raise_exception then
      if sqlerrm like 'FALLITO%' then raise; end if;
    end;
  end loop;
  if (select config #>> '{social,instagram,handle}' from packs where id = 'zs.borgo') <> 'borgo_s.it' then
    raise exception 'FALLITO S2: un valore rifiutato ha cambiato la configurazione';
  end if;
  begin
    perform studio_set_social('zs.area', '{"handle": "area_s"}');
    raise exception 'FALLITO S2: social su un pack che non è una destinazione';
  exception when raise_exception then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
end $$;
reset role;

-- ---------------------------------------------------------------- S3 il collaboratore non cambia nulla
set role authenticated;
set request.jwt.claim.sub = '8f000000-0000-0000-0000-000000000003';
do $$
begin
  if (studio_social('zs.borgo') ->> 'canEdit')::boolean then raise exception 'FALLITO S3: canEdit per il collaboratore'; end if;
  begin
    perform studio_set_social('zs.borgo', '{"handle": "altro_account"}');
    raise exception 'FALLITO S3: il collaboratore ha cambiato l''account';
  exception when others then
    if sqlerrm like 'FALLITO%' then raise; end if;
  end;
  begin
    update packs set config = jsonb_set(config, '{social,instagram,handle}', '"altro_account"') where id = 'zs.borgo';
  exception when others then null;
  end;
end $$;
reset role;
do $$
begin
  if (select config #>> '{social,instagram,handle}' from packs where id = 'zs.borgo') <> 'borgo_s.it' then
    raise exception 'FALLITO S3: account cambiato da chi non pubblica';
  end if;
end $$;

-- ---------------------------------------------------------------- S1 account vuoto: configurazione com'era
set role authenticated;
set request.jwt.claim.sub = '8f000000-0000-0000-0000-000000000002';
do $$
begin
  perform studio_set_social('zs.borgo', '{"handle": "", "hashtags": ["Mare"]}');
end $$;
reset role;
do $$
begin
  if (select config from packs where id = 'zs.borgo') <> '{"guide":{"defaultMode":"ask"}}'::jsonb then
    raise exception 'FALLITO S1: account vuoto non toglie «social»: %', (select config from packs where id = 'zs.borgo');
  end if;
end $$;

-- ---------------------------------------------------------------- S4 permessi
do $$
declare f record;
begin
  for f in select * from (values ('studio_social(text)'), ('studio_set_social(text,jsonb)')) as t(sig) loop
    if has_function_privilege('anon', f.sig, 'execute') then raise exception 'FALLITO S4: anon su %', f.sig; end if;
    if not has_function_privilege('authenticated', f.sig, 'execute') then raise exception 'FALLITO S4: authenticated su %', f.sig; end if;
    if (select prosecdef from pg_proc where oid = f.sig::regprocedure) then raise exception 'FALLITO S4: SECURITY DEFINER di %', f.sig; end if;
    if (select proconfig from pg_proc where oid = f.sig::regprocedure) is distinct from array['search_path=public'] then
      raise exception 'FALLITO S4: search_path di %', f.sig;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- pulizia
delete from memberships where organization_id = '8f000000-0000-0000-0000-00000000000f';
delete from destinations where pack_id = 'zs.borgo';
delete from packs where id in ('zs.borgo', 'zs.area');
delete from auth.users where id in ('8f000000-0000-0000-0000-000000000002', '8f000000-0000-0000-0000-000000000003');
delete from organizations where id = '8f000000-0000-0000-0000-00000000000f';
\echo 'condivisione Instagram: S1–S4 superati'
