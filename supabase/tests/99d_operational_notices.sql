-- Test degli avvisi operativi (20261105000000_operational_notices.sql):
--   O1 bozza, verifica, pubblicazione e lettura pubblica (solo campi pubblici, lingua con ripiego);
--   O2 un avviso pubblicato cambiato senza riverifica si rifiuta; con la verifica nello stesso salvataggio passa;
--   O3 validità: non ancora iniziato o scaduto non si legge; scaduto non si pubblica; al massimo 180 giorni;
--   O4 permessi: redattore di un'altra organizzazione ed esperto non scrivono; anon non legge la tabella; una
--      destinazione in bozza non si legge;
--   O5 integrità: soggetto dello stesso territorio, non luogo e percorso insieme, fonte solo https;
--   O6 eliminazione: un avviso pubblicato lo elimina solo l'amministratore; le bozze chi modifica il territorio;
--   O7 proprietà delle funzioni.
-- Usa territori propri (zn.*) e alla fine elimina gli avvisi, così la revoca (che si ferma se ne restano) è provabile.
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values
  ('a5000000-0000-0000-0000-00000000000e', 'institution', 'Comune N (prova)'),
  ('a5000000-0000-0000-0000-00000000000f', 'institution', 'Comune N2 (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zn.avvisi', 'destination', 'a5000000-0000-0000-0000-00000000000e', 'it', '{it,en}', '{"it":"Avvisi"}', '{}'),
  ('zn.altro', 'destination', 'a5000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Altro"}', '{}'),
  ('zn.bozza', 'destination', 'a5000000-0000-0000-0000-00000000000e', 'it', '{it}', '{"it":"Bozza"}', '{}');
insert into destinations (pack_id, status) values ('zn.avvisi', 'published'), ('zn.altro', 'published'), ('zn.bozza', 'draft');
insert into nodes (id, pack_id, slug, kind) values
  ('a5000000-0000-0000-0000-0000000000a1', 'zn.avvisi', 'belvedere', 'place'),
  ('a5000000-0000-0000-0000-0000000000a2', 'zn.altro', 'molo', 'place');
insert into places (node_id, place_kind, location, importance, dwell_min) values
  ('a5000000-0000-0000-0000-0000000000a1', 'poi', 'SRID=4326;POINT(9.83 44.05)', 3, 5),
  ('a5000000-0000-0000-0000-0000000000a2', 'poi', 'SRID=4326;POINT(9.84 44.06)', 3, 5);
insert into routes (id, pack_id, slug, duration_min, labels) values
  ('a5000000-0000-0000-0000-0000000000b1', 'zn.avvisi', 'sentiero', 120, '{"it":{"name":"Sentiero"}}');
insert into auth.users (id, email, raw_user_meta_data) values
  ('a5000000-0000-0000-0000-000000000001', 'avvisi-admin@prova.test', '{}'),
  ('a5000000-0000-0000-0000-000000000002', 'avvisi-redattore@prova.test', '{}'),
  ('a5000000-0000-0000-0000-000000000003', 'avvisi-altro@prova.test', '{}'),
  ('a5000000-0000-0000-0000-000000000004', 'avvisi-esperto@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('a5000000-0000-0000-0000-000000000001', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin', null),
  ('a5000000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-00000000000e', 'territory_editor', 'zn.avvisi'),
  ('a5000000-0000-0000-0000-000000000003', 'a5000000-0000-0000-0000-00000000000f', 'territory_editor', 'zn.altro'),
  ('a5000000-0000-0000-0000-000000000004', 'a5000000-0000-0000-0000-00000000000e', 'expert', 'zn.avvisi');

create temporary table n_days as select (now() at time zone 'Europe/Rome')::date as today;
grant select on n_days to authenticated, anon;

-- ---------------------------------------------------------------- O1, O2, O3, O5
set role authenticated;
set request.jwt.claim.sub = 'a5000000-0000-0000-0000-000000000002';
do $$
declare
  t date := (select today from n_days);
  base jsonb;
  o jsonb;
  v_id uuid;
  bad text;
