-- Eventi del giorno (fase 2): calendario degli eventi locali, separato dai Territory Pack e dai bundle.
--
-- Dati operativi, letti dall'app online tramite una funzione pubblica (come il catalogo): non entrano in
-- pack_snapshot()/import_pack(), nei bundle, nel kbHash né nella base di conoscenza dell'AI. Il nome local_events
-- evita la confusione con node_kind 'event', che indica eventi storici del grafo.
--
-- Garanzie applicate dal database, non dall'interfaccia:
--   - ogni evento appartiene a una destinazione; un luogo collegato è dello stesso territorio;
--   - date e orari si leggono nel fuso orario della destinazione (destinations.timezone, nome IANA): starts_at e
--     ends_at li calcola il trigger, e gli orari che il cambio dell'ora rende inesistenti o doppi si rifiutano;
--   - indirizzi solo https ben formati (is_public_https_url, stessa regola di apps/guide/lib/local-events.ts);
--   - pubblicato ⇒ fonte https e verifica registrata (vincolo CHECK: nessun rapporto fornito dal client);
--   - stato di pubblicazione e verifica si cambiano solo con le funzioni dello Studio, che li prendono da now() e
--     auth.uid(); modificare date, fonte o luogo di un evento azzera la verifica;
--   - bozze leggibili e modificabili solo da chi può modificare il territorio (can_edit_pack), non da tutto lo staff;
--     pubblicare e ritirare con can_publish_pack; un evento pubblicato lo elimina solo l'amministratore;
--   - nessun accesso diretto per anon: il pubblico legge solo public_local_events(), con campi elencati uno per uno.

-- ---------------------------------------------------------------- 1. fuso orario della destinazione

alter table destinations add column timezone text not null default 'Europe/Rome';

-- Nome IANA valido; lo cambia solo l'amministratore (sposta l'ora di tutti gli eventi del territorio), e gli eventi
-- si ricalcolano subito: se uno diventa un orario inesistente o doppio nel nuovo fuso, il cambio si rifiuta.
create function destinations_timezone_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'fuso orario sconosciuto: % (serve un nome come Europe/Rome)', new.timezone;
  end if;
  if tg_op = 'UPDATE' and new.timezone is distinct from old.timezone
     and current_user = 'authenticated' and not is_platform_admin() then
    raise exception 'il fuso orario del territorio lo cambia l''amministratore della piattaforma' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger destinations_timezone_guard_trg before insert or update of timezone on destinations
  for each row execute function destinations_timezone_guard();

-- ---------------------------------------------------------------- 2. vocabolari e indirizzi

create type local_event_publication as enum ('draft', 'published', 'withdrawn');
create type local_event_status as enum ('scheduled', 'unconfirmed', 'cancelled', 'postponed');
create type local_event_category as enum (
  'culture', 'music', 'exhibitions', 'food_wine', 'fairs_markets', 'excursions', 'outdoor', 'local_initiatives', 'other');
create type local_event_price as enum ('free', 'paid', 'unknown');

-- Indirizzo pubblico: solo https, host con almeno un punto e senza credenziali, porta facoltativa, nessuno spazio o
-- carattere di controllo, al massimo 500 caratteri. Controlla la forma, non che la pagina sia la fonte ufficiale.
create function is_public_https_url(u text)
returns boolean language sql immutable set search_path = public as $$
  select u is not null and length(u) <= 500
     and u ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(:[0-9]{1,5})?(/[^\s]*)?$'
     and u !~ '[[:cntrl:]]';
$$;

-- ---------------------------------------------------------------- 3. tabella

create table local_events (
  id                uuid primary key default gen_random_uuid(),
  pack_id           text not null references packs (id) on delete restrict,
  slug              text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  labels            jsonb not null,                -- {"it": {"title", "summary", "description"}, "en": {...}}
  category          local_event_category not null,
  start_date        date not null,
  start_time        time,                          -- null: «orario da confermare»
  end_date          date,
  end_time          time,
  starts_at         timestamptz not null,          -- calcolati dal trigger nel fuso della destinazione
  ends_at           timestamptz not null,
  place_node_id     uuid references nodes (id) on delete set null,
  venue_name        text not null check (length(btrim(venue_name)) between 1 and 160),
  venue_address     text check (length(venue_address) <= 240),
  location          geography(point, 4326),
  organizer         text check (length(organizer) <= 160),
  source_url        text check (source_url is null or is_public_https_url(source_url)),
  info_url          text check (info_url is null or is_public_https_url(info_url)),
  booking_url       text check (booking_url is null or is_public_https_url(booking_url)),
  price             local_event_price not null default 'unknown',
  price_note        text check (length(price_note) <= 160),
  event_languages   text[] not null default '{}' check (cardinality(event_languages) <= 10),
  series_id         uuid,                          -- raggruppa le occorrenze di una manifestazione, senza automatismi
  event_status      local_event_status not null default 'scheduled',
  status_note       text check (length(status_note) <= 300),            -- pubblica
  publication       local_event_publication not null default 'draft',
  verified_at       timestamptz,
  verified_by       uuid references auth.users (id),
  verification_note text check (length(verification_note) <= 500),     -- interna, mai esposta
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users (id),
  published_at      timestamptz,
  published_by      uuid references auth.users (id),
  unique (pack_id, slug),
  check (end_date is null or end_date >= start_date),
  check (end_time is null or start_time is not null),
  check (ends_at > starts_at and ends_at - starts_at <= interval '60 days'),
  check ((verified_at is null) = (verified_by is null)),
  check (publication <> 'published' or (source_url is not null and verified_at is not null)),
  check (jsonb_typeof(labels) = 'object')
);
create index local_events_window_idx on local_events (pack_id, starts_at, ends_at) where publication = 'published';
create index local_events_pack_idx on local_events (pack_id, start_date);

