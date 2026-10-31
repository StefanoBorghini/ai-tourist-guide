-- Eventi ricorrenti: ogni giorno, ogni settimana (giorni scelti), ogni mese (stesso giorno, «il terzo sabato» o
-- «l'ultimo sabato»), ogni anno, ogni N periodi, fino a una data o senza fine, con date escluse.
--
-- Nessuna tabella nuova: la regola sta sulla riga dell'evento (local_events) e le date si calcolano quando si leggono
-- (public_local_events), solo nel periodo richiesto (al massimo 14 giorni). Gli eventi esistenti non cambiano: la
-- colonna recurrence vale 'none' e tutto funziona come prima. Nessun dato viene riscritto.
--
-- Regole (le stesse di apps/guide/lib/local-events.ts, occursOn):
--   - la serie parte dalla data di inizio, che deve rispettare la regola (per esempio un sabato, se si ripete il sabato);
--   - ogni occorrenza ha gli stessi orari e la stessa durata della prima (fine il giorno dopo, se la prima finisce
--     il giorno dopo); starts_at ed ends_at della riga restano quelli della prima occorrenza;
--   - le occorrenze non si sovrappongono e non cadono su un orario che il cambio dell'ora rende inesistente o doppio:
--     si controllano al salvataggio fino alla data di fine, o per tre anni se la serie non ha fine;
--   - mensile «giorno 31»: i mesi senza quel giorno si saltano; annuale il 29 febbraio: solo negli anni bisestili;
--   - cambiare la ricorrenza è come cambiare le date: azzera la verifica della fonte;
--   - annullato, rinviato, da confermare valgono per tutta la serie; una data singola si toglie con le date escluse.

-- ---------------------------------------------------------------- 1. colonne

alter table local_events
  add column recurrence          text not null default 'none'
    check (recurrence in ('none', 'daily', 'weekly', 'monthly', 'yearly')),
  add column recurrence_interval smallint not null default 1 check (recurrence_interval between 1 and 99),
  add column recurrence_weekdays smallint[] not null default '{}'
    check (recurrence_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),       -- giorni ISO: 1 lunedì … 7 domenica
  add column recurrence_monthly  text not null default 'day' check (recurrence_monthly in ('day', 'weekday', 'last_weekday')),
  add column recurrence_until    date,                                          -- null: senza fine
  add column recurrence_except   date[] not null default '{}' check (cardinality(recurrence_except) <= 200),
  add column recurrence_ends_at  timestamptz,                                   -- fine dell'ultima occorrenza (calcolata)
  add constraint local_events_recurrence_until_check check (recurrence_until is null or recurrence_until >= start_date);

-- ---------------------------------------------------------------- 2. regola

-- Vero se la serie (che parte da p_start) ha un'occorrenza il giorno d. Non considera fine e date escluse.
create function local_event_occurs(p_rec text, p_interval int, p_weekdays smallint[], p_monthly text, p_start date, d date)
returns boolean language sql immutable set search_path = public as $$
  select d >= p_start and case p_rec
    when 'none' then d = p_start
    when 'daily' then (d - p_start) % p_interval = 0
    when 'weekly' then extract(isodow from d)::smallint = any (p_weekdays)
      -- settimane da lunedì: d − (isodow − 1) è il lunedì della settimana
      and ((d - (extract(isodow from d)::int - 1)) - (p_start - (extract(isodow from p_start)::int - 1))) / 7 % p_interval = 0
    when 'monthly' then
      ((extract(year from d)::int - extract(year from p_start)::int) * 12
        + extract(month from d)::int - extract(month from p_start)::int) % p_interval = 0
      and case p_monthly
        when 'day' then extract(day from d) = extract(day from p_start)
        when 'weekday' then extract(isodow from d) = extract(isodow from p_start)
          and (extract(day from d)::int - 1) / 7 = (extract(day from p_start)::int - 1) / 7
        when 'last_weekday' then extract(isodow from d) = extract(isodow from p_start)
          and extract(month from d + 7) <> extract(month from d)
        else false end
    when 'yearly' then (extract(year from d)::int - extract(year from p_start)::int) % p_interval = 0
      and extract(month from d) = extract(month from p_start) and extract(day from d) = extract(day from p_start)
    else false end;
$$;

-- Fine dell'ultima occorrenza utile: per un evento singolo ends_at, per una serie senza fine «infinity».
create function local_event_last_end(e local_events)
returns timestamptz language sql stable set search_path = public as $$
  select case when e.recurrence = 'none' then e.ends_at else coalesce(e.recurrence_ends_at, 'infinity'::timestamptz) end;
$$;

-- Occorrenze di un evento che possono toccare i giorni locali [p_from, p_to]: data, inizio e fine. Per un evento
-- singolo restituisce la sua riga così com'è (chi chiama filtra sul periodo). Non solleva errori: gli orari delle
-- serie sono controllati al salvataggio.
create function local_event_occurrences(e local_events, p_from date, p_to date, p_tz text)
returns table (occ_date date, starts_at timestamptz, ends_at timestamptz)
language sql stable set search_path = public as $$
  select e.start_date, e.starts_at, e.ends_at where e.recurrence = 'none'
  union all
  select d::date,
         case when e.start_time is null then d::date::timestamp at time zone p_tz else (d::date + e.start_time) at time zone p_tz end,
         case when e.end_time is not null then (d::date + (e.end_date - e.start_date) + e.end_time) at time zone p_tz
              else (d::date + (coalesce(e.end_date, e.start_date) - e.start_date) + 1)::timestamp at time zone p_tz end
  from generate_series(
         greatest(e.start_date, p_from - (coalesce(e.end_date, e.start_date) - e.start_date) - 1),
         least(coalesce(e.recurrence_until, p_to), p_to), interval '1 day') d
  where e.recurrence <> 'none'
    and local_event_occurs(e.recurrence, e.recurrence_interval, e.recurrence_weekdays, e.recurrence_monthly, e.start_date, d::date)
    and not (d::date = any (e.recurrence_except));
$$;

-- Controllo e normalizzazione della serie, dopo il trigger che calcola gli orari della prima occorrenza
-- (i trigger BEFORE scattano in ordine alfabetico: 10_prepare, 15_recurrence, 20_guard).
create function local_events_recurrence()
returns trigger language plpgsql set search_path = public as $$
declare
  v_tz text;
  v_span int;
  v_limit date;
  v_prev_end timestamptz;
  v_start timestamptz;
  v_end timestamptz;
  v_last timestamptz;
  v_count int := 0;
  d date;
begin
  if new.recurrence = 'none' then
    new.recurrence_interval := 1;
    new.recurrence_weekdays := '{}';
    new.recurrence_monthly := 'day';
    new.recurrence_until := null;
    new.recurrence_except := '{}';
    new.recurrence_ends_at := null;
    return new;
  end if;
  select timezone into v_tz from destinations where pack_id = new.pack_id;
  if new.recurrence = 'weekly' then
    if cardinality(new.recurrence_weekdays) = 0 then
      new.recurrence_weekdays := array[extract(isodow from new.start_date)::smallint];
    end if;
    new.recurrence_weekdays := array(select distinct x from unnest(new.recurrence_weekdays) x order by x);
  else
    new.recurrence_weekdays := '{}';
  end if;
  if new.recurrence <> 'monthly' then new.recurrence_monthly := 'day'; end if;
  if not local_event_occurs(new.recurrence, new.recurrence_interval, new.recurrence_weekdays, new.recurrence_monthly,
                            new.start_date, new.start_date) then
    raise exception 'la data di inizio (%) non rispetta la ricorrenza: deve essere la prima data della serie (per esempio uno dei giorni della settimana scelti, o l''ultimo di quel giorno nel mese)', new.start_date;
  end if;
  if new.recurrence_until is not null and new.recurrence_until < new.start_date then
    raise exception 'la ricorrenza finisce prima della data di inizio';
  end if;
  new.recurrence_except := array(select distinct x from unnest(new.recurrence_except) x
                                 where x >= new.start_date and (new.recurrence_until is null or x <= new.recurrence_until)
                                 order by x);
  if new.start_date = any (new.recurrence_except) then
    raise exception 'la data di inizio non può essere tra le date escluse: sposta l''inizio alla prima data della serie';
  end if;

  -- Ogni occorrenza fino alla fine della serie (o per tre anni se non ha fine): orari esistenti, nessuna sovrapposizione.
  v_span := coalesce(new.end_date, new.start_date) - new.start_date;
  v_limit := coalesce(new.recurrence_until, new.start_date + interval '3 years')::date;
  if v_limit > new.start_date + interval '10 years' then
    raise exception 'una ricorrenza dura al massimo dieci anni: indica una data di fine più vicina o lasciala senza fine';
  end if;
  for d in select g::date from generate_series(new.start_date, v_limit, interval '1 day') g loop
    continue when not local_event_occurs(new.recurrence, new.recurrence_interval, new.recurrence_weekdays,
                                         new.recurrence_monthly, new.start_date, d);
    continue when d = any (new.recurrence_except);
    v_start := case when new.start_time is null then d::timestamp at time zone v_tz else local_event_instant(d, new.start_time, v_tz) end;
    v_end := case when new.end_time is not null then local_event_instant(d + v_span, new.end_time, v_tz)
                  else (d + v_span + 1)::timestamp at time zone v_tz end;
    if v_prev_end is not null and v_start < v_prev_end then
      raise exception 'le date della serie si sovrappongono (il % comincia prima che finisca la data precedente): accorcia l''evento o allarga la ricorrenza', d;
    end if;
    v_prev_end := v_end;
    v_last := v_end;
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then raise exception 'la ricorrenza non ha nessuna data'; end if;
  new.recurrence_ends_at := case when new.recurrence_until is null then null else v_last end;
  return new;
end;
$$;
create trigger local_events_15_recurrence_trg before insert or update on local_events
  for each row execute function local_events_recurrence();

-- ---------------------------------------------------------------- 3. guardia: la ricorrenza conta come le date

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
                      new.venue_name, new.venue_address, new.recurrence, new.recurrence_interval, new.recurrence_weekdays,
                      new.recurrence_monthly, new.recurrence_until, new.recurrence_except)
                     is distinct from
                     (old.start_date, old.start_time, old.end_date, old.end_time, old.source_url, old.place_node_id,
                      old.venue_name, old.venue_address, old.recurrence, old.recurrence_interval, old.recurrence_weekdays,
                      old.recurrence_monthly, old.recurrence_until, old.recurrence_except) then
      new.verified_at := null;
      new.verified_by := null;
      if new.publication = 'published' then
        raise exception 'hai cambiato date, ricorrenza, fonte o luogo di un evento pubblicato: salva segnando la fonte come verificata, oppure ritiralo prima';
      end if;
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- ---------------------------------------------------------------- 4. Studio

