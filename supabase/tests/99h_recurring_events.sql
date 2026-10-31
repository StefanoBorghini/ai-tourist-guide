-- Test degli eventi ricorrenti (20261109000000_recurring_events.sql):
--   R1 regola: giornaliera, settimanale con più giorni e ogni due settimane, mensile (giorno, «terzo», «ultimo»,
--      giorno 31), annuale (29 febbraio);
--   R2 lettura pubblica: un elemento per occorrenza nel periodo, date escluse, fine della serie, serie senza fine
--      cominciata nel passato, evento singolo identico a prima;
--   R3 salvataggio: data di inizio fuori regola, sovrapposizioni, cambio dell'ora, fine prima dell'inizio, normalizzazione;
--   R4 verifica e pubblicazione: cambiare la ricorrenza azzera la verifica; serie conclusa non si pubblica;
--      salvare senza «recurrence» la lascia com'è;
--   R5 permessi delle funzioni nuove.
-- Territori propri (zr.*), ripuliti alla fine (la revoca si ferma se restano eventi ricorrenti).
\set ON_ERROR_STOP 1

insert into organizations (id, kind, name) values ('8e000000-0000-0000-0000-00000000000e', 'institution', 'Comune R (prova)');
insert into packs (id, kind, organization_id, default_locale, locales, title, config) values
  ('zr.serie', 'destination', '8e000000-0000-0000-0000-00000000000e', 'it', '{it,en}', '{"it":"Serie"}', '{}');
insert into destinations (pack_id, status) values ('zr.serie', 'published');
insert into auth.users (id, email, raw_user_meta_data) values ('8e000000-0000-0000-0000-000000000002', 'redattore-ricorrenze@prova.test', '{}');
insert into memberships (user_id, organization_id, role, pack_scope) values
  ('8e000000-0000-0000-0000-000000000002', '8e000000-0000-0000-0000-00000000000e', 'territory_editor', 'zr.serie');

-- ---------------------------------------------------------------- R1 regola
do $$
begin
  -- giornaliera ogni 3 giorni
  if not local_event_occurs('daily', 3, '{}', 'day', '2030-06-01', '2030-06-07') or local_event_occurs('daily', 3, '{}', 'day', '2030-06-01', '2030-06-08') then
    raise exception 'FALLITO R1: giornaliera ogni 3 giorni';
  end if;
  if local_event_occurs('daily', 1, '{}', 'day', '2030-06-01', '2030-05-31') then raise exception 'FALLITO R1: data prima dell''inizio'; end if;
  -- settimanale sabato e domenica, ogni due settimane (settimane da lunedì: 1-2 giugno sì, 8-9 no, 15-16 sì)
  if not (local_event_occurs('weekly', 2, '{6,7}', 'day', '2030-06-01', '2030-06-02')
          and not local_event_occurs('weekly', 2, '{6,7}', 'day', '2030-06-01', '2030-06-08')
          and not local_event_occurs('weekly', 2, '{6,7}', 'day', '2030-06-01', '2030-06-09')
          and local_event_occurs('weekly', 2, '{6,7}', 'day', '2030-06-01', '2030-06-15')
          and not local_event_occurs('weekly', 2, '{6,7}', 'day', '2030-06-01', '2030-06-14')) then
    raise exception 'FALLITO R1: settimanale ogni due settimane';
  end if;
  -- mensile: terza domenica (16/6/2030 → 21/7/2030), ultima domenica (30/6 → 28/7), giorno 31 (salta giugno)
  if not (local_event_occurs('monthly', 1, '{}', 'weekday', '2030-06-16', '2030-07-21')
          and not local_event_occurs('monthly', 1, '{}', 'weekday', '2030-06-16', '2030-07-14')) then
    raise exception 'FALLITO R1: terza domenica del mese';
  end if;
  if not (local_event_occurs('monthly', 1, '{}', 'last_weekday', '2030-06-30', '2030-07-28')
          and not local_event_occurs('monthly', 1, '{}', 'last_weekday', '2030-06-30', '2030-07-21')
          and local_event_occurs('monthly', 1, '{}', 'last_weekday', '2030-06-30', '2030-09-29')) then
    raise exception 'FALLITO R1: ultima domenica del mese';
  end if;
  if not (local_event_occurs('monthly', 1, '{}', 'day', '2030-05-31', '2030-07-31')
          and not local_event_occurs('monthly', 1, '{}', 'day', '2030-05-31', '2030-06-30')
          and local_event_occurs('monthly', 2, '{}', 'day', '2030-05-31', '2030-07-31')
          and not local_event_occurs('monthly', 2, '{}', 'day', '2030-05-31', '2030-08-31')) then
    raise exception 'FALLITO R1: mensile giorno 31';
  end if;
  -- annuale: 29 febbraio solo negli anni bisestili
  if not (local_event_occurs('yearly', 1, '{}', 'day', '2028-02-29', '2032-02-29')
          and not local_event_occurs('yearly', 1, '{}', 'day', '2028-02-29', '2029-02-28')
          and not local_event_occurs('yearly', 3, '{}', 'day', '2028-02-29', '2032-02-29')) then
    raise exception 'FALLITO R1: annuale';
  end if;