begin
  base := jsonb_build_object('status', 'closed', 'route', 'sentiero',
    'labels', jsonb_build_object('it', jsonb_build_object('title', 'Sentiero chiuso per frana', 'text', '  Tratto   interdetto fino a nuovo avviso. '),
                                 'en', jsonb_build_object('title', 'Trail closed (landslide)')),
    'validFrom', t - 1, 'validUntil', t + 10);
  o := studio_save_operational_notice('zn.avvisi', null, base);
  v_id := (o ->> 'id')::uuid;
  if o ->> 'publication' <> 'draft' or o ->> 'verifiedAt' is not null then raise exception 'FALLITO O1: non nasce in bozza'; end if;
  if o #>> '{labels,it,text}' <> 'Tratto interdetto fino a nuovo avviso.' then raise exception 'FALLITO O1: testo non ripulito: %', o #>> '{labels,it,text}'; end if;
  begin
    perform studio_set_operational_notice_publication(v_id, 'published');
    raise exception 'FALLITO O1: pubblicato senza fonte';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  o := studio_save_operational_notice('zn.avvisi', v_id, base || '{"sourceUrl": "https://www.parco.example/avvisi/frana"}', false);
  begin
    perform studio_set_operational_notice_publication(v_id, 'published');
    raise exception 'FALLITO O1: pubblicato senza verifica';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  o := studio_verify_operational_notice(v_id, 'Controllata la pagina del Parco');
  if o ->> 'verifiedAt' is null then raise exception 'FALLITO O1: verifica non registrata'; end if;
  o := studio_set_operational_notice_publication(v_id, 'published');
  if o ->> 'publication' <> 'published' then raise exception 'FALLITO O1: non pubblicato'; end if;

  -- O2: cambiare un avviso pubblicato senza riverificare non si può; con la verifica nello stesso salvataggio sì.
  begin
    perform studio_save_operational_notice('zn.avvisi', v_id, base || '{"sourceUrl": "https://www.parco.example/avvisi/frana", "status": "open"}', false);
    raise exception 'FALLITO O2: cambiato un avviso pubblicato senza riverifica';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  o := studio_save_operational_notice('zn.avvisi', v_id, base || '{"sourceUrl": "https://www.parco.example/avvisi/frana", "status": "restricted"}', true);
  if o ->> 'status' <> 'restricted' or o ->> 'verifiedAt' is null or o ->> 'publication' <> 'published' then raise exception 'FALLITO O2: salvataggio con verifica'; end if;
  -- Non si cambiano verifica o pubblicazione scrivendo direttamente nella tabella.
  begin
    update operational_notices set publication = 'withdrawn' where id = v_id;
    raise exception 'FALLITO O2: pubblicazione cambiata fuori dallo Studio';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;

  -- O3: altri avvisi per le prove di validità.
  o := studio_save_operational_notice('zn.avvisi', null, jsonb_build_object('slug', 'futuro', 'status', 'booking_required', 'place', 'belvedere',
         'labels', '{"it":{"title":"Solo su prenotazione da domani"}}'::jsonb, 'sourceUrl', 'https://www.comune.example/ordinanza',
         'validFrom', t + 1, 'validUntil', t + 5), true);
  perform studio_set_operational_notice_publication((o ->> 'id')::uuid, 'published');
  o := studio_save_operational_notice('zn.avvisi', null, jsonb_build_object('slug', 'scaduto', 'status', 'caution',
         'labels', '{"it":{"title":"Lavori conclusi"}}'::jsonb, 'sourceUrl', 'https://www.comune.example/lavori',
         'validFrom', t - 10, 'validUntil', t - 1), true);
  begin
    perform studio_set_operational_notice_publication((o ->> 'id')::uuid, 'published');
    raise exception 'FALLITO O3: pubblicato un avviso scaduto';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  foreach bad in array array[
      jsonb_build_object('status', 'closed', 'labels', '{"it":{"title":"Troppo lungo"}}'::jsonb, 'validFrom', t, 'validUntil', t + 181)::text,
      jsonb_build_object('status', 'closed', 'labels', '{"it":{"title":"Al contrario"}}'::jsonb, 'validFrom', t, 'validUntil', t - 1)::text,
      jsonb_build_object('status', 'meteo', 'labels', '{"it":{"title":"Stato sbagliato"}}'::jsonb, 'validFrom', t, 'validUntil', t)::text,
      jsonb_build_object('status', 'closed', 'labels', '{"en":{"title":"Only English"}}'::jsonb, 'validFrom', t, 'validUntil', t)::text,
      -- O5
      jsonb_build_object('status', 'closed', 'place', 'molo', 'labels', '{"it":{"title":"Altro territorio"}}'::jsonb, 'validFrom', t, 'validUntil', t)::text,
      jsonb_build_object('status', 'closed', 'place', 'belvedere', 'route', 'sentiero', 'labels', '{"it":{"title":"Due soggetti"}}'::jsonb, 'validFrom', t, 'validUntil', t)::text,
      jsonb_build_object('status', 'closed', 'sourceUrl', 'http://www.parco.example', 'labels', '{"it":{"title":"Non https"}}'::jsonb, 'validFrom', t, 'validUntil', t)::text
    ] loop
    begin
      perform studio_save_operational_notice('zn.avvisi', null, bad::jsonb);
      raise exception 'FALLITO O3/O5: accettato %', bad;
    exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  end loop;
end $$;
reset role;

