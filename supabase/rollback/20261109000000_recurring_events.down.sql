-- Revoca di 20261109000000_recurring_events.sql: toglie le ricorrenze degli eventi e rimette le funzioni di
-- 20261031000000_local_events.sql come erano.
--
-- Non cancella mai dati per errore: se un evento ha una ricorrenza, si ferma PRIMA di cambiare qualcosa (togliere le
-- colonne la perderebbe, e l'evento diventerebbe una data sola). Le ricorrenze vanno tolte dallo Studio («Non si
-- ripete») prima di tornare indietro. Tutto in una transazione, con la tabella bloccata.
begin;
set local lock_timeout = '10s';
lock table local_events in access exclusive mode;

do $$
declare v bigint;
begin
  select count(*) into v from local_events where recurrence <> 'none';
  if v > 0 then
    raise exception 'REVOCA RICORRENZE interrotta, nulla è stato modificato: % eventi si ripetono. Togli la ricorrenza dallo Studio prima di revocare.', v;
  end if;
end $$;

drop trigger if exists local_events_15_recurrence_trg on local_events;
drop function if exists local_events_recurrence();
drop function if exists studio_set_event_recurrence(uuid, jsonb);
drop function if exists local_event_occurrences(local_events, date, date, text);
drop function if exists local_event_last_end(local_events);

create or replace function local_events_guard()
returns trigger language plpgsql set search_path = public as $$
declare
  v_rpc boolean;
begin
  if current_user <> 'authenticated' then
    if tg_op <> 'DELETE' then new.updated_at := now(); end if;
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.publication <> 'draft' and not is_platform_admin() then
      raise exception 'un evento pubblicato o ritirato non si elimina: ritiralo (lo elimina solo l''amministratore)' using errcode = '42501';
    end if;
    return old;
  end if;
  -- coalesce: senza contesto il confronto vale null, e «not null» non farebbe scattare i controlli.
  v_rpc := coalesce(current_setting('app.local_events', true) = 'rpc:' || new.id::text, false);
  if tg_op = 'INSERT' then
    if not v_rpc and (new.publication <> 'draft' or new.verified_at is not null or new.verified_by is not null
                      or new.published_at is not null or new.published_by is not null) then
      raise exception 'un evento nasce in bozza: verifica e pubblicazione si fanno dallo Studio' using errcode = '42501';
    end if;
    new.created_by := auth.uid();
    new.created_at := now();
  else
    if new.pack_id is distinct from old.pack_id or new.id is distinct from old.id then
      raise exception 'un evento non cambia territorio' using errcode = '42501';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if not v_rpc and (new.publication is distinct from old.publication
                      or new.verified_at is distinct from old.verified_at or new.verified_by is distinct from old.verified_by
                      or new.published_at is distinct from old.published_at or new.published_by is distinct from old.published_by) then
      raise exception 'stato di pubblicazione e verifica si cambiano dallo Studio' using errcode = '42501';
    end if;
    if not v_rpc and (new.start_date, new.start_time, new.end_date, new.end_time, new.source_url, new.place_node_id,
                      new.venue_name, new.venue_address)
                     is distinct from
                     (old.start_date, old.start_time, old.end_date, old.end_time, old.source_url, old.place_node_id,
                      old.venue_name, old.venue_address) then
      new.verified_at := null;
      new.verified_by := null;
      if new.publication = 'published' then
        raise exception 'hai cambiato date, fonte o luogo di un evento pubblicato: salva segnando la fonte come verificata, oppure ritiralo prima';
      end if;
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create or replace function studio_local_event_json(e local_events)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', e.id, 'pack', e.pack_id, 'slug', e.slug, 'labels', e.labels, 'category', e.category,
    'startDate', e.start_date, 'startTime', to_char(e.start_time, 'HH24:MI'),
    'endDate', e.end_date, 'endTime', to_char(e.end_time, 'HH24:MI'),
    'startsAt', e.starts_at, 'endsAt', e.ends_at,
    'place', (select n.slug from nodes n where n.id = e.place_node_id),
    'venueName', e.venue_name, 'venueAddress', e.venue_address,
    'lat', case when e.location is not null then st_y(e.location::geometry) end,
    'lng', case when e.location is not null then st_x(e.location::geometry) end,
    'organizer', e.organizer, 'sourceUrl', e.source_url, 'infoUrl', e.info_url, 'bookingUrl', e.booking_url,
    'price', e.price, 'priceNote', e.price_note, 'languages', to_jsonb(e.event_languages), 'seriesId', e.series_id,
    'status', e.event_status, 'statusNote', e.status_note, 'publication', e.publication,
    'verifiedAt', e.verified_at, 'verifiedBy', e.verified_by, 'verificationNote', e.verification_note,
    'createdAt', e.created_at, 'updatedAt', e.updated_at, 'publishedAt', e.published_at);
