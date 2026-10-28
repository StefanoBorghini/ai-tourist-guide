-- Attività locali (directory gratuita: bar, ristoranti, negozi, dove dormire, servizi): decisioni in
-- docs/v0.3-platform/DIRECTORY-ATTIVITA-LOCALI.md (D13–D17 con le proposte del documento, decisione del 2026-10-28).
--
-- Dati operativi, come gli eventi del giorno: non entrano in pack_snapshot()/import_pack(), nei bundle, nel kbHash né
-- nella base di conoscenza dell'AI. L'app li legge online con una funzione pubblica; consultarli non richiede account
-- né acquisti e non attiva l'AI.
--
-- Garanzie applicate dal database, non dall'interfaccia:
--   - ogni attività appartiene a una destinazione;
--   - parità di trattamento: nessun campo di affiliazione, sponsorizzazione o priorità; l'elenco pubblico è in ordine
--     alfabetico (l'app può solo riordinarlo per distanza dalla posizione del visitatore);
--   - pubblicata ⇒ dati verificati (vincolo CHECK); verifica e pubblicazione si cambiano solo con le funzioni dello
--     Studio, che le prendono da now() e auth.uid(); cambiare i dati di un'attività azzera la verifica;
--   - indirizzi web solo https (is_public_https_url), telefono ed email in forma plausibile;
--   - bozze e attività visibili solo a chi può modificare il territorio; pubblicare e ritirare con can_publish_pack;
--     un'attività pubblicata o ritirata la elimina solo l'amministratore;
--   - nessun accesso diretto per anon: il pubblico legge solo public_local_businesses(), con campi elencati uno per uno.
-- Le immagini delle attività arriveranno in un secondo passo (stesse regole di licenza dei media).

-- ---------------------------------------------------------------- 1. vocabolari

create type local_business_publication as enum ('draft', 'published', 'withdrawn');
create type local_business_category as enum ('restaurant', 'bar', 'shop', 'accommodation', 'tourist_service', 'other');

-- ---------------------------------------------------------------- 2. tabella

create table local_businesses (
  id                uuid primary key default gen_random_uuid(),
  pack_id           text not null references packs (id) on delete restrict,
  slug              text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  name              text not null check (length(btrim(name)) between 1 and 120),
  category          local_business_category not null,
  subcategory       text check (length(subcategory) <= 60),            -- «pizzeria», «gelateria», …
  labels            jsonb not null default '{}',                       -- {"it": {"description", "hours"}, "en": {...}}
  address           text check (length(address) <= 240),
  location          geography(point, 4326),
  phone             text check (phone is null or (length(phone) <= 40 and phone ~ '^\+?[0-9][0-9 ./()-]{4,38}$')),
  email             text check (email is null or (length(email) <= 160 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  website           text check (website is null or is_public_https_url(website)),
  publication       local_business_publication not null default 'draft',
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
  check ((verified_at is null) = (verified_by is null)),
  check (publication <> 'published' or verified_at is not null),
  check (jsonb_typeof(labels) = 'object')
);
create index local_businesses_pack_idx on local_businesses (pack_id, publication);

-- Testi per lingua: solo le lingue del territorio, solo descrizione e orari, ripuliti e con lunghezze massime.
create function local_business_clean_labels(p_pack text, p jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_locales text[];
  v_out jsonb := '{}';
  l record;
  v_description text; v_hours text;
begin
  select coalesce(nullif(locales, '{}'), array[default_locale]) into v_locales from packs where id = p_pack;
  for l in select key, value from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}' end) loop
    continue when not (l.key = any (v_locales)) or jsonb_typeof(l.value) <> 'object';
    v_description := nullif(btrim(l.value ->> 'description'), '');
    v_hours := nullif(btrim(l.value ->> 'hours'), '');
    if length(v_description) > 1000 then raise exception 'descrizione troppo lunga (%): al massimo 1000 caratteri', l.key; end if;
    if length(v_hours) > 300 then raise exception 'orari troppo lunghi (%): al massimo 300 caratteri', l.key; end if;
    continue when v_description is null and v_hours is null;
    v_out := v_out || jsonb_build_object(l.key, jsonb_strip_nulls(jsonb_build_object('description', v_description, 'hours', v_hours)));
  end loop;
  return v_out;
end;
$$;

-- Integrità per tutti (anche importazioni e servizio): destinazione, testi e campi ripuliti. Gira prima della guardia.
create function local_businesses_prepare()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from destinations where pack_id = new.pack_id) then
    raise exception 'le attività appartengono a una destinazione: % non lo è', new.pack_id;
  end if;
  new.labels := local_business_clean_labels(new.pack_id, new.labels);
  new.name := btrim(new.name);
  new.subcategory := nullif(btrim(new.subcategory), '');
  new.address := nullif(btrim(new.address), '');
  new.phone := nullif(btrim(new.phone), '');
  new.email := nullif(lower(btrim(new.email)), '');
  return new;
end;
$$;
create trigger local_businesses_10_prepare_trg before insert or update on local_businesses
  for each row execute function local_businesses_prepare();

-- Regole editoriali per chi scrive con la propria sessione (authenticated), come per gli eventi: verifica e
-- pubblicazione solo dentro le funzioni dello Studio (contesto app.local_businesses = 'rpc:<id>'); fuori di lì,
-- cambiare i dati azzera la verifica, e un'attività pubblicata senza verifica viola il vincolo.
create function local_businesses_guard()
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
      raise exception 'un''attività pubblicata o ritirata non si elimina: ritirala (la elimina solo l''amministratore)' using errcode = '42501';
    end if;
    return old;
  end if;
  v_rpc := coalesce(current_setting('app.local_businesses', true) = 'rpc:' || new.id::text, false);
  if tg_op = 'INSERT' then
    if not v_rpc and (new.publication <> 'draft' or new.verified_at is not null or new.verified_by is not null
                      or new.published_at is not null or new.published_by is not null) then
      raise exception 'un''attività nasce in bozza: verifica e pubblicazione si fanno dallo Studio' using errcode = '42501';
    end if;
    new.created_by := auth.uid();
    new.created_at := now();
  else
    if new.pack_id is distinct from old.pack_id or new.id is distinct from old.id then
      raise exception 'un''attività non cambia territorio' using errcode = '42501';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if not v_rpc and (new.publication is distinct from old.publication
                      or new.verified_at is distinct from old.verified_at or new.verified_by is distinct from old.verified_by
                      or new.published_at is distinct from old.published_at or new.published_by is distinct from old.published_by) then
      raise exception 'stato di pubblicazione e verifica si cambiano dallo Studio' using errcode = '42501';
    end if;
    if not v_rpc and (new.name, new.category, new.subcategory, new.labels, new.address, new.location, new.phone, new.email, new.website)
                     is distinct from
                     (old.name, old.category, old.subcategory, old.labels, old.address, old.location, old.phone, old.email, old.website) then
      new.verified_at := null;
      new.verified_by := null;
      if new.publication = 'published' then
        raise exception 'hai cambiato i dati di un''attività pubblicata: salva segnando i dati come verificati, oppure ritirala prima';
      end if;
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger local_businesses_20_guard_trg before insert or update or delete on local_businesses
  for each row execute function local_businesses_guard();

create trigger local_businesses_revision_trg after insert or update or delete on local_businesses
  for each row execute function record_revision();

-- ---------------------------------------------------------------- 3. accesso diretto (RLS)

alter table local_businesses enable row level security;
revoke all on local_businesses from anon;
grant select, insert, update, delete on local_businesses to authenticated;
create policy local_businesses_editor_read on local_businesses for select using (can_edit_pack(pack_id));
create policy local_businesses_editor_insert on local_businesses for insert with check (can_edit_pack(pack_id));
create policy local_businesses_editor_update on local_businesses for update
  using (can_edit_pack(pack_id)) with check (can_edit_pack(pack_id));
create policy local_businesses_editor_delete on local_businesses for delete using (can_edit_pack(pack_id));

-- ---------------------------------------------------------------- 4. funzioni dello Studio (con l'identità di chi scrive)

create function studio_local_business_json(b local_businesses)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', b.id, 'pack', b.pack_id, 'slug', b.slug, 'name', b.name, 'category', b.category, 'subcategory', b.subcategory,
    'labels', b.labels, 'address', b.address,
    'lat', case when b.location is not null then st_y(b.location::geometry) end,
    'lng', case when b.location is not null then st_x(b.location::geometry) end,
    'phone', b.phone, 'email', b.email, 'website', b.website, 'publication', b.publication,
    'verifiedAt', b.verified_at, 'verifiedBy', b.verified_by, 'verificationNote', b.verification_note,
    'createdAt', b.created_at, 'updatedAt', b.updated_at, 'publishedAt', b.published_at);
$$;

create function studio_local_businesses(p_pack text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(studio_local_business_json(b) order by lower(b.name), b.id), '[]')
  from local_businesses b where b.pack_id = p_pack;
$$;

-- Crea (p_id null) o modifica un'attività. Con p_verify i dati risultano verificati ora, da chi salva: serve anche
-- per correggere un'attività pubblicata senza ritirarla.
create function studio_save_local_business(p_pack text, p_id uuid, p jsonb, p_verify boolean default false)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_lat double precision;
  v_lng double precision;
  v_location geography;
  v_category local_business_category;
  v_row local_businesses;
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per le attività di questo territorio');
  if p_id is not null and not exists (select 1 from local_businesses where id = p_id and pack_id = p_pack) then
    raise exception 'attività non trovata in questo territorio';
  end if;
  if local_event_text(p, 'name') is null then raise exception 'manca il nome dell''attività'; end if;
  begin
    v_category := (p ->> 'category')::local_business_category;
    v_lat := nullif(p ->> 'lat', '')::double precision;
    v_lng := nullif(p ->> 'lng', '')::double precision;
  exception when others then
    raise exception 'categoria o coordinate in un formato non valido';
  end;
  if v_category is null then raise exception 'manca la categoria'; end if;
  if (v_lat is null) <> (v_lng is null) then raise exception 'coordinate incomplete: servono latitudine e longitudine'; end if;
  if v_lat is not null then
    if v_lat not between -90 and 90 or v_lng not between -180 and 180 then raise exception 'coordinate fuori scala'; end if;
    v_location := st_setsrid(st_makepoint(v_lng, v_lat), 4326)::geography;
  end if;
  if local_event_text(p, 'phone') is not null and local_event_text(p, 'phone') !~ '^\+?[0-9][0-9 ./()-]{4,38}$' then
    raise exception 'telefono non valido: solo cifre, spazi e il + iniziale (es. +39 0187 790000)';
  end if;
  if local_event_text(p, 'email') is not null and local_event_text(p, 'email') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'email non valida';
  end if;
  if local_event_text(p, 'slug') is not null and exists (
       select 1 from local_businesses where pack_id = p_pack and slug = local_event_text(p, 'slug') and id <> v_id) then
    raise exception 'esiste già un''attività con questo identificativo in questo territorio: %', local_event_text(p, 'slug');
  end if;
  if p_verify then perform set_config('app.local_businesses', 'rpc:' || v_id::text, true); end if;

  if p_id is null then
    insert into local_businesses (id, pack_id, slug, name, category, subcategory, labels, address, location, phone, email, website)
    values (v_id, p_pack,
            coalesce(local_event_text(p, 'slug'),
                     studio_free_slug(local_event_text(p, 'name'), array(select slug from local_businesses where pack_id = p_pack))),
            local_event_text(p, 'name'), v_category, local_event_text(p, 'subcategory'), coalesce(p -> 'labels', '{}'),
            local_event_text(p, 'address'), v_location, local_event_text(p, 'phone'), local_event_text(p, 'email'),
            local_event_url(p, 'website', 'sito web'));
  else
    update local_businesses set
      name = local_event_text(p, 'name'), category = v_category, subcategory = local_event_text(p, 'subcategory'),
      labels = coalesce(p -> 'labels', '{}'), address = local_event_text(p, 'address'), location = v_location,
      phone = local_event_text(p, 'phone'), email = local_event_text(p, 'email'), website = local_event_url(p, 'website', 'sito web')
    where id = p_id;
  end if;
  if p_verify then
    update local_businesses set verified_at = now(), verified_by = auth.uid() where id = v_id;
  end if;
  perform set_config('app.local_businesses', '', true);
  select * into v_row from local_businesses where id = v_id;
  return studio_local_business_json(v_row);
end;
$$;

-- La redazione ha controllato i dati (sul posto, al telefono o sul sito dell'attività): data e autore dal database.
create function studio_verify_local_business(p_id uuid, p_note text default null)
returns jsonb language plpgsql set search_path = public as $$
declare v_row local_businesses;
begin
  select * into v_row from local_businesses where id = p_id;
  if v_row.id is null then raise exception 'attività non trovata'; end if;
  perform studio_require(can_edit_pack(v_row.pack_id), 'non hai i permessi per le attività di questo territorio');
  if length(p_note) > 500 then raise exception 'nota di verifica troppo lunga: al massimo 500 caratteri'; end if;
  perform set_config('app.local_businesses', 'rpc:' || p_id::text, true);
  update local_businesses set verified_at = now(), verified_by = auth.uid(), verification_note = nullif(btrim(p_note), '')
  where id = p_id returning * into v_row;
  perform set_config('app.local_businesses', '', true);
  return studio_local_business_json(v_row);
end;
$$;

-- Pubblicazione: bozza → pubblicata → ritirata → bozza (o di nuovo pubblicata). Pubblicare richiede la verifica.
create function studio_set_local_business_publication(p_id uuid, p_to text)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_row local_businesses;
  v_to local_business_publication;
begin
  select * into v_row from local_businesses where id = p_id;
  if v_row.id is null then raise exception 'attività non trovata'; end if;
  begin
    v_to := p_to::local_business_publication;
  exception when others then raise exception 'stato di pubblicazione sconosciuto: %', p_to; end;
  if v_to = v_row.publication then return studio_local_business_json(v_row); end if;
  if v_to = 'published' then
    perform studio_require(can_publish_pack(v_row.pack_id), 'non hai i permessi per pubblicare le attività di questo territorio');
    if v_row.verified_at is null then raise exception 'non si pubblica senza la verifica dei dati'; end if;
  elsif v_to = 'withdrawn' then
    if v_row.publication <> 'published' then raise exception 'si ritira solo un''attività pubblicata'; end if;
    perform studio_require(can_publish_pack(v_row.pack_id), 'non hai i permessi per ritirare le attività di questo territorio');
  else
    if v_row.publication <> 'withdrawn' then raise exception 'un''attività pubblicata si ritira prima di tornare in bozza'; end if;
    perform studio_require(can_edit_pack(v_row.pack_id), 'non hai i permessi per le attività di questo territorio');
  end if;
  perform set_config('app.local_businesses', 'rpc:' || p_id::text, true);
  update local_businesses set publication = v_to,
    published_at = case when v_to = 'published' then now() else published_at end,
    published_by = case when v_to = 'published' then auth.uid() else published_by end
  where id = p_id returning * into v_row;
  perform set_config('app.local_businesses', '', true);
  return studio_local_business_json(v_row);
end;
$$;

-- Elimina una bozza (un'attività pubblicata o ritirata la elimina solo l'amministratore: trigger di guardia).
create function studio_delete_local_business(p_id uuid)
returns void language plpgsql set search_path = public as $$
declare v_pack text;
begin
  select pack_id into v_pack from local_businesses where id = p_id;
  if v_pack is null then raise exception 'attività non trovata'; end if;
  perform studio_require(can_edit_pack(v_pack), 'non hai i permessi per le attività di questo territorio');
  delete from local_businesses where id = p_id;
end;
$$;

-- ---------------------------------------------------------------- 5. lettura pubblica

-- Attività pubblicate di una destinazione pubblicata, in ordine alfabetico (parità di trattamento). Gira con i
-- privilegi del proprietario: ogni filtro è scritto qui e il risultato contiene solo i campi pubblici, elencati uno
-- per uno (mai note interne né autori). Parametri non validi: errore 22023; territorio sconosciuto o non pubblicato: null.
create function public_local_businesses(p_pack text, p_lang text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_default text;
  v_locales text[];
  v_lang text;
begin
  if p_pack is null or length(p_pack) > 120 or p_pack !~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$' then
    raise exception 'territorio non valido' using errcode = '22023';
  end if;
  select pk.default_locale, coalesce(nullif(pk.locales, '{}'), array[pk.default_locale]) into v_default, v_locales
  from destinations d join packs pk on pk.id = d.pack_id
  where d.pack_id = p_pack and d.status = 'published';
  if v_default is null then return null; end if;
  v_lang := coalesce(p_lang, v_default);
  if not (v_lang = any (v_locales)) then raise exception 'lingua non disponibile per questo territorio' using errcode = '22023'; end if;
  return jsonb_build_object(
    'territory', jsonb_build_object('id', p_pack),
    'lang', v_lang,
    'businesses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'slug', b.slug, 'name', b.name, 'category', b.category, 'subcategory', b.subcategory,
        'description', coalesce(b.labels #>> array[v_lang, 'description'], b.labels #>> array[v_default, 'description']),
        'hours', coalesce(b.labels #>> array[v_lang, 'hours'], b.labels #>> array[v_default, 'hours']),
        'address', b.address,
        'lat', case when b.location is not null then st_y(b.location::geometry) end,
        'lng', case when b.location is not null then st_x(b.location::geometry) end,
        'phone', b.phone, 'email', b.email, 'website', b.website,
        'verifiedAt', b.verified_at)
        order by lower(b.name), b.id)
      from local_businesses b
      where b.pack_id = p_pack and b.publication = 'published'), '[]'));
end;
$$;

-- ---------------------------------------------------------------- 6. permessi sulle funzioni

do $$
declare f text;
begin
  foreach f in array array[
    'studio_local_business_json(local_businesses)', 'studio_local_businesses(text)',
    'studio_save_local_business(text,uuid,jsonb,boolean)', 'studio_verify_local_business(uuid,text)',
    'studio_set_local_business_publication(uuid,text)', 'studio_delete_local_business(uuid)',
    'local_business_clean_labels(text,jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array['local_businesses_prepare()', 'local_businesses_guard()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
revoke execute on function public_local_businesses(text, text) from public;
grant execute on function public_local_businesses(text, text) to anon, authenticated, service_role;
