-- Avvisi operativi verificati (fase F2 di Gaia, docs/v0.4-gaia/CONDIZIONI.md): lo stato di oggi di un luogo, di un
-- percorso o di tutta la destinazione («sentiero chiuso per frana», «accesso solo su prenotazione»), con fonte
-- ufficiale, verifica della redazione e validità a date. Dati operativi come gli eventi del giorno
-- (20261031000000_local_events.sql), di cui riprende le garanzie: fuori dai Territory Pack e dai bundle, letti online
-- con una funzione pubblica; Gaia li usa come fonte dello stato di oggi, citandoli («op:<slug>»).
--
-- Garanzie applicate dal database:
--   - ogni avviso appartiene a una destinazione; il luogo o il percorso indicato è dello stesso territorio (uno solo
--     dei due, o nessuno per un avviso generale);
--   - validità a giorni interi nel fuso della destinazione (destinations.timezone), al massimo 180 giorni: scaduto,
--     sparisce da solo dalla lettura pubblica e da Gaia;
--   - fonte solo https ben formata (is_public_https_url); pubblicato ⇒ fonte e verifica registrata (vincolo CHECK);
--   - pubblicazione e verifica si cambiano solo con le funzioni dello Studio (now() e auth.uid()); modificare stato,
--     testi, fonte, date o soggetto azzera la verifica;
--   - bozze visibili e modificabili solo da chi può modificare il territorio; pubblicare e ritirare con
--     can_publish_pack; un avviso pubblicato o ritirato lo elimina solo l'amministratore;
--   - nessun accesso diretto per anon: il pubblico legge solo public_operational_notices(), campi elencati uno per uno.

-- ---------------------------------------------------------------- 1. vocabolari

create type operational_notice_publication as enum ('draft', 'published', 'withdrawn');
-- open: aperto o praticabile; closed: chiuso o interdetto; restricted: aperto con limiti (orari, senso unico, numero
-- di persone); booking_required: solo su prenotazione; caution: aperto con cautele (lavori, tratti dissestati).
create type operational_notice_status as enum ('open', 'closed', 'restricted', 'booking_required', 'caution');

-- ---------------------------------------------------------------- 2. tabella

create table operational_notices (
  id                uuid primary key default gen_random_uuid(),
  pack_id           text not null references packs (id) on delete restrict,
  slug              text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  place_node_id     uuid references nodes (id) on delete restrict,
  route_id          uuid references routes (id) on delete restrict,
  notice_status     operational_notice_status not null,
  labels            jsonb not null,                -- {"it": {"title", "text"}, "en": {...}}
  source_url        text check (source_url is null or is_public_https_url(source_url)),
  valid_from        date not null,
  valid_until       date not null,
  publication       operational_notice_publication not null default 'draft',
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
  check (place_node_id is null or route_id is null),
  check (valid_until >= valid_from and valid_until - valid_from <= 180),
  check ((verified_at is null) = (verified_by is null)),
  check (publication <> 'published' or (source_url is not null and verified_at is not null)),
  check (jsonb_typeof(labels) = 'object')
);
create index operational_notices_valid_idx on operational_notices (pack_id, valid_from, valid_until) where publication = 'published';