create or replace function studio_local_event_json(e local_events)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', e.id, 'pack', e.pack_id, 'slug', e.slug, 'labels', e.labels, 'category', e.category,
    'startDate', e.start_date, 'startTime', to_char(e.start_time, 'HH24:MI'),
    'endDate', e.end_date, 'endTime', to_char(e.end_time, 'HH24:MI'),
    'startsAt', e.starts_at, 'endsAt', e.ends_at,
    'lastEndsAt', case when e.recurrence = 'none' then e.ends_at else e.recurrence_ends_at end,
    'recurrence', case when e.recurrence = 'none' then null else jsonb_build_object(
      'freq', e.recurrence, 'interval', e.recurrence_interval, 'weekdays', to_jsonb(e.recurrence_weekdays),
      'monthly', e.recurrence_monthly, 'until', e.recurrence_until, 'except', to_jsonb(e.recurrence_except)) end,
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

-- Ricorrenza dal modulo dello Studio: p -> 'recurrence' assente o {"freq": "none"} = evento singolo.
create function studio_set_event_recurrence(p_id uuid, p jsonb)
returns void language plpgsql set search_path = public as $$
declare
  r jsonb := case when jsonb_typeof(p -> 'recurrence') = 'object' then p -> 'recurrence' else '{}' end;
  v_freq text := coalesce(nullif(r ->> 'freq', ''), 'none');
  v_interval int;
  v_weekdays smallint[];
  v_monthly text := coalesce(nullif(r ->> 'monthly', ''), 'day');
  v_until date;
  v_except date[];