end $$;

-- ---------------------------------------------------------------- R2 / R3 / R4 con l'identità del redattore
set role authenticated;
set request.jwt.claim.sub = '8e000000-0000-0000-0000-000000000002';
do $$
declare
  e jsonb;
  r jsonb;
  ids text[];
  base jsonb := jsonb_build_object('category', 'fairs_markets', 'venueName', 'Piazza',
    'sourceUrl', 'https://www.comune.example.it/mercatino', 'labels', jsonb_build_object('it', jsonb_build_object('title', 'Mercatino')));
  v_today date := (now() at time zone 'Europe/Rome')::date;
begin
  -- R2: sabato e domenica di giugno 2030, 10–12, senza il 15.
  e := studio_save_local_event('zr.serie', null, base || jsonb_build_object('slug', 'weekend', 'startDate', '2030-06-01',
    'startTime', '10:00', 'endTime', '12:00',
    'recurrence', jsonb_build_object('freq', 'weekly', 'weekdays', jsonb_build_array(7, 6, 6), 'until', '2030-06-30',
                                     'except', jsonb_build_array('2030-06-15', '2029-01-01'))), true);
  if e -> 'recurrence' ->> 'freq' <> 'weekly' or e -> 'recurrence' -> 'weekdays' <> '[6,7]'::jsonb
     or e -> 'recurrence' -> 'except' <> '["2030-06-15"]'::jsonb then
    raise exception 'FALLITO R3: ricorrenza non normalizzata: %', e -> 'recurrence';
  end if;
  if (e ->> 'lastEndsAt')::timestamptz <> timestamptz '2030-06-30 12:00 Europe/Rome' then
    raise exception 'FALLITO R2: fine della serie %', e ->> 'lastEndsAt';
  end if;
  perform studio_set_local_event_publication((e ->> 'id')::uuid, 'published');
  reset role;
  r := public_local_events('zr.serie', '2030-06-01', '2030-06-14', 'it');
  select array_agg(x ->> 'id' order by x ->> 'startsAt') into ids from jsonb_array_elements(r -> 'events') x;
  if ids <> array[(e ->> 'id') || '@2030-06-01', (e ->> 'id') || '@2030-06-02', (e ->> 'id') || '@2030-06-08', (e ->> 'id') || '@2030-06-09'] then
    raise exception 'FALLITO R2: occorrenze 1–14 giugno: %', ids;
  end if;
  if (r #>> '{events,2,startsAt}')::timestamptz <> timestamptz '2030-06-08 10:00 Europe/Rome'
     or (r #>> '{events,2,endsAt}')::timestamptz <> timestamptz '2030-06-08 12:00 Europe/Rome'
     or r #>> '{events,2,start,date}' <> '2030-06-08' or r #>> '{events,2,end,date}' <> '2030-06-08'
     or r #>> '{events,2,eventId}' <> e ->> 'id' or r #>> '{events,2,recurrence,freq}' <> 'weekly'
     or r #>> '{events,2,recurrence,start}' <> '2030-06-01' then
    raise exception 'FALLITO R2: occorrenza dell''8 giugno: %', r -> 'events' -> 2;
  end if;
  r := public_local_events('zr.serie', '2030-06-15', '2030-06-28', 'it');
  if jsonb_array_length(r -> 'events') <> 3 or r #>> '{events,0,start,date}' <> '2030-06-16' then
    raise exception 'FALLITO R2: data esclusa: %', r -> 'events';
  end if;
  r := public_local_events('zr.serie', '2030-06-29', '2030-07-12', 'it');
  if jsonb_array_length(r -> 'events') <> 2 then raise exception 'FALLITO R2: fine della serie: %', r -> 'events'; end if;
  set role authenticated;

  -- R2: serie giornaliera senza fine cominciata dieci giorni fa, tutto il giorno: oggi e i sei giorni seguenti.
  e := studio_save_local_event('zr.serie', null, base || jsonb_build_object('slug', 'ogni-giorno', 'startDate', v_today - 10,
    'recurrence', jsonb_build_object('freq', 'daily')), true);
  if e ->> 'lastEndsAt' is not null then raise exception 'FALLITO R2: una serie senza fine ha una fine'; end if;
  perform studio_set_local_event_publication((e ->> 'id')::uuid, 'published');
  reset role;
  r := public_local_events('zr.serie', null, null, 'it');
  if (select count(*) from jsonb_array_elements(r -> 'events') x where x ->> 'eventId' = e ->> 'id') <> 7
     or r #>> '{events,0,start,date}' <> v_today::text then
    raise exception 'FALLITO R2: serie senza fine: %', r -> 'events';
  end if;
  set role authenticated;

  -- R2: evento singolo, identico a prima (id semplice, nessuna ricorrenza).
  e := studio_save_local_event('zr.serie', null, base || jsonb_build_object('slug', 'singolo', 'startDate', '2030-06-05'), true);
  perform studio_set_local_event_publication((e ->> 'id')::uuid, 'published');
  reset role;
  r := public_local_events('zr.serie', '2030-06-05', '2030-06-05', 'it');
  select x into r from jsonb_array_elements(r -> 'events') x where x ->> 'slug' = 'singolo';
  if r ->> 'id' <> e ->> 'id' or r -> 'recurrence' <> 'null'::jsonb or r #>> '{start,date}' <> '2030-06-05' or r #>> '{end,date}' is not null then
    raise exception 'FALLITO R2: evento singolo cambiato: %', r;
  end if;
  set role authenticated;

  -- R3: data di inizio fuori regola (il 3 giugno 2030 è lunedì, la regola dice sabato).
  begin
    perform studio_save_local_event('zr.serie', null, base || jsonb_build_object('slug', 'r3a', 'startDate', '2030-06-03',
      'recurrence', jsonb_build_object('freq', 'weekly', 'weekdays', jsonb_build_array(6))));
    raise exception 'FALLITO R3: inizio fuori regola accettato';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if;
    if sqlerrm not like '%non rispetta la ricorrenza%' then raise exception 'FALLITO R3: messaggio %', sqlerrm; end if; end;
  -- Sovrapposizione: due giorni di durata ogni giorno.
  begin
    perform studio_save_local_event('zr.serie', null, base || jsonb_build_object('slug', 'r3b', 'startDate', '2030-06-03',
      'endDate', '2030-06-04', 'recurrence', jsonb_build_object('freq', 'daily')));
    raise exception 'FALLITO R3: sovrapposizione accettata';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if;
    if sqlerrm not like '%si sovrappongono%' then raise exception 'FALLITO R3: messaggio %', sqlerrm; end if; end;
  -- Il 31 marzo 2030 alle 02:30 non esiste (ora legale).
  begin
    perform studio_save_local_event('zr.serie', null, base || jsonb_build_object('slug', 'r3c', 'startDate', '2030-03-24',
      'startTime', '02:30', 'recurrence', jsonb_build_object('freq', 'weekly', 'until', '2030-04-30')));
    raise exception 'FALLITO R3: orario inesistente accettato';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if;
    if sqlerrm not like '%2030-03-31%' then raise exception 'FALLITO R3: messaggio %', sqlerrm; end if; end;
  begin
    perform studio_save_local_event('zr.serie', null, base || jsonb_build_object('slug', 'r3d', 'startDate', '2030-06-03',
      'recurrence', jsonb_build_object('freq', 'daily', 'until', '2030-06-01')));
    raise exception 'FALLITO R3: fine prima dell''inizio accettata';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  begin
    perform studio_save_local_event('zr.serie', null, base || jsonb_build_object('slug', 'r3e', 'startDate', '2030-06-03',
      'recurrence', jsonb_build_object('freq', 'hourly')));
    raise exception 'FALLITO R3: frequenza sconosciuta accettata';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  -- Settimanale senza giorni: il giorno della data di inizio.
  e := studio_save_local_event('zr.serie', null, base || jsonb_build_object('slug', 'r3f', 'startDate', '2030-06-03',
    'recurrence', jsonb_build_object('freq', 'weekly', 'monthly', 'weekday', 'interval', 2)));
  if e -> 'recurrence' -> 'weekdays' <> '[1]'::jsonb or e -> 'recurrence' ->> 'monthly' <> 'day' or (e -> 'recurrence' ->> 'interval')::int <> 2 then
    raise exception 'FALLITO R3: settimanale senza giorni: %', e -> 'recurrence';
  end if;
  -- Tornare a «non si ripete» azzera i campi.
  e := studio_save_local_event('zr.serie', (e ->> 'id')::uuid, base || jsonb_build_object('startDate', '2030-06-03',
    'recurrence', jsonb_build_object('freq', 'none')));
  if e -> 'recurrence' <> 'null'::jsonb then raise exception 'FALLITO R3: ricorrenza non tolta'; end if;
  if (select (recurrence_interval, recurrence_weekdays) from local_events where id = (e ->> 'id')::uuid) is distinct from (1::smallint, '{}'::smallint[]) then
    raise exception 'FALLITO R3: campi della ricorrenza non azzerati';
  end if;

  -- R4: cambiare la ricorrenza di un evento pubblicato senza verificare viene rifiutato; con la verifica no.
  e := (select studio_local_event_json(x) from local_events x where slug = 'weekend');
  begin
    perform studio_save_local_event('zr.serie', (e ->> 'id')::uuid, base || jsonb_build_object('startDate', '2030-06-01',
      'startTime', '10:00', 'endTime', '12:00', 'recurrence', jsonb_build_object('freq', 'weekly', 'weekdays', jsonb_build_array(6))));
    raise exception 'FALLITO R4: ricorrenza cambiata senza verifica';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if;
    if sqlerrm not like '%ricorrenza%' then raise exception 'FALLITO R4: messaggio %', sqlerrm; end if; end;
  begin
    update local_events set recurrence_except = '{2030-06-22}' where id = (e ->> 'id')::uuid;
    raise exception 'FALLITO R4: data esclusa aggiunta a mano senza verifica';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if; end;
  e := studio_save_local_event('zr.serie', (e ->> 'id')::uuid, base || jsonb_build_object('startDate', '2030-06-01',
    'startTime', '10:00', 'endTime', '12:00', 'recurrence', jsonb_build_object('freq', 'weekly', 'weekdays', jsonb_build_array(6))), true);
  if e ->> 'publication' <> 'published' or e -> 'recurrence' -> 'weekdays' <> '[6]'::jsonb or e ->> 'verifiedAt' is null then
    raise exception 'FALLITO R4: modifica verificata non salvata: %', e;
  end if;
  -- Salvare senza la chiave «recurrence» (client precedenti) la lascia com'è.
  e := studio_save_local_event('zr.serie', (e ->> 'id')::uuid, base || jsonb_build_object('startDate', '2030-06-01',
    'startTime', '10:00', 'endTime', '12:00', 'labels', jsonb_build_object('it', jsonb_build_object('title', 'Mercatino del sabato'))));
  if e -> 'recurrence' ->> 'freq' <> 'weekly' or e ->> 'verifiedAt' is null then
    raise exception 'FALLITO R4: ricorrenza persa salvando senza la chiave: %', e;
  end if;
  -- Una serie già conclusa non si pubblica; una serie senza fine cominciata nel passato sì (vedi sopra).
  e := studio_save_local_event('zr.serie', null, base || jsonb_build_object('slug', 'passata', 'startDate', '2020-01-04',
    'recurrence', jsonb_build_object('freq', 'weekly', 'until', '2020-02-01')), true);
  begin
    perform studio_set_local_event_publication((e ->> 'id')::uuid, 'published');
    raise exception 'FALLITO R4: serie conclusa pubblicata';
  exception when others then if sqlerrm like 'FALLITO%' then raise; end if;
    if sqlerrm not like '%già concluso%' then raise exception 'FALLITO R4: messaggio %', sqlerrm; end if; end;
end $$;
reset role;

-- ---------------------------------------------------------------- R5 permessi
do $$
declare f record;
begin
  for f in select * from (values
      ('studio_set_event_recurrence(uuid,jsonb)', false, true, false),
      ('local_events_recurrence()', false, false, false),
      ('local_event_occurrences(local_events,date,date,text)', false, true, false),
      ('local_event_last_end(local_events)', false, true, false),
      ('public_local_events(text,date,date,text)', true, true, true),
      ('studio_save_local_event(text,uuid,jsonb,boolean)', false, true, false)
    ) as t(sig, anon_exec, auth_exec, definer) loop
    if has_function_privilege('anon', f.sig, 'execute') is distinct from f.anon_exec then raise exception 'FALLITO R5: anon su %', f.sig; end if;
    if has_function_privilege('authenticated', f.sig, 'execute') is distinct from f.auth_exec then raise exception 'FALLITO R5: authenticated su %', f.sig; end if;
    if (select prosecdef from pg_proc where oid = f.sig::regprocedure) is distinct from f.definer then raise exception 'FALLITO R5: SECURITY DEFINER di %', f.sig; end if;
    if (select proconfig from pg_proc where oid = f.sig::regprocedure) is distinct from array['search_path=public'] then
      raise exception 'FALLITO R5: search_path di %', f.sig;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- pulizia
delete from local_events where pack_id = 'zr.serie';
\echo 'eventi ricorrenti: R1–R5 superati'