$$;

create or replace function studio_save_local_event(p_pack text, p_id uuid, p jsonb, p_verify boolean default false)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_place uuid;
  v_lat double precision;
  v_lng double precision;
  v_location geography;
  v_row local_events;
  v_start_date date; v_end_date date; v_start_time time; v_end_time time;
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per gli eventi di questo territorio');
  if p_id is not null and not exists (select 1 from local_events where id = p_id and pack_id = p_pack) then
    raise exception 'evento non trovato in questo territorio';
  end if;
  if local_event_text(p, 'place') is not null then
    select n.id into v_place from nodes n join places pl on pl.node_id = n.id
    where n.pack_id = p_pack and n.slug = local_event_text(p, 'place');
    if v_place is null then raise exception 'luogo non trovato in questo territorio: %', local_event_text(p, 'place'); end if;
  end if;
  begin
    v_start_date := (p ->> 'startDate')::date;
    v_end_date := nullif(p ->> 'endDate', '')::date;
    v_start_time := nullif(p ->> 'startTime', '')::time;
    v_end_time := nullif(p ->> 'endTime', '')::time;
    v_lat := nullif(p ->> 'lat', '')::double precision;
    v_lng := nullif(p ->> 'lng', '')::double precision;
  exception when others then
    raise exception 'date, orari o coordinate in un formato non valido (date AAAA-MM-GG, orari HH:MM)';
  end;
  if v_start_date is null then raise exception 'manca la data di inizio'; end if;
  if p_id is null and local_event_text(p, 'category') is null then raise exception 'manca la categoria'; end if;
  if local_event_text(p, 'venueName') is null then raise exception 'manca il nome del luogo dell''evento'; end if;
  begin
    perform nullif(p ->> 'category', '')::local_event_category, nullif(p ->> 'price', '')::local_event_price,
            nullif(p ->> 'status', '')::local_event_status, nullif(p ->> 'seriesId', '')::uuid;
  exception when others then
    raise exception 'categoria, prezzo o stato dell''evento non riconosciuti';
  end;
  if (v_lat is null) <> (v_lng is null) then raise exception 'coordinate incomplete: servono latitudine e longitudine'; end if;
  if v_lat is not null then
    if v_lat not between -90 and 90 or v_lng not between -180 and 180 then raise exception 'coordinate fuori scala'; end if;
    v_location := st_setsrid(st_makepoint(v_lng, v_lat), 4326)::geography;
  end if;
  if p_verify then perform set_config('app.local_events', 'rpc:' || v_id::text, true); end if;
  if local_event_text(p, 'slug') is not null and exists (
       select 1 from local_events where pack_id = p_pack and slug = local_event_text(p, 'slug') and id <> v_id) then
    raise exception 'esiste già un evento con questo identificativo in questo territorio: %', local_event_text(p, 'slug');
  end if;

  if p_id is null then
    insert into local_events (id, pack_id, slug, labels, category, start_date, start_time, end_date, end_time,
                              starts_at, ends_at, place_node_id, venue_name, venue_address, location, organizer,
                              source_url, info_url, booking_url, price, price_note, event_languages, series_id,
                              event_status, status_note)
    values (v_id, p_pack,
            coalesce(local_event_text(p, 'slug'),
                     left(studio_slugify(coalesce(p #>> array['labels', (select default_locale from packs where id = p_pack), 'title'], '')), 60)
                       || '-' || to_char(v_start_date, 'YYYYMMDD')),
            coalesce(p -> 'labels', '{}'),
            (p ->> 'category')::local_event_category, v_start_date, v_start_time, v_end_date, v_end_time,
            now(), now() + interval '1 hour',   -- ricalcolati dal trigger
            v_place, local_event_text(p, 'venueName'), local_event_text(p, 'venueAddress'), v_location,
            local_event_text(p, 'organizer'),
            local_event_url(p, 'sourceUrl', 'indirizzo della fonte'), local_event_url(p, 'infoUrl', 'indirizzo per informazioni'),
            local_event_url(p, 'bookingUrl', 'indirizzo di prenotazione'),
            coalesce(nullif(p ->> 'price', ''), 'unknown')::local_event_price, local_event_text(p, 'priceNote'),
            coalesce(array(select jsonb_array_elements_text(p -> 'languages')), '{}'),
            nullif(p ->> 'seriesId', '')::uuid,
            coalesce(nullif(p ->> 'status', ''), 'scheduled')::local_event_status, local_event_text(p, 'statusNote'));
  else
    update local_events set
      slug = coalesce(local_event_text(p, 'slug'), slug), labels = coalesce(p -> 'labels', labels),
      category = coalesce(nullif(p ->> 'category', '')::local_event_category, category),
      start_date = v_start_date, start_time = v_start_time, end_date = v_end_date, end_time = v_end_time,
      place_node_id = v_place, venue_name = local_event_text(p, 'venueName'),
      venue_address = local_event_text(p, 'venueAddress'), location = v_location,
      organizer = local_event_text(p, 'organizer'),
      source_url = local_event_url(p, 'sourceUrl', 'indirizzo della fonte'),
      info_url = local_event_url(p, 'infoUrl', 'indirizzo per informazioni'),
      booking_url = local_event_url(p, 'bookingUrl', 'indirizzo di prenotazione'),
      price = coalesce(nullif(p ->> 'price', ''), 'unknown')::local_event_price, price_note = local_event_text(p, 'priceNote'),
      event_languages = coalesce(array(select jsonb_array_elements_text(p -> 'languages')), '{}'),
      series_id = nullif(p ->> 'seriesId', '')::uuid,
      event_status = coalesce(nullif(p ->> 'status', '')::local_event_status, event_status),
      status_note = local_event_text(p, 'statusNote')
    where id = p_id;
  end if;
  if p_verify then
    if not exists (select 1 from local_events where id = v_id and source_url is not null) then
      raise exception 'per verificare serve l''indirizzo della fonte ufficiale';
    end if;
    update local_events set verified_at = now(), verified_by = auth.uid() where id = v_id;
  end if;
  perform set_config('app.local_events', '', true);
  select * into v_row from local_events where id = v_id;
  return studio_local_event_json(v_row);
end;
$$;

create or replace function studio_set_local_event_publication(p_id uuid, p_to text)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_row local_events;
  v_to local_event_publication;
begin
  select * into v_row from local_events where id = p_id;
  if v_row.id is null then raise exception 'evento non trovato'; end if;
  begin
    v_to := p_to::local_event_publication;
  exception when others then raise exception 'stato di pubblicazione sconosciuto: %', p_to; end;
  if v_to = v_row.publication then return studio_local_event_json(v_row); end if;
  if v_to = 'published' then
    perform studio_require(can_publish_pack(v_row.pack_id), 'non hai i permessi per pubblicare gli eventi di questo territorio');
    if v_row.source_url is null then raise exception 'non si pubblica senza l''indirizzo della fonte ufficiale'; end if;
    if v_row.verified_at is null then raise exception 'non si pubblica senza la verifica della fonte'; end if;
    if v_row.ends_at <= now() then raise exception 'l''evento è già concluso: non si pubblica'; end if;
  elsif v_to = 'withdrawn' then
    if v_row.publication <> 'published' then raise exception 'si ritira solo un evento pubblicato'; end if;
    perform studio_require(can_publish_pack(v_row.pack_id), 'non hai i permessi per ritirare gli eventi di questo territorio');
  else
    if v_row.publication <> 'withdrawn' then raise exception 'un evento pubblicato si ritira prima di tornare in bozza'; end if;
    perform studio_require(can_edit_pack(v_row.pack_id), 'non hai i permessi per gli eventi di questo territorio');
  end if;
  perform set_config('app.local_events', 'rpc:' || p_id::text, true);
  update local_events set publication = v_to,
    published_at = case when v_to = 'published' then now() else published_at end,
    published_by = case when v_to = 'published' then auth.uid() else published_by end
  where id = p_id returning * into v_row;
  perform set_config('app.local_events', '', true);
  return studio_local_event_json(v_row);
end;
$$;

create or replace function public_local_events(p_pack text, p_from date default null, p_to date default null, p_lang text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text;
  v_default text;
  v_locales text[];
  v_lang text;
  v_today date;
  v_from date;
  v_to date;
  v_start timestamptz;
  v_end timestamptz;
begin
  if p_pack is null or length(p_pack) > 120 or p_pack !~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$' then
    raise exception 'territorio non valido' using errcode = '22023';
  end if;
  select d.timezone, pk.default_locale, coalesce(nullif(pk.locales, '{}'), array[pk.default_locale])
    into v_tz, v_default, v_locales
  from destinations d join packs pk on pk.id = d.pack_id
  where d.pack_id = p_pack and d.status = 'published';
  if v_tz is null then return null; end if;
  v_lang := coalesce(p_lang, v_default);
  if not (v_lang = any (v_locales)) then raise exception 'lingua non disponibile per questo territorio' using errcode = '22023'; end if;
  v_today := (now() at time zone v_tz)::date;
  v_from := coalesce(p_from, v_today);
  v_to := coalesce(p_to, v_from + 6);
  if v_to < v_from or v_to - v_from + 1 > 14 then
    raise exception 'periodo non valido: da 1 a 14 giorni' using errcode = '22023';
  end if;
  v_start := v_from::timestamp at time zone v_tz;
  v_end := (v_to + 1)::timestamp at time zone v_tz;
  return jsonb_build_object(
    'territory', jsonb_build_object('id', p_pack, 'timezone', v_tz),
    'today', v_today,
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'lang', v_lang,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'slug', e.slug, 'category', e.category, 'status', e.event_status, 'statusNote', e.status_note,
        'lang', case when e.labels ? v_lang then v_lang else v_default end,
        'title', coalesce(e.labels #>> array[v_lang, 'title'], e.labels #>> array[v_default, 'title']),
        'summary', case when e.labels ? v_lang then e.labels #>> array[v_lang, 'summary'] else e.labels #>> array[v_default, 'summary'] end,
        'description', case when e.labels ? v_lang then e.labels #>> array[v_lang, 'description'] else e.labels #>> array[v_default, 'description'] end,
        'start', jsonb_build_object('date', e.start_date, 'time', to_char(e.start_time, 'HH24:MI')),
        'end', jsonb_build_object('date', e.end_date, 'time', to_char(e.end_time, 'HH24:MI')),
        'startsAt', e.starts_at, 'endsAt', e.ends_at, 'timeKnown', e.start_time is not null,
        'venue', jsonb_build_object(
          'name', e.venue_name, 'address', e.venue_address,
          'placeRef', (select n.pack_id || ':' || n.slug from nodes n where n.id = e.place_node_id),
          'lat', case when e.location is not null then st_y(e.location::geometry) end,
          'lng', case when e.location is not null then st_x(e.location::geometry) end),
        'price', jsonb_build_object('kind', e.price, 'note', e.price_note),
        'organizer', e.organizer, 'languages', to_jsonb(e.event_languages),
        'links', jsonb_build_object('source', e.source_url, 'info', e.info_url, 'booking', e.booking_url),
        'verifiedAt', e.verified_at, 'updatedAt', e.updated_at)
        order by e.starts_at, e.id)
      from local_events e
      where e.pack_id = p_pack and e.publication = 'published'
        and e.starts_at < v_end and e.ends_at > v_start and e.ends_at > now()), '[]'));
end;
$$;

drop function if exists local_event_occurs(text, int, smallint[], text, date, date);
alter table local_events
  drop constraint if exists local_events_recurrence_until_check,
  drop column recurrence_ends_at,
  drop column recurrence_except,
  drop column recurrence_until,
  drop column recurrence_monthly,
  drop column recurrence_weekdays,
  drop column recurrence_interval,
  drop column recurrence;

commit;