-- Testi per lingua: solo le lingue del territorio, titolo (al massimo 140 caratteri) e testo (al massimo 600);
-- il titolo nella lingua principale è obbligatorio.
create function operational_notice_clean_labels(p_pack text, p jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_locales text[];
  v_default text;
  v_out jsonb := '{}';
  l record;
  v_title text; v_text text;
begin
  select coalesce(nullif(locales, '{}'), array[default_locale]), default_locale into v_locales, v_default
  from packs where id = p_pack;
  for l in select key, value from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}' end) loop
    continue when not (l.key = any (v_locales)) or jsonb_typeof(l.value) <> 'object';
    v_title := nullif(btrim(regexp_replace(l.value ->> 'title', '\s+', ' ', 'g')), '');
    v_text := nullif(btrim(regexp_replace(l.value ->> 'text', '\s+', ' ', 'g')), '');
    if length(v_title) > 140 then raise exception 'titolo troppo lungo (%): al massimo 140 caratteri', l.key; end if;
    if length(v_text) > 600 then raise exception 'testo troppo lungo (%): al massimo 600 caratteri', l.key; end if;
    continue when v_title is null and v_text is null;
    v_out := v_out || jsonb_build_object(l.key, jsonb_strip_nulls(jsonb_build_object('title', v_title, 'text', v_text)));
  end loop;
  if coalesce(v_out #>> array[v_default, 'title'], '') = '' then
    raise exception 'manca il titolo nella lingua principale del territorio (%)', v_default;
  end if;
  return v_out;
end;
$$;

-- Integrità per tutti: destinazione, soggetto dello stesso territorio, testi ripuliti. Prima della guardia (ordine
-- alfabetico dei trigger BEFORE), che così confronta valori già normalizzati.
create function operational_notices_prepare()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from destinations where pack_id = new.pack_id) then
    raise exception 'gli avvisi appartengono a una destinazione: % non lo è', new.pack_id;
  end if;
  if new.place_node_id is not null and not exists (
       select 1 from nodes n join places pl on pl.node_id = n.id where n.id = new.place_node_id and n.pack_id = new.pack_id) then
    raise exception 'il luogo indicato non è un luogo di questo territorio';
  end if;
  if new.route_id is not null and not exists (select 1 from routes r where r.id = new.route_id and r.pack_id = new.pack_id) then
    raise exception 'il percorso indicato non è un percorso di questo territorio';
  end if;
  if new.place_node_id is not null and new.route_id is not null then
    raise exception 'un avviso riguarda un luogo, un percorso o tutta la destinazione: non un luogo e un percorso insieme';
  end if;
  if new.valid_until < new.valid_from then raise exception 'la fine della validità viene prima dell''inizio'; end if;
  if new.valid_until - new.valid_from > 180 then
    raise exception 'un avviso vale al massimo 180 giorni: alla scadenza va ricontrollato e rinnovato';
  end if;
  new.labels := operational_notice_clean_labels(new.pack_id, new.labels);
  return new;
end;
$$;
create trigger operational_notices_10_prepare_trg before insert or update on operational_notices
  for each row execute function operational_notices_prepare();

-- Regole editoriali per chi scrive con la propria sessione: pubblicazione e verifica solo dalle funzioni dello Studio
-- (contesto app.operational_notices = 'rpc:<id>'); cambiare stato, testi, fonte, date o soggetto azzera la verifica,
-- e su un avviso pubblicato si deve riverificare nello stesso salvataggio.
create function operational_notices_guard()
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
      raise exception 'un avviso pubblicato o ritirato non si elimina: ritiralo (lo elimina solo l''amministratore)' using errcode = '42501';
    end if;
    return old;
  end if;
  v_rpc := coalesce(current_setting('app.operational_notices', true) = 'rpc:' || new.id::text, false);
  if tg_op = 'INSERT' then
    if not v_rpc and (new.publication <> 'draft' or new.verified_at is not null or new.verified_by is not null
                      or new.published_at is not null or new.published_by is not null) then
      raise exception 'un avviso nasce in bozza: verifica e pubblicazione si fanno dallo Studio' using errcode = '42501';
    end if;
    new.created_by := auth.uid();
    new.created_at := now();
  else
    if new.pack_id is distinct from old.pack_id or new.id is distinct from old.id then
      raise exception 'un avviso non cambia territorio' using errcode = '42501';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if not v_rpc and (new.publication is distinct from old.publication
                      or new.verified_at is distinct from old.verified_at or new.verified_by is distinct from old.verified_by
                      or new.published_at is distinct from old.published_at or new.published_by is distinct from old.published_by) then
      raise exception 'stato di pubblicazione e verifica si cambiano dallo Studio' using errcode = '42501';
    end if;
    if not v_rpc and (new.notice_status, new.labels, new.source_url, new.valid_from, new.valid_until, new.place_node_id, new.route_id)
                     is distinct from
                     (old.notice_status, old.labels, old.source_url, old.valid_from, old.valid_until, old.place_node_id, old.route_id) then
      new.verified_at := null;
      new.verified_by := null;
      if new.publication = 'published' then
        raise exception 'hai cambiato un avviso pubblicato: salva segnando la fonte come verificata, oppure ritiralo prima';
      end if;
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger operational_notices_20_guard_trg before insert or update or delete on operational_notices
  for each row execute function operational_notices_guard();

create trigger operational_notices_revision_trg after insert or update or delete on operational_notices
  for each row execute function record_revision();

-- ---------------------------------------------------------------- 3. accesso diretto (RLS)

