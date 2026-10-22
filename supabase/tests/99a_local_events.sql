-- Test degli eventi del giorno (20261031000000_local_events.sql):
--   E1 creazione e integrità: titolo obbligatorio, luogo dello stesso territorio, indirizzi solo https, orari
--      calcolati nel fuso della destinazione, eventi oltre la mezzanotte, cambio dell'ora rifiutato;
--   E2 permessi: expert, translator, redattore di un'altra organizzazione e anon non leggono né scrivono;
--   E3 pubblicazione: niente senza fonte e verifica, stato e verifica solo dallo Studio, modifiche che azzerano la
--      verifica, annullamento senza ritiro, ritiro, eliminazione;
--   E4 lettura pubblica: solo pubblicati e non conclusi, solo campi pubblici, periodo massimo, lingua, isolamento;
--   E5 fuso orario: valido, lo cambia solo l'amministratore, gli eventi si ricalcolano;
--   E6 proprietà delle funzioni (definer, search_path, permessi).
-- Usa territori propri (ze.*): non dipende dall'ordine rispetto agli altri file. Alla fine li ripulisce, così la
-- revoca della migrazione (che si ferma se ci sono eventi) resta provabile da run.sh.
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values
  ('9e000000-0000-0000-0000-00000000000e', 'institution', 'Comune E (prova)'),
  ('9e000000-0000-0000-0000-00000000000f', 'institution', 'Comune F (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('ze.eventi', 'destination', '9e000000-0000-0000-0000-00000000000e', 'it', '{it,en}', '{"it":"Eventi"}', '{}'),
  ('ze.altro', 'destination', '9e000000-0000-0000-0000-00000000000f', 'it', '{it}', '{"it":"Altro"}', '{}'),
  ('ze.bozza', 'destination', '9e000000-0000-0000-0000-00000000000e', 'it', '{it}', '{"it":"Bozza"}', '{}'),
  ('ze.lontano', 'destination', '9e000000-0000-0000-0000-00000000000e', 'it', '{it}', '{"it":"Lontano"}', '{}'),
  ('ze.regione', 'region', '9e000000-0000-0000-0000-00000000000e', 'it', '{it}', '{"it":"Regione"}', '{}');
insert into destinations (pack_id, status) values
  ('ze.eventi', 'published'), ('ze.altro', 'published'), ('ze.bozza', 'draft'), ('ze.lontano', 'published');
insert into nodes (id, pack_id, slug, kind) values
  ('9e000000-0000-0000-0000-0000000000a1', 'ze.eventi', 'piazza', 'place'),
  ('9e000000-0000-0000-0000-0000000000a2', 'ze.altro', 'molo', 'place');
insert into places (node_id, place_kind, location, importance, dwell_min) values
  ('9e000000-0000-0000-0000-0000000000a1', 'poi', 'SRID=4326;POINT(9.83 44.05)', 3, 5),
  ('9e000000-0000-0000-0000-0000000000a2', 'poi', 'SRID=4326;POINT(9.84 44.06)', 3, 5);
insert into auth.users (id, email, raw_user_meta_data) values
  ('9e000000-0000-0000-0000-000000000001', 'admin-e@prova.test', '{}'),
  ('9e000000-0000-0000-0000-000000000002', 'redattore-e@prova.test', '{}'),
  ('9e000000-0000-0000-0000-000000000003', 'redattore-f@prova.test', '{}'),
  ('9e000000-0000-0000-0000-000000000004', 'esperto-e@prova.test', '{}'),
  ('9e000000-0000-0000-0000-000000000005', 'traduttore-e@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('9e000000-0000-0000-0000-000000000001', (select id from organizations where kind = 'platform' order by created_at limit 1), 'platform_admin', null),
  ('9e000000-0000-0000-0000-000000000002', '9e000000-0000-0000-0000-00000000000e', 'territory_editor', 'ze.eventi'),
  ('9e000000-0000-0000-0000-000000000003', '9e000000-0000-0000-0000-00000000000f', 'territory_editor', 'ze.altro'),
  ('9e000000-0000-0000-0000-000000000004', '9e000000-0000-0000-0000-00000000000e', 'expert', 'ze.eventi'),
  ('9e000000-0000-0000-0000-000000000005', '9e000000-0000-0000-0000-00000000000e', 'translator', 'ze.eventi');

-- Giorni di riferimento nel fuso del territorio (il server dei test è in UTC).
create temporary table e_days as
  select (now() at time zone 'Europe/Rome')::date as today;
grant select on e_days to authenticated, anon;

-- ---------------------------------------------------------------- E1
set role authenticated;
set request.jwt.claim.sub = '9e000000-0000-0000-0000-000000000002';
do $$
declare
  d date := (select today from e_days) + 2;
  e jsonb;
  bad text;
begin
  -- Gli eventi di prova (anche quello che finisce alle 02:00 del giorno dopo) non devono cadere sul cambio dell'ora:
  -- se tra d e d+2 l'ora cambia, si sposta di tre giorni (resta nei 7 giorni delle viste).
  if ((d + 2)::timestamp at time zone 'Europe/Rome') - (d::timestamp at time zone 'Europe/Rome') <> interval '48 hours' then
    d := d + 3;
  end if;
  e := studio_save_local_event('ze.eventi', null, jsonb_build_object(
    'slug', 'concerto', 'category', 'music', 'startDate', d, 'startTime', '21:00',
    'labels', jsonb_build_object('it', jsonb_build_object('title', '  Concerto in piazza  ', 'summary', 'Musica'), 'fr', jsonb_build_object('title', 'Concert')),
    'venueName', 'Piazza', 'place', 'piazza', 'sourceUrl', 'https://www.comune.example.it/eventi/concerto', 'price', 'free'));
  if e ->> 'publication' <> 'draft' then raise exception 'FALLITO E1: un evento nuovo non nasce in bozza'; end if;
  if (e ->> 'startsAt')::timestamptz <> ((d + time '21:00') at time zone 'Europe/Rome') then
    raise exception 'FALLITO E1: inizio non calcolato nel fuso della destinazione: %', e ->> 'startsAt';
  end if;
  if (e ->> 'endsAt')::timestamptz <> ((d + 1)::timestamp at time zone 'Europe/Rome') then
    raise exception 'FALLITO E1: senza orario di fine l''evento non dura fino alla fine del giorno';
  end if;
  if e -> 'labels' <> '{"it":{"title":"Concerto in piazza","summary":"Musica"}}' then
    raise exception 'FALLITO E1: testi non ripuliti (lingue non abilitate, spazi): %', e -> 'labels';
  end if;
  if e ->> 'place' <> 'piazza' then raise exception 'FALLITO E1: luogo collegato perso'; end if;

  -- Oltre la mezzanotte: dalle 22 alle 2 del giorno dopo.
  e := studio_save_local_event('ze.eventi', null, jsonb_build_object(
    'slug', 'notte-bianca', 'category', 'local_initiatives', 'startDate', d, 'startTime', '22:00', 'endDate', d + 1, 'endTime', '02:00',
    'labels', '{"it":{"title":"Notte bianca"}}'::jsonb, 'venueName', 'Centro storico', 'sourceUrl', 'https://www.comune.example.it/notte'));
  if (e ->> 'endsAt')::timestamptz <> ((d + 1 + time '02:00') at time zone 'Europe/Rome') then
    raise exception 'FALLITO E1: fine dell''evento oltre la mezzanotte';
  end if;
  -- Orario da confermare: tutta la giornata; slug ricavato dal titolo e dalla data.
  e := studio_save_local_event('ze.eventi', null, jsonb_build_object(
    'category', 'fairs_markets', 'startDate', d, 'labels', '{"it":{"title":"Mercatino dell''antiquariato"}}'::jsonb, 'venueName', 'Lungomare'));
  if e ->> 'slug' <> studio_slugify('Mercatino dell''antiquariato') || '-' || to_char(d, 'YYYYMMDD') then raise exception 'FALLITO E1: slug %', e ->> 'slug'; end if;
  if (e ->> 'startsAt')::timestamptz <> (d::timestamp at time zone 'Europe/Rome') then raise exception 'FALLITO E1: giornata senza orario'; end if;

  -- Rifiuti con un messaggio chiaro.
  foreach bad in array array[
    'titolo', 'luogo-altrui', 'http', 'javascript', 'credenziali', 'spazio', 'fine-prima', 'fine-senza-inizio',
    'troppo-lungo', 'ora-inesistente', 'ora-doppia', 'categoria', 'data'] loop
    begin
      perform studio_save_local_event('ze.eventi', null, jsonb_build_object(
        'slug', 'prova-' || bad, 'category', case bad when 'categoria' then 'sagra' else 'culture' end,
        'startDate', case bad when 'ora-inesistente' then '2027-03-28' when 'ora-doppia' then '2027-10-31' when 'data' then '2026-02-30' else d::text end,
        'startTime', case when bad in ('ora-inesistente', 'ora-doppia') then '02:30' when bad = 'fine-senza-inizio' then null else '20:00' end,
        'endDate', case bad when 'fine-prima' then (d - 1)::text when 'troppo-lungo' then (d + 61)::text end,
        'endTime', case bad when 'fine-senza-inizio' then '23:00' end,
        'labels', case bad when 'titolo' then '{"it":{"summary":"Senza titolo"}}'::jsonb else '{"it":{"title":"Prova"}}'::jsonb end,
        'venueName', 'Piazza', 'place', case bad when 'luogo-altrui' then 'molo' end,
        'sourceUrl', case bad when 'http' then 'http://www.comune.example.it/' when 'javascript' then 'javascript:alert(1)'
                              when 'credenziali' then 'https://utente:segreto@example.org/' when 'spazio' then 'https://example.org/a b' end));
      raise exception 'FALLITO E1: accettato un evento non valido (%)', bad;
    exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  end loop;
  -- Il messaggio del cambio dell'ora dice cosa fare.
  begin
    perform studio_save_local_event('ze.eventi', null, '{"slug":"x","category":"culture","startDate":"2027-03-28","startTime":"02:30","labels":{"it":{"title":"X"}},"venueName":"P"}');
  exception when others then
    if sqlerrm not like '%non esiste per il cambio dell''ora%' then raise exception 'FALLITO E1: messaggio %', sqlerrm; end if;
  end;
  -- Direttamente nella tabella: un evento nasce in bozza, e non in un territorio che non è una destinazione.
  begin
    insert into local_events (pack_id, slug, labels, category, start_date, venue_name, publication, source_url, verified_at, verified_by)
    values ('ze.eventi', 'diretto', '{"it":{"title":"D"}}', 'culture', d, 'P', 'published', 'https://example.org/', now(), auth.uid());
    raise exception 'FALLITO E1: inserito direttamente un evento pubblicato';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;
reset role;
do $$ begin
  begin
    insert into local_events (pack_id, slug, labels, category, start_date, venue_name)
    values ('ze.regione', 'in-regione', '{"it":{"title":"R"}}', 'culture', current_date, 'P');
    raise exception 'FALLITO E1: evento in un territorio che non è una destinazione';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  if (select count(*) from local_events where pack_id = 'ze.eventi') <> 3 then raise exception 'FALLITO E1: eventi creati %', (select count(*) from local_events where pack_id = 'ze.eventi'); end if;
  if (select created_by from local_events where slug = 'concerto') is distinct from '9e000000-0000-0000-0000-000000000002' then
    raise exception 'FALLITO E1: autore non registrato';
  end if;
end $$;

-- ---------------------------------------------------------------- E2
set role authenticated;
do $$
declare u uuid;
begin
  -- Esperto e traduttore del territorio: staff, ma non leggono le bozze degli eventi e non scrivono (D4).
  foreach u in array array['9e000000-0000-0000-0000-000000000004', '9e000000-0000-0000-0000-000000000005']::uuid[] loop
    perform set_config('request.jwt.claim.sub', u::text, true);
    if exists (select 1 from local_events) then raise exception 'FALLITO E2: % legge le bozze degli eventi', u; end if;
    if studio_local_events('ze.eventi') <> '[]' then raise exception 'FALLITO E2: % vede gli eventi nello Studio', u; end if;
    begin
      perform studio_save_local_event('ze.eventi', null, '{"slug":"intruso","category":"culture","startDate":"2030-01-01","labels":{"it":{"title":"I"}},"venueName":"P"}');
      raise exception 'FALLITO E2: % crea un evento', u;
    exception when insufficient_privilege then null; end;
  end loop;
  -- Redattore di un'altra organizzazione: non vede, non modifica, non crea.
  perform set_config('request.jwt.claim.sub', '9e000000-0000-0000-0000-000000000003', true);
  if exists (select 1 from local_events where pack_id = 'ze.eventi') then raise exception 'FALLITO E2: un''altra organizzazione legge gli eventi'; end if;
  update local_events set venue_name = 'Manomesso' where pack_id = 'ze.eventi';
  begin
    perform studio_save_local_event('ze.eventi', null, '{"slug":"intruso","category":"culture","startDate":"2030-01-01","labels":{"it":{"title":"I"}},"venueName":"P"}');
    raise exception 'FALLITO E2: un''altra organizzazione crea eventi';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_set_local_event_publication((select id from local_events limit 1), 'published');
    raise exception 'FALLITO E2: un''altra organizzazione pubblica';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
end $$;
reset role;
do $$ begin
  if exists (select 1 from local_events where venue_name = 'Manomesso') then raise exception 'FALLITO E2: modificato un evento di un''altra organizzazione'; end if;
end $$;
-- Anon: nessun accesso diretto alla tabella né alle funzioni dello Studio.
set role anon;
do $$ begin
  begin
    perform 1 from local_events limit 1;
    raise exception 'FALLITO E2: anon legge la tabella degli eventi';
  exception when insufficient_privilege then null; end;
  begin
    insert into local_events (pack_id, slug, labels, category, start_date, venue_name) values ('ze.eventi', 'anon', '{"it":{"title":"A"}}', 'culture', current_date, 'P');
    raise exception 'FALLITO E2: anon scrive un evento';
  exception when insufficient_privilege then null; end;
  begin
    perform studio_save_local_event('ze.eventi', null, '{}');
    raise exception 'FALLITO E2: anon usa le funzioni dello Studio';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- E3
set role authenticated;
set request.jwt.claim.sub = '9e000000-0000-0000-0000-000000000002';
do $$
declare
  c uuid := (select id from local_events where slug = 'concerto');
  m uuid := (select id from local_events where slug like 'mercatino-%');
  e jsonb;
begin
  -- Il mercatino non ha fonte: non si verifica né si pubblica.
  begin
    perform studio_set_local_event_publication(m, 'published');
    raise exception 'FALLITO E3: pubblicato senza fonte';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_verify_local_event(m);
    raise exception 'FALLITO E3: verificato senza fonte';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Il concerto ha la fonte ma non la verifica.
  begin
    perform studio_set_local_event_publication(c, 'published');
    raise exception 'FALLITO E3: pubblicato senza verifica';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Verifica e pubblicazione non si scrivono a mano.
  begin
    update local_events set verified_at = now(), verified_by = auth.uid() where id = c;
    raise exception 'FALLITO E3: verifica scritta a mano';
  exception when insufficient_privilege then null; end;
  e := studio_verify_local_event(c, 'Controllato sul sito del Comune');
  if e ->> 'verifiedBy' <> '9e000000-0000-0000-0000-000000000002' or e ->> 'verifiedAt' is null then raise exception 'FALLITO E3: verifica non registrata'; end if;
  begin
    update local_events set publication = 'published' where id = c;
    raise exception 'FALLITO E3: pubblicato con un UPDATE diretto';
  exception when insufficient_privilege then null; end;
  e := studio_set_local_event_publication(c, 'published');
  if e ->> 'publication' <> 'published' then raise exception 'FALLITO E3: pubblicazione'; end if;

  -- Cambiare l'orario di un evento pubblicato senza riverificare: rifiutato con un messaggio chiaro.
  begin
    update local_events set start_time = '20:30' where id = c;
    raise exception 'FALLITO E3: cambiato l''orario di un evento pubblicato senza riverificarlo';
  exception when others then
    if sqlerrm like 'FALLITO%' then raise; end if;
    if sqlerrm not like '%evento pubblicato%' then raise exception 'FALLITO E3: messaggio %', sqlerrm; end if;
  end;
  -- Con la verifica, dallo Studio, si può.
  e := studio_save_local_event('ze.eventi', c, (select studio_local_event_json(x) from local_events x where x.id = c)
                                            || '{"startTime":"20:30","sourceUrl":"https://www.comune.example.it/eventi/concerto-nuovo"}', true);
  if e ->> 'startTime' <> '20:30' or e ->> 'publication' <> 'published' or e ->> 'verifiedAt' is null then
    raise exception 'FALLITO E3: modifica con verifica di un evento pubblicato: %', e;
  end if;
  -- Un cambio che non tocca date, fonte o luogo non azzera la verifica.
  update local_events set price_note = 'Ingresso libero' where id = c;
  if (select verified_at from local_events where id = c) is null then raise exception 'FALLITO E3: verifica azzerata da una nota'; end if;
  -- Annullare (D6): resta pubblicato, con lo stato e la nota.
  e := studio_set_local_event_status(c, 'cancelled', 'Annullato per maltempo');
  if e ->> 'status' <> 'cancelled' or e ->> 'publication' <> 'published' then raise exception 'FALLITO E3: annullamento'; end if;
  begin
    perform studio_set_local_event_status(c, 'sospeso');
    raise exception 'FALLITO E3: stato sconosciuto accettato';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Ritiro e eliminazione: il redattore non elimina un evento ritirato, una bozza sì.
  perform studio_set_local_event_status(c, 'scheduled');
  e := studio_set_local_event_publication(c, 'withdrawn');
  if e ->> 'publication' <> 'withdrawn' then raise exception 'FALLITO E3: ritiro'; end if;
  begin
    perform studio_delete_local_event(c);
    raise exception 'FALLITO E3: il redattore elimina un evento ritirato';
  exception when insufficient_privilege then null; end;
  perform studio_delete_local_event(m);
  if exists (select 1 from local_events where id = m) then raise exception 'FALLITO E3: bozza non eliminata'; end if;
  -- Di nuovo in linea (fonte e verifica ci sono): serve per E4.
  perform studio_set_local_event_publication(c, 'published');
  -- Notte bianca: verificata e pubblicata, poi annullata (visibile con l'etichetta).
  perform studio_verify_local_event((select id from local_events where slug = 'notte-bianca'));
  perform studio_set_local_event_publication((select id from local_events where slug = 'notte-bianca'), 'published');
  perform studio_set_local_event_status((select id from local_events where slug = 'notte-bianca'), 'cancelled', 'Annullata');
end $$;
reset role;

-- ---------------------------------------------------------------- E4
-- Dati di contorno scritti come servizio: una bozza, un evento ritirato, uno concluso, uno in un altro territorio,
-- uno in una destinazione non pubblicata, uno lontano nel tempo.
insert into local_events (pack_id, slug, labels, category, start_date, start_time, venue_name, source_url, verified_at, verified_by, publication, verification_note)
select 'ze.eventi', 'bozza', '{"it":{"title":"Bozza"}}'::jsonb, 'culture'::local_event_category, today + 2, time '18:00', 'P', 'https://example.org/', null::timestamptz, null::uuid,
       'draft'::local_event_publication, 'nota interna' from e_days union all
select 'ze.eventi', 'ritirato', '{"it":{"title":"Ritirato"}}', 'culture', today + 2, '18:00', 'P', 'https://example.org/', now(), '9e000000-0000-0000-0000-000000000002', 'withdrawn', null from e_days union all
select 'ze.eventi', 'concluso', '{"it":{"title":"Concluso"}}', 'culture', today - 1, '18:00', 'P', 'https://example.org/', now(), '9e000000-0000-0000-0000-000000000002', 'published', null from e_days union all
select 'ze.eventi', 'lontano', '{"it":{"title":"Fra un mese"}}', 'culture', today + 30, '18:00', 'P', 'https://example.org/', now(), '9e000000-0000-0000-0000-000000000002', 'published', null from e_days union all
select 'ze.eventi', 'bilingue', '{"it":{"title":"Visita guidata"},"en":{"title":"Guided tour"}}', 'excursions', today + 3, '10:00', 'P', 'https://example.org/', now(), '9e000000-0000-0000-0000-000000000002', 'published', null from e_days union all
select 'ze.altro', 'del-vicino', '{"it":{"title":"Del vicino"}}', 'culture', today + 2, '18:00', 'P', 'https://example.org/', now(), '9e000000-0000-0000-0000-000000000003', 'published', null from e_days union all
select 'ze.bozza', 'non-pubblicata', '{"it":{"title":"Nascosto"}}', 'culture', today + 2, '18:00', 'P', 'https://example.org/', now(), '9e000000-0000-0000-0000-000000000002', 'published', null from e_days;

set role anon;
do $$
declare
  today date := (select today from e_days);
  r jsonb;
  ev jsonb;
  slugs text[];
  nb date;
begin
  r := public_local_events('ze.eventi', null, null, 'it');
  if (r ->> 'today')::date <> today then raise exception 'FALLITO E4: oggi del territorio %', r ->> 'today'; end if;
  if r -> 'range' <> jsonb_build_object('from', today, 'to', today + 6) then raise exception 'FALLITO E4: periodo predefinito %', r -> 'range'; end if;
  select array_agg(x ->> 'slug' order by x ->> 'slug') into slugs from jsonb_array_elements(r -> 'events') x;
  -- Solo pubblicati, non conclusi, nel periodo: niente bozza, ritirato, concluso, lontano, altri territori.
  if slugs is distinct from array['bilingue', 'concerto', 'notte-bianca'] then raise exception 'FALLITO E4: eventi pubblici %', slugs; end if;
  -- Annullato: visibile con lo stato.
  if (select x ->> 'status' from jsonb_array_elements(r -> 'events') x where x ->> 'slug' = 'notte-bianca') <> 'cancelled' then
    raise exception 'FALLITO E4: l''evento annullato non dice di esserlo';
  end if;
  -- Solo i campi pubblici, elencati: nessun autore, nota interna, stato di pubblicazione o identificativo interno.
  ev := (select x from jsonb_array_elements(r -> 'events') x where x ->> 'slug' = 'concerto');
  if (select array_agg(k order by k) from jsonb_object_keys(ev) k) is distinct from array[
       'category', 'description', 'end', 'endsAt', 'id', 'lang', 'languages', 'links', 'organizer', 'price', 'slug', 'start',
       'startsAt', 'status', 'statusNote', 'summary', 'timeKnown', 'title', 'updatedAt', 'venue', 'verifiedAt'] then
    raise exception 'FALLITO E4: campi pubblici %', (select array_agg(k order by k) from jsonb_object_keys(ev) k);
  end if;
  if r::text like '%nota interna%' or r::text like '%9e000000-0000-0000-0000-000000000002%' or r::text like '%Controllato sul sito%' then
    raise exception 'FALLITO E4: dati interni nella risposta pubblica';
  end if;
  if ev #>> '{venue,placeRef}' <> 'ze.eventi:piazza' then raise exception 'FALLITO E4: riferimento del luogo %', ev -> 'venue'; end if;
  -- Lingua: l'inglese dove c'è, altrimenti la lingua principale dichiarata.
  r := public_local_events('ze.eventi', null, null, 'en');
  if (select x ->> 'title' from jsonb_array_elements(r -> 'events') x where x ->> 'slug' = 'bilingue') <> 'Guided tour'
     or (select x ->> 'lang' from jsonb_array_elements(r -> 'events') x where x ->> 'slug' = 'concerto') <> 'it' then
    raise exception 'FALLITO E4: lingue';
  end if;
  -- Evento oltre la mezzanotte: nel giorno di inizio e in quello dopo, non in quello dopo ancora.
  -- (Il giorno d'inizio è quello scelto in E1, spostato se cadeva sul cambio dell'ora.)
  nb := (select (x #>> '{start,date}')::date from jsonb_array_elements(public_local_events('ze.eventi') -> 'events') x where x ->> 'slug' = 'notte-bianca');
  if not (public_local_events('ze.eventi', nb, nb) -> 'events' @> '[{"slug":"notte-bianca"}]'
          and public_local_events('ze.eventi', nb + 1, nb + 1) -> 'events' @> '[{"slug":"notte-bianca"}]'
          and not public_local_events('ze.eventi', nb + 2, nb + 2) -> 'events' @> '[{"slug":"notte-bianca"}]') then
    raise exception 'FALLITO E4: evento oltre la mezzanotte';
  end if;
  -- Isolamento e destinazioni non pubblicate o inesistenti.
  if public_local_events('ze.altro') -> 'events' <> (select jsonb_agg(x) from jsonb_array_elements(public_local_events('ze.altro') -> 'events') x where x ->> 'slug' = 'del-vicino')
     or jsonb_array_length(public_local_events('ze.altro') -> 'events') <> 1 then
    raise exception 'FALLITO E4: eventi di altri territori';
  end if;
  if public_local_events('ze.bozza') is not null then raise exception 'FALLITO E4: eventi di una destinazione non pubblicata'; end if;
  if public_local_events('ze.inesistente') is not null then raise exception 'FALLITO E4: territorio inesistente'; end if;
  -- Periodo: 14 giorni sì, 15 no, rovesciato no; lingua non abilitata no; territorio malformato no.
  perform public_local_events('ze.eventi', today, today + 13);
  begin
    perform public_local_events('ze.eventi', today, today + 14);
    raise exception 'FALLITO E4: accettati 15 giorni';
  exception when invalid_parameter_value then null; end;
  begin
    perform public_local_events('ze.eventi', today + 1, today);
    raise exception 'FALLITO E4: accettato un periodo rovesciato';
  exception when invalid_parameter_value then null; end;
  begin
    perform public_local_events('ze.eventi', null, null, 'fr');
    raise exception 'FALLITO E4: accettata una lingua non abilitata';
  exception when invalid_parameter_value then null; end;
  begin
    perform public_local_events('ZE.Eventi; drop table local_events');
    raise exception 'FALLITO E4: accettato un territorio malformato';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- E5
set role authenticated;
set request.jwt.claim.sub = '9e000000-0000-0000-0000-000000000002';
do $$ begin
  update destinations set timezone = 'America/New_York' where pack_id = 'ze.eventi';
  raise exception 'FALLITO E5: il redattore cambia il fuso orario';
exception when insufficient_privilege then null; end $$;
reset role;
insert into local_events (pack_id, slug, labels, category, start_date, start_time, venue_name)
values ('ze.lontano', 'sera', '{"it":{"title":"Sera"}}', 'culture', '2027-07-01', '21:00', 'P');
set role authenticated;
set request.jwt.claim.sub = '9e000000-0000-0000-0000-000000000001';
do $$ begin
  begin
    update destinations set timezone = 'Europe/Portovenere' where pack_id = 'ze.lontano';
    raise exception 'FALLITO E5: accettato un fuso orario inesistente';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  update destinations set timezone = 'America/New_York' where pack_id = 'ze.lontano';
end $$;
reset role;
do $$ begin
  if (select starts_at from local_events where slug = 'sera') <> timestamptz '2027-07-02 01:00:00+00' then
    raise exception 'FALLITO E5: evento non ricalcolato nel nuovo fuso: %', (select starts_at from local_events where slug = 'sera');
  end if;
end $$;

-- ---------------------------------------------------------------- E6
do $$
declare f record;
begin
  for f in select * from (values
      ('public_local_events(text,date,date,text)', true, true, true, true),
      ('studio_save_local_event(text,uuid,jsonb,boolean)', false, true, true, false),
      ('studio_set_local_event_publication(uuid,text)', false, true, true, false),
      ('studio_verify_local_event(uuid,text)', false, true, true, false),
      ('local_events_guard()', false, false, null, false),
      ('local_events_prepare()', false, false, null, false)
    ) as t(sig, anon_exec, auth_exec, service_exec, definer) loop
    if has_function_privilege('anon', f.sig, 'execute') is distinct from f.anon_exec then raise exception 'FALLITO E6: anon su %', f.sig; end if;
    if has_function_privilege('authenticated', f.sig, 'execute') is distinct from f.auth_exec then raise exception 'FALLITO E6: authenticated su %', f.sig; end if;
    if f.service_exec is not null and has_function_privilege('service_role', f.sig, 'execute') is distinct from f.service_exec then
      raise exception 'FALLITO E6: service_role su %', f.sig;
    end if;
    if (select prosecdef from pg_proc where oid = f.sig::regprocedure) is distinct from f.definer then raise exception 'FALLITO E6: SECURITY DEFINER di %', f.sig; end if;
    if (select proconfig from pg_proc where oid = f.sig::regprocedure) is distinct from array['search_path=public'] then
      raise exception 'FALLITO E6: search_path di %', f.sig;
    end if;
  end loop;
  if has_table_privilege('anon', 'local_events', 'select') or has_table_privilege('anon', 'local_events', 'insert') then
    raise exception 'FALLITO E6: anon ha privilegi sulla tabella degli eventi';
  end if;
end $$;

-- ---------------------------------------------------------------- pulizia (la revoca si ferma se restano eventi)
delete from local_events where pack_id like 'ze.%';
update destinations set timezone = 'Europe/Rome' where pack_id like 'ze.%';
\echo 'eventi del giorno: E1–E6 superati'