begin
  if v_freq not in ('none', 'daily', 'weekly', 'monthly', 'yearly') then raise exception 'ricorrenza non riconosciuta: %', v_freq; end if;
  if v_monthly not in ('day', 'weekday', 'last_weekday') then raise exception 'ricorrenza mensile non riconosciuta: %', v_monthly; end if;
  begin
    v_interval := coalesce(nullif(r ->> 'interval', '')::int, 1);
    v_weekdays := coalesce(array(select x::smallint from jsonb_array_elements_text(
                    case when jsonb_typeof(r -> 'weekdays') = 'array' then r -> 'weekdays' else '[]' end) x), '{}');
    v_until := nullif(r ->> 'until', '')::date;
    v_except := coalesce(array(select x::date from jsonb_array_elements_text(
                  case when jsonb_typeof(r -> 'except') = 'array' then r -> 'except' else '[]' end) x), '{}');
  exception when others then
    raise exception 'ricorrenza in un formato non valido (ogni quanto: un numero; giorni della settimana da 1 a 7; date AAAA-MM-GG)';
  end;
  if v_interval not between 1 and 99 then raise exception 'ogni quanto si ripete: un numero da 1 a 99'; end if;
  if exists (select 1 from unnest(v_weekdays) x where x not between 1 and 7) then raise exception 'giorni della settimana da 1 (lunedì) a 7 (domenica)'; end if;
  if cardinality(v_except) > 200 then raise exception 'al massimo 200 date escluse'; end if;
  update local_events set recurrence = v_freq, recurrence_interval = v_interval, recurrence_weekdays = v_weekdays,
    recurrence_monthly = v_monthly, recurrence_until = v_until, recurrence_except = v_except
  where id = p_id
    and (recurrence, recurrence_interval, recurrence_weekdays, recurrence_monthly, recurrence_until, recurrence_except)
        is distinct from (v_freq, v_interval::smallint, v_weekdays, v_monthly, v_until, v_except);