alter table operational_notices enable row level security;
revoke all on operational_notices from anon;
grant select, insert, update, delete on operational_notices to authenticated;
create policy operational_notices_editor_read on operational_notices for select using (can_edit_pack(pack_id));
create policy operational_notices_editor_insert on operational_notices for insert with check (can_edit_pack(pack_id));
create policy operational_notices_editor_update on operational_notices for update
  using (can_edit_pack(pack_id)) with check (can_edit_pack(pack_id));
create policy operational_notices_editor_delete on operational_notices for delete using (can_edit_pack(pack_id));

-- ---------------------------------------------------------------- 4. funzioni dello Studio

-- Giorno di oggi nel fuso della destinazione.
create function operational_notice_today(p_pack text)
returns date language sql stable set search_path = public as $$
  select (now() at time zone coalesce((select timezone from destinations where pack_id = p_pack), 'Europe/Rome'))::date;
$$;

create function studio_operational_notice_json(o operational_notices)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', o.id, 'pack', o.pack_id, 'slug', o.slug, 'status', o.notice_status, 'labels', o.labels,
    'place', (select n.slug from nodes n where n.id = o.place_node_id),
    'route', (select r.slug from routes r where r.id = o.route_id),
    'sourceUrl', o.source_url, 'validFrom', o.valid_from, 'validUntil', o.valid_until,
    'today', operational_notice_today(o.pack_id),
    'publication', o.publication, 'verifiedAt', o.verified_at, 'verifiedBy', o.verified_by,
    'verificationNote', o.verification_note, 'createdAt', o.created_at, 'updatedAt', o.updated_at,
    'publishedAt', o.published_at);
$$;

-- Avvisi del territorio per lo Studio: dalle policy, solo chi può modificarlo li vede.
create function studio_operational_notices(p_pack text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(studio_operational_notice_json(o) order by o.valid_until desc, o.slug), '[]')
  from operational_notices o where o.pack_id = p_pack;
$$;