-- Istante di una data e un'ora locali nel fuso indicato. Rifiuta gli orari che il cambio dell'ora rende inesistenti
-- (salto in avanti: l'orologio non li segna) o doppi (ritorno all'ora solare: si ripetono): meglio chiedere un orario
-- diverso che indovinare. Stessa regola di localToInstant in apps/guide/lib/local-events.ts.
create function local_event_instant(p_date date, p_time time, p_tz text)
returns timestamptz language plpgsql stable set search_path = public as $$
declare
  v_local timestamp := p_date + p_time;
  v_at timestamptz := v_local at time zone p_tz;
begin
  if (v_at at time zone p_tz) <> v_local then
    raise exception 'orario non valido il %: alle % non esiste per il cambio dell''ora, scegli un altro orario', p_date, to_char(p_time, 'HH24:MI');
  end if;
  if ((v_at - interval '1 hour') at time zone p_tz) = v_local or ((v_at + interval '1 hour') at time zone p_tz) = v_local then
    raise exception 'orario non valido il %: le % si ripetono due volte per il cambio dell''ora, scegli un altro orario', p_date, to_char(p_time, 'HH24:MI');
  end if;
  return v_at;
end;
$$;

-- Testi per lingua: solo le lingue del territorio, solo titolo, sommario e descrizione, ripuliti e con lunghezze
-- massime; il titolo nella lingua principale è obbligatorio.
create function local_event_clean_labels(p_pack text, p jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_locales text[];
  v_default text;
  v_out jsonb := '{}';
  l record;
  v_title text; v_summary text; v_description text;
begin
  select coalesce(nullif(locales, '{}'), array[default_locale]), default_locale into v_locales, v_default
  from packs where id = p_pack;
  for l in select key, value from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}' end) loop
    continue when not (l.key = any (v_locales)) or jsonb_typeof(l.value) <> 'object';
    v_title := nullif(btrim(l.value ->> 'title'), '');
    v_summary := nullif(btrim(l.value ->> 'summary'), '');
    v_description := nullif(btrim(l.value ->> 'description'), '');
    if length(v_title) > 140 then raise exception 'titolo troppo lungo (%): al massimo 140 caratteri', l.key; end if;
    if length(v_summary) > 300 then raise exception 'descrizione breve troppo lunga (%): al massimo 300 caratteri', l.key; end if;
    if length(v_description) > 4000 then raise exception 'descrizione troppo lunga (%): al massimo 4000 caratteri', l.key; end if;
    continue when v_title is null and v_summary is null and v_description is null;
    v_out := v_out || jsonb_build_object(l.key, jsonb_strip_nulls(jsonb_build_object(
      'title', v_title, 'summary', v_summary, 'description', v_description)));
  end loop;
  if coalesce(v_out #>> array[v_default, 'title'], '') = '' then
    raise exception 'manca il titolo nella lingua principale del territorio (%)', v_default;
  end if;
  return v_out;
end;
$$;

-- Integrità per tutti (anche importazioni e servizio): destinazione, luogo dello stesso territorio, testi, date
-- normalizzate e istanti calcolati nel fuso della destinazione. Gira prima della guardia (i trigger BEFORE scattano
-- in ordine alfabetico: 10_prepare, poi 20_guard), che così confronta valori già normalizzati.
create function local_events_prepare()
returns trigger language plpgsql set search_path = public as $$
declare
  v_tz text;
begin
  select timezone into v_tz from destinations where pack_id = new.pack_id;
  if v_tz is null then raise exception 'gli eventi appartengono a una destinazione: % non lo è', new.pack_id; end if;
  if new.place_node_id is not null and not exists (
       select 1 from nodes n join places pl on pl.node_id = n.id where n.id = new.place_node_id and n.pack_id = new.pack_id) then
    raise exception 'il luogo collegato non è un luogo di questo territorio';
  end if;
  new.labels := local_event_clean_labels(new.pack_id, new.labels);
  new.venue_name := btrim(new.venue_name);
  if new.end_time is not null and new.end_date is null then new.end_date := new.start_date; end if;
  if new.end_time is not null and new.start_time is null then
    raise exception 'un orario di fine richiede l''orario di inizio';
  end if;
  if new.end_date is not null and new.end_date < new.start_date then
    raise exception 'la fine viene prima dell''inizio';
  end if;
  new.starts_at := case when new.start_time is null then new.start_date::timestamp at time zone v_tz
                        else local_event_instant(new.start_date, new.start_time, v_tz) end;
  new.ends_at := case when new.end_time is not null then local_event_instant(new.end_date, new.end_time, v_tz)
                      else (coalesce(new.end_date, new.start_date) + 1)::timestamp at time zone v_tz end;
  if new.ends_at <= new.starts_at then raise exception 'la fine viene prima dell''inizio (per un evento oltre la mezzanotte indica il giorno dopo)'; end if;
  if new.ends_at - new.starts_at > interval '60 days' then
    raise exception 'un evento dura al massimo 60 giorni: per una manifestazione più lunga inserisci gli appuntamenti separati';
  end if;
  return new;
end;
$$;
create trigger local_events_10_prepare_trg before insert or update on local_events
  for each row execute function local_events_prepare();

-- Regole editoriali per chi scrive con la propria sessione (authenticated). Le colonne di stato si cambiano solo dentro
-- le funzioni dello Studio (contesto app.local_events = 'rpc:<id>'); fuori di lì, cambiare date, fonte o luogo
-- azzera la verifica, e un evento pubblicato senza verifica viola il vincolo: va riverificato con lo Studio.
create function local_events_guard()
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
create trigger local_events_20_guard_trg before insert or update or delete on local_events
  for each row execute function local_events_guard();

-- Storico delle modifiche, come per i contenuti dei territori.
create trigger local_events_revision_trg after insert or update or delete on local_events
  for each row execute function record_revision();

-- Cambio del fuso orario della destinazione: gli eventi si ricalcolano (il trigger di preparazione rifà i conti).
create function destinations_timezone_recompute()
returns trigger language plpgsql set search_path = public as $$
begin
  update local_events set start_date = start_date where pack_id = new.pack_id;
  return new;
end;
$$;
create trigger destinations_timezone_recompute_trg after update of timezone on destinations
  for each row when (new.timezone is distinct from old.timezone) execute function destinations_timezone_recompute();

-- ---------------------------------------------------------------- 4. accesso diretto (RLS)

alter table local_events enable row level security;
revoke all on local_events from anon;
grant select, insert, update, delete on local_events to authenticated;
create policy local_events_editor_read on local_events for select using (can_edit_pack(pack_id));
create policy local_events_editor_insert on local_events for insert with check (can_edit_pack(pack_id));
create policy local_events_editor_update on local_events for update
  using (can_edit_pack(pack_id)) with check (can_edit_pack(pack_id));
create policy local_events_editor_delete on local_events for delete using (can_edit_pack(pack_id));

-- ---------------------------------------------------------------- 5. funzioni dello Studio (con l'identità di chi scrive)

-- Evento come lo vede lo Studio (compresi i campi interni).
create function studio_local_event_json(e local_events)
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

-- Eventi di un territorio per lo Studio: dalle policy, solo chi può modificarlo li vede.
create function studio_local_events(p_pack text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(studio_local_event_json(e) order by e.start_date desc, e.start_time desc nulls last, e.slug), '[]')
  from local_events e where e.pack_id = p_pack;
$$;

-- Testo libero ripulito: vuoto → null.
create function local_event_text(p jsonb, p_key text)
returns text language sql immutable set search_path = public as $$
  select nullif(btrim(p ->> p_key), '');
$$;

-- Indirizzo facoltativo: vuoto → null; se presente deve essere https ben formato.
create function local_event_url(p jsonb, p_key text, p_label text)
returns text language plpgsql immutable set search_path = public as $$
declare v text := nullif(btrim(p ->> p_key), '');
begin
  if v is not null and not is_public_https_url(v) then
    raise exception '% non valido: serve un indirizzo completo che inizi con https:// (senza spazi né credenziali)', p_label;
  end if;
  return v;
end;
$$;

-- Crea (p_id null) o modifica un evento. Con p_verify la fonte risulta verificata ora, da chi salva: serve per
-- correggere un evento pubblicato senza ritirarlo (cambiare date, fonte o luogo azzera la verifica).
create function studio_save_local_event(p_pack text, p_id uuid, p jsonb, p_verify boolean default false)
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

-- La redazione ha controllato la fonte: data e autore della verifica li registra il database.
create function studio_verify_local_event(p_id uuid, p_note text default null)
returns jsonb language plpgsql set search_path = public as $$
declare v_row local_events;
begin
  select * into v_row from local_events where id = p_id;
  if v_row.id is null then raise exception 'evento non trovato'; end if;
  perform studio_require(can_edit_pack(v_row.pack_id), 'non hai i permessi per gli eventi di questo territorio');
  if v_row.source_url is null then raise exception 'per verificare serve l''indirizzo della fonte ufficiale'; end if;
  if length(p_note) > 500 then raise exception 'nota di verifica troppo lunga: al massimo 500 caratteri'; end if;
  perform set_config('app.local_events', 'rpc:' || p_id::text, true);
  update local_events set verified_at = now(), verified_by = auth.uid(), verification_note = nullif(btrim(p_note), '')
  where id = p_id returning * into v_row;
  perform set_config('app.local_events', '', true);
  return studio_local_event_json(v_row);
end;
$$;

-- Pubblicazione: bozza → pubblicato → ritirato → bozza (o di nuovo pubblicato). Pubblicare richiede fonte e verifica
-- (lo impone il vincolo della tabella) e un evento non ancora concluso.
create function studio_set_local_event_publication(p_id uuid, p_to text)
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

-- Stato dell'evento (previsto, da confermare, annullato, rinviato) con la nota pubblica: anche su un evento già
-- pubblicato, senza ritirarlo né riverificarlo.
create function studio_set_local_event_status(p_id uuid, p_status text, p_note text default null)
returns jsonb language plpgsql set search_path = public as $$
declare v_row local_events;
begin
  select * into v_row from local_events where id = p_id;
  if v_row.id is null then raise exception 'evento non trovato'; end if;
  perform studio_require(can_edit_pack(v_row.pack_id), 'non hai i permessi per gli eventi di questo territorio');
  begin
    update local_events set event_status = p_status::local_event_status, status_note = nullif(btrim(p_note), '')
    where id = p_id returning * into v_row;
  exception when invalid_text_representation then raise exception 'stato dell''evento sconosciuto: %', p_status; end;
  return studio_local_event_json(v_row);
end;
$$;

-- Elimina una bozza (un evento pubblicato o ritirato lo elimina solo l'amministratore: trigger di guardia).
create function studio_delete_local_event(p_id uuid)
returns void language plpgsql set search_path = public as $$
declare v_pack text;
begin
  select pack_id into v_pack from local_events where id = p_id;
  if v_pack is null then raise exception 'evento non trovato'; end if;
  perform studio_require(can_edit_pack(v_pack), 'non hai i permessi per gli eventi di questo territorio');
  delete from local_events where id = p_id;
end;
$$;

-- ---------------------------------------------------------------- 6. lettura pubblica

-- Eventi pubblicati di una destinazione pubblicata nel periodo [p_from, p_to] (giorni locali, estremi inclusi,
-- al massimo 14), esclusi quelli già conclusi. Periodo predefinito: oggi nel territorio e i sei giorni seguenti.
-- Gira con i privilegi del proprietario (che non è soggetto a RLS): ogni filtro è scritto qui, e il risultato
-- contiene solo i campi pubblici, elencati uno per uno. Parametri non validi: errore 22023; territorio sconosciuto
-- o non pubblicato: null.
create function public_local_events(p_pack text, p_from date default null, p_to date default null, p_lang text default null)
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

-- ---------------------------------------------------------------- 7. permessi sulle funzioni

do $$
declare f text;
begin
  -- Funzioni dello Studio: solo utenti autenticati (le policy e studio_require decidono il resto).
  foreach f in array array[
    'studio_local_event_json(local_events)', 'studio_local_events(text)', 'studio_save_local_event(text,uuid,jsonb,boolean)',
    'studio_verify_local_event(uuid,text)', 'studio_set_local_event_publication(uuid,text)',
    'studio_set_local_event_status(uuid,text,text)', 'studio_delete_local_event(uuid)',
    'local_event_clean_labels(text,jsonb)', 'local_event_text(jsonb,text)', 'local_event_url(jsonb,text,text)',
    'local_event_instant(date,time,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- Trigger: non si chiamano direttamente.
  foreach f in array array[
    'local_events_prepare()', 'local_events_guard()', 'destinations_timezone_guard()', 'destinations_timezone_recompute()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
-- Lettura pubblica e regola degli indirizzi: per tutti.
revoke execute on function public_local_events(text, date, date, text) from public;
grant execute on function public_local_events(text, date, date, text) to anon, authenticated, service_role;
grant execute on function is_public_https_url(text) to anon, authenticated, service_role;