end;
$$;

-- Come prima (20261031000000), più la ricorrenza scritta nello stesso salvataggio, prima della verifica.
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
  -- Senza la chiave «recurrence» (client precedenti) la ricorrenza esistente resta com'è.
  if p ? 'recurrence' then perform studio_set_event_recurrence(v_id, p); end if;
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

-- Come prima, ma una serie è conclusa solo dopo la sua ultima occorrenza (mai, se non ha fine).
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
    if local_event_last_end(v_row) <= now() then raise exception 'l''evento è già concluso: non si pubblica'; end if;
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

-- ---------------------------------------------------------------- 5. lettura pubblica

-- Come prima (20261031000000), ma ogni occorrenza di una serie nel periodo è un elemento a sé: id «<evento>@<data>»,
-- date e istanti dell'occorrenza, eventId e la regola in «recurrence» (null per un evento singolo, che resta identico).
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
        'id', case when e.recurrence = 'none' then e.id::text else e.id::text || '@' || o.occ_date end,
        'eventId', e.id,
        'slug', e.slug, 'category', e.category, 'status', e.event_status, 'statusNote', e.status_note,
        'lang', case when e.labels ? v_lang then v_lang else v_default end,
        'title', coalesce(e.labels #>> array[v_lang, 'title'], e.labels #>> array[v_default, 'title']),
        'summary', case when e.labels ? v_lang then e.labels #>> array[v_lang, 'summary'] else e.labels #>> array[v_default, 'summary'] end,
        'description', case when e.labels ? v_lang then e.labels #>> array[v_lang, 'description'] else e.labels #>> array[v_default, 'description'] end,
        'start', jsonb_build_object('date', o.occ_date, 'time', to_char(e.start_time, 'HH24:MI')),
        'end', jsonb_build_object('date', o.occ_date + (e.end_date - e.start_date), 'time', to_char(e.end_time, 'HH24:MI')),
        'startsAt', o.starts_at, 'endsAt', o.ends_at, 'timeKnown', e.start_time is not null,
        'recurrence', case when e.recurrence = 'none' then null else jsonb_build_object(
          'freq', e.recurrence, 'interval', e.recurrence_interval, 'weekdays', to_jsonb(e.recurrence_weekdays),
          'monthly', e.recurrence_monthly, 'start', e.start_date, 'until', e.recurrence_until) end,
        'venue', jsonb_build_object(
          'name', e.venue_name, 'address', e.venue_address,
          'placeRef', (select n.pack_id || ':' || n.slug from nodes n where n.id = e.place_node_id),
          'lat', case when e.location is not null then st_y(e.location::geometry) end,
          'lng', case when e.location is not null then st_x(e.location::geometry) end),
        'price', jsonb_build_object('kind', e.price, 'note', e.price_note),
        'organizer', e.organizer, 'languages', to_jsonb(e.event_languages),
        'links', jsonb_build_object('source', e.source_url, 'info', e.info_url, 'booking', e.booking_url),
        'verifiedAt', e.verified_at, 'updatedAt', e.updated_at)
        order by o.starts_at, e.id)
      from local_events e
      cross join lateral local_event_occurrences(e, v_from, v_to, v_tz) o
      where e.pack_id = p_pack and e.publication = 'published'
        and e.starts_at < v_end and local_event_last_end(e) > v_start
        and o.starts_at < v_end and o.ends_at > v_start and o.ends_at > now()), '[]'));
end;
$$;

-- ---------------------------------------------------------------- 6. permessi

revoke execute on function studio_set_event_recurrence(uuid, jsonb) from public, anon;
grant execute on function studio_set_event_recurrence(uuid, jsonb) to authenticated, service_role;
revoke execute on function local_events_recurrence() from public, anon, authenticated;
-- Funzioni di calcolo: usate da public_local_events (definer) e dallo Studio; nessun dato, nessun privilegio.
revoke execute on function local_event_occurrences(local_events, date, date, text) from public, anon;
grant execute on function local_event_occurrences(local_events, date, date, text) to authenticated, service_role;
revoke execute on function local_event_last_end(local_events) from public, anon;
grant execute on function local_event_last_end(local_events) to authenticated, service_role;
grant execute on function local_event_occurs(text, int, smallint[], text, date, date) to anon, authenticated, service_role;