-- Crea (p_id null) o modifica un avviso: { slug?, status, labels {it: {title, text}}, place? (slug), route? (slug),
-- sourceUrl, validFrom, validUntil (AAAA-MM-GG) }. Con p_verify la fonte risulta verificata ora, da chi salva.
create function studio_save_operational_notice(p_pack text, p_id uuid, p jsonb, p_verify boolean default false)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_place uuid;
  v_route uuid;
  v_from date;
  v_until date;
  v_status operational_notice_status;
  v_source text := nullif(btrim(p ->> 'sourceUrl'), '');
  v_slug text := nullif(btrim(p ->> 'slug'), '');
  v_row operational_notices;
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per gli avvisi di questo territorio');
  if p_id is not null and not exists (select 1 from operational_notices where id = p_id and pack_id = p_pack) then
    raise exception 'avviso non trovato in questo territorio';
  end if;
  if nullif(btrim(p ->> 'place'), '') is not null then
    select n.id into v_place from nodes n join places pl on pl.node_id = n.id where n.pack_id = p_pack and n.slug = btrim(p ->> 'place');
    if v_place is null then raise exception 'luogo non trovato in questo territorio: %', p ->> 'place'; end if;
  end if;
  if nullif(btrim(p ->> 'route'), '') is not null then
    select r.id into v_route from routes r where r.pack_id = p_pack and r.slug = btrim(p ->> 'route');
    if v_route is null then raise exception 'percorso non trovato in questo territorio: %', p ->> 'route'; end if;
  end if;
  begin
    v_from := (p ->> 'validFrom')::date;
    v_until := (p ->> 'validUntil')::date;
  exception when others then
    raise exception 'date di validità in un formato non valido (AAAA-MM-GG)';
  end;
  if v_from is null or v_until is null then raise exception 'indica da quando e fino a quando vale l''avviso'; end if;
  begin
    v_status := (p ->> 'status')::operational_notice_status;
  exception when others then
    raise exception 'stato dell''avviso non riconosciuto';
  end;
  if v_status is null then raise exception 'indica lo stato (aperto, chiuso, con limiti, su prenotazione, con cautela)'; end if;
  if v_source is not null and not is_public_https_url(v_source) then
    raise exception 'indirizzo della fonte non valido: serve un indirizzo completo che inizi con https:// (senza spazi né credenziali)';
  end if;
  if v_slug is not null and exists (select 1 from operational_notices where pack_id = p_pack and slug = v_slug and id <> v_id) then
    raise exception 'esiste già un avviso con questo identificativo in questo territorio: %', v_slug;
  end if;
  if p_verify then perform set_config('app.operational_notices', 'rpc:' || v_id::text, true); end if;
  if p_id is null then
    insert into operational_notices (id, pack_id, slug, place_node_id, route_id, notice_status, labels, source_url, valid_from, valid_until)
    values (v_id, p_pack,
            coalesce(v_slug, left(studio_slugify(coalesce(p #>> array['labels', (select default_locale from packs where id = p_pack), 'title'], 'avviso')), 60)
                               || '-' || to_char(v_from, 'YYYYMMDD')),
            v_place, v_route, v_status, coalesce(p -> 'labels', '{}'), v_source, v_from, v_until);
  else
    update operational_notices set
      slug = coalesce(v_slug, slug), place_node_id = v_place, route_id = v_route, notice_status = v_status,
      labels = coalesce(p -> 'labels', labels), source_url = v_source, valid_from = v_from, valid_until = v_until
    where id = p_id;
  end if;
  if p_verify then
    if not exists (select 1 from operational_notices where id = v_id and source_url is not null) then
      raise exception 'per verificare serve l''indirizzo della fonte ufficiale';
    end if;
    update operational_notices set verified_at = now(), verified_by = auth.uid() where id = v_id;
  end if;
  perform set_config('app.operational_notices', '', true);
  select * into v_row from operational_notices where id = v_id;
  return studio_operational_notice_json(v_row);
end;
$$;

create function studio_verify_operational_notice(p_id uuid, p_note text default null)
returns jsonb language plpgsql set search_path = public as $$
declare v_row operational_notices;
begin
  select * into v_row from operational_notices where id = p_id;
  if v_row.id is null then raise exception 'avviso non trovato'; end if;
  perform studio_require(can_edit_pack(v_row.pack_id), 'non hai i permessi per gli avvisi di questo territorio');
  if v_row.source_url is null then raise exception 'per verificare serve l''indirizzo della fonte ufficiale'; end if;
  if length(p_note) > 500 then raise exception 'nota di verifica troppo lunga: al massimo 500 caratteri'; end if;
  perform set_config('app.operational_notices', 'rpc:' || p_id::text, true);
  update operational_notices set verified_at = now(), verified_by = auth.uid(), verification_note = nullif(btrim(p_note), '')
  where id = p_id returning * into v_row;
  perform set_config('app.operational_notices', '', true);
  return studio_operational_notice_json(v_row);
end;
$$;

-- Pubblicazione: bozza → pubblicato → ritirato → bozza (o di nuovo pubblicato). Pubblicare richiede fonte, verifica e
-- una validità non ancora finita.
create function studio_set_operational_notice_publication(p_id uuid, p_to text)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_row operational_notices;
  v_to operational_notice_publication;
begin
  select * into v_row from operational_notices where id = p_id;
  if v_row.id is null then raise exception 'avviso non trovato'; end if;
  begin
    v_to := p_to::operational_notice_publication;
  exception when others then raise exception 'stato di pubblicazione sconosciuto: %', p_to; end;
  if v_to = v_row.publication then return studio_operational_notice_json(v_row); end if;
  if v_to = 'published' then
    perform studio_require(can_publish_pack(v_row.pack_id), 'non hai i permessi per pubblicare gli avvisi di questo territorio');
    if v_row.source_url is null then raise exception 'non si pubblica senza l''indirizzo della fonte ufficiale'; end if;
    if v_row.verified_at is null then raise exception 'non si pubblica senza la verifica della fonte'; end if;
    if v_row.valid_until < operational_notice_today(v_row.pack_id) then raise exception 'l''avviso è già scaduto: non si pubblica'; end if;
  elsif v_to = 'withdrawn' then
    if v_row.publication <> 'published' then raise exception 'si ritira solo un avviso pubblicato'; end if;
    perform studio_require(can_publish_pack(v_row.pack_id), 'non hai i permessi per ritirare gli avvisi di questo territorio');
  else
    if v_row.publication <> 'withdrawn' then raise exception 'un avviso pubblicato si ritira prima di tornare in bozza'; end if;
    perform studio_require(can_edit_pack(v_row.pack_id), 'non hai i permessi per gli avvisi di questo territorio');
  end if;
  perform set_config('app.operational_notices', 'rpc:' || p_id::text, true);
  update operational_notices set publication = v_to,
    published_at = case when v_to = 'published' then now() else published_at end,
    published_by = case when v_to = 'published' then auth.uid() else published_by end
  where id = p_id returning * into v_row;
  perform set_config('app.operational_notices', '', true);
  return studio_operational_notice_json(v_row);
end;
$$;

-- Elimina una bozza (pubblicati e ritirati solo l'amministratore: trigger di guardia).
create function studio_delete_operational_notice(p_id uuid)
returns void language plpgsql set search_path = public as $$
declare v_pack text;
begin
  select pack_id into v_pack from operational_notices where id = p_id;
  if v_pack is null then raise exception 'avviso non trovato'; end if;
  perform studio_require(can_edit_pack(v_pack), 'non hai i permessi per gli avvisi di questo territorio');
  delete from operational_notices where id = p_id;
end;
$$;

-- ---------------------------------------------------------------- 5. lettura pubblica

-- Avvisi in vigore oggi (nel fuso della destinazione) di una destinazione pubblicata: pubblicati, con validità che
-- comprende oggi. Gira con i privilegi del proprietario (non soggetto a RLS): ogni filtro è qui, e il risultato ha
-- solo i campi pubblici. Lingua non disponibile: errore 22023; territorio sconosciuto o non pubblicato: null.
create function public_operational_notices(p_pack text, p_lang text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_default text;
  v_locales text[];
  v_lang text;
  v_today date;
begin
  if p_pack is null or length(p_pack) > 120 or p_pack !~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$' then
    raise exception 'territorio non valido' using errcode = '22023';
  end if;
  select pk.default_locale, coalesce(nullif(pk.locales, '{}'), array[pk.default_locale])
    into v_default, v_locales
  from destinations d join packs pk on pk.id = d.pack_id
  where d.pack_id = p_pack and d.status = 'published';
  if v_default is null then return null; end if;
  v_lang := coalesce(p_lang, v_default);
  if not (v_lang = any (v_locales)) then raise exception 'lingua non disponibile per questo territorio' using errcode = '22023'; end if;
  v_today := operational_notice_today(p_pack);
  return jsonb_build_object(
    'territory', p_pack,
    'today', v_today,
    'lang', v_lang,
    'notices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug', o.slug, 'status', o.notice_status,
        'lang', case when o.labels ? v_lang then v_lang else v_default end,
        'title', coalesce(o.labels #>> array[v_lang, 'title'], o.labels #>> array[v_default, 'title']),
        'text', case when o.labels ? v_lang then o.labels #>> array[v_lang, 'text'] else o.labels #>> array[v_default, 'text'] end,
        'place', (select n.pack_id || ':' || n.slug from nodes n where n.id = o.place_node_id),
        'route', (select r.pack_id || ':' || r.slug from routes r where r.id = o.route_id),
        'sourceUrl', o.source_url, 'validFrom', o.valid_from, 'validUntil', o.valid_until, 'verifiedAt', o.verified_at)
        order by o.valid_until, o.slug)
      from operational_notices o
      where o.pack_id = p_pack and o.publication = 'published' and o.valid_from <= v_today and o.valid_until >= v_today), '[]'));
end;
$$;

-- ---------------------------------------------------------------- 6. permessi delle funzioni
-- Su Supabase le funzioni nuove sono eseguibili da anon e authenticated per default: si revocano una per una.

do $$
declare f text;
begin
  -- Funzioni dello Studio: solo utenti autenticati (le policy e studio_require decidono il resto).
  foreach f in array array[
    'studio_operational_notice_json(operational_notices)', 'studio_operational_notices(text)',
    'studio_save_operational_notice(text,uuid,jsonb,boolean)', 'studio_verify_operational_notice(uuid,text)',
    'studio_set_operational_notice_publication(uuid,text)', 'studio_delete_operational_notice(uuid)',
    'operational_notice_clean_labels(text,jsonb)', 'operational_notice_today(text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- Trigger: non si chiamano direttamente.
  foreach f in array array['operational_notices_prepare()', 'operational_notices_guard()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
-- Lettura pubblica: per tutti.
revoke execute on function public_operational_notices(text, text) from public;
grant execute on function public_operational_notices(text, text) to anon, authenticated, service_role;