-- Lettura pubblica (anon): solo l'avviso in vigore, solo campi pubblici, lingua con ripiego.
set role anon;
do $$
declare r jsonb;
begin
  r := public_operational_notices('zn.avvisi', 'en');
  if jsonb_array_length(r -> 'notices') <> 1 then raise exception 'FALLITO O3: avvisi pubblici inattesi: %', r -> 'notices'; end if;
  if r -> 'notices' -> 0 ->> 'title' <> 'Trail closed (landslide)' or r -> 'notices' -> 0 ->> 'route' <> 'zn.avvisi:sentiero'
     or r -> 'notices' -> 0 ->> 'status' <> 'restricted' then
    raise exception 'FALLITO O1: avviso pubblico inatteso: %', r -> 'notices' -> 0;
  end if;
  if (r -> 'notices' -> 0) ?| array['verificationNote', 'verifiedBy', 'publication', 'id', 'createdBy'] then
    raise exception 'FALLITO O1: campi interni nella lettura pubblica';
  end if;
  -- Il testo in inglese manca: torna quello italiano, con la lingua dichiarata.
  if (public_operational_notices('zn.avvisi', 'it') -> 'notices' -> 0 ->> 'text') <> 'Tratto interdetto fino a nuovo avviso.' then
    raise exception 'FALLITO O1: testo italiano';
  end if;
  if public_operational_notices('zn.bozza') is not null then raise exception 'FALLITO O4: letta una destinazione in bozza'; end if;
  begin
    perform public_operational_notices('zn.avvisi', 'de');
    raise exception 'FALLITO O1: lingua non disponibile accettata';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform count(*) from operational_notices;
    raise exception 'FALLITO O4: anon legge la tabella';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- O4
set role authenticated;
do $$
declare u text;
begin
  foreach u in array array['a5000000-0000-0000-0000-000000000003', 'a5000000-0000-0000-0000-000000000004'] loop
    perform set_config('request.jwt.claim.sub', u, true);
    if jsonb_array_length(studio_operational_notices('zn.avvisi')) <> 0 then raise exception 'FALLITO O4: % vede gli avvisi', u; end if;
    begin
      perform studio_save_operational_notice('zn.avvisi', null, jsonb_build_object('status', 'open', 'labels', '{"it":{"title":"Intruso"}}'::jsonb,
                'validFrom', current_date, 'validUntil', current_date));
      raise exception 'FALLITO O4: % ha creato un avviso', u;
    exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  end loop;
end $$;
reset role;

-- ---------------------------------------------------------------- O6
set role authenticated;
set request.jwt.claim.sub = 'a5000000-0000-0000-0000-000000000002';
do $$ begin
  begin
    perform studio_delete_operational_notice((select id from operational_notices where pack_id = 'zn.avvisi' and publication = 'published' limit 1));
    raise exception 'FALLITO O6: il redattore ha eliminato un avviso pubblicato';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  perform studio_delete_operational_notice((select id from operational_notices where pack_id = 'zn.avvisi' and slug = 'scaduto'));
  if exists (select 1 from operational_notices where slug = 'scaduto') then raise exception 'FALLITO O6: bozza non eliminata'; end if;
end $$;
set request.jwt.claim.sub = 'a5000000-0000-0000-0000-000000000001';
do $$ begin
  perform studio_delete_operational_notice((select id from operational_notices where pack_id = 'zn.avvisi' and slug = 'futuro'));
end $$;
reset role;

-- ---------------------------------------------------------------- O7
do $$
declare f record;
begin
  for f in select * from (values
      ('public_operational_notices(text,text)', true, true, true),
      ('studio_save_operational_notice(text,uuid,jsonb,boolean)', false, true, false),
      ('studio_set_operational_notice_publication(uuid,text)', false, true, false),
      ('studio_verify_operational_notice(uuid,text)', false, true, false),
      ('studio_delete_operational_notice(uuid)', false, true, false),
      ('operational_notices_guard()', false, false, false),
      ('operational_notices_prepare()', false, false, false)
    ) as t(sig, anon_exec, auth_exec, definer) loop
    if has_function_privilege('anon', f.sig, 'execute') is distinct from f.anon_exec then raise exception 'FALLITO O7: anon su %', f.sig; end if;
    if has_function_privilege('authenticated', f.sig, 'execute') is distinct from f.auth_exec then raise exception 'FALLITO O7: authenticated su %', f.sig; end if;
    if (select prosecdef from pg_proc where oid = f.sig::regprocedure) is distinct from f.definer then raise exception 'FALLITO O7: SECURITY DEFINER di %', f.sig; end if;
    if (select proconfig from pg_proc where oid = f.sig::regprocedure) is distinct from array['search_path=public'] then
      raise exception 'FALLITO O7: search_path di %', f.sig;
    end if;
  end loop;
  if has_table_privilege('anon', 'operational_notices', 'select') then raise exception 'FALLITO O7: anon ha privilegi sulla tabella'; end if;
end $$;

-- ---------------------------------------------------------------- pulizia (la revoca si ferma se restano avvisi)
delete from operational_notices where pack_id like 'zn.%';
\echo 'avvisi operativi: O1–O7 superati'
