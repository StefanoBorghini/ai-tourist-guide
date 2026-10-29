-- Foto delle attività locali (decisione del 2026-10-29): come le foto dei luoghi, con autore, licenza e provenienza
-- dichiarati e gli stessi vincoli di media_assets (pubblico dominio senza autore; licenza scritta con riferimento
-- all'accordo; dal web con l'indirizzo originale), più: mai «tutti i diritti riservati», licenze non commerciali solo
-- se il territorio le ammette (config.media.allowNonCommercial, come per i luoghi), al massimo 6 foto per attività.
--
-- Fuori dai Territory Pack e dai bundle, come le attività: non passano da pack_snapshot()/import_pack().
-- I file stanno nel bucket pubblico «business-photos», percorso <territorio>/<id attività>/<file>, perché la guida le
-- legge senza sessione (come i bundle pubblicati). Le scrive e le toglie solo chi può modificare il territorio;
-- l'elenco pubblico (public_local_businesses) mostra solo le foto delle attività pubblicate. Un file di una bozza è
-- raggiungibile solo da chi ne conosce il nome esatto (con un suffisso casuale).

-- ---------------------------------------------------------------- 1. bucket

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('business-photos', 'business-photos', true, 5 * 1024 * 1024, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Nome del file: <territorio>/<uuid dell'attività>/<nome>.jpg|jpeg|png|webp, solo minuscole, cifre e trattini.
create function business_photo_path_ok(p_name text)
returns boolean language sql immutable set search_path = public as $$
  select p_name ~ '^[a-z0-9]+([.-][a-z0-9]+)*/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[a-z0-9]+(-[a-z0-9]+)*\.(jpg|jpeg|png|webp)$'
     and length(p_name) <= 300;
$$;

create policy business_photos_editor_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'business-photos' and public.business_photo_path_ok(name)
              and public.can_edit_pack((storage.foldername(name))[1])
              and exists (select 1 from public.local_businesses b
                          where b.id::text = (storage.foldername(objects.name))[2]
                            and b.pack_id = (storage.foldername(objects.name))[1]));
create policy business_photos_editor_read on storage.objects for select to authenticated
  using (bucket_id = 'business-photos' and public.can_edit_pack((storage.foldername(name))[1]));
create policy business_photos_editor_delete on storage.objects for delete to authenticated
  using (bucket_id = 'business-photos' and public.can_edit_pack((storage.foldername(name))[1]));

-- Il file c'è davvero (con i privilegi del proprietario: il controllo non dipende dalle policy di lettura).
create function business_photo_file_exists(p_path text)
returns boolean language sql stable security definer set search_path = public, storage as $$
  select exists (select 1 from storage.objects where bucket_id = 'business-photos' and name = p_path);
$$;

-- ---------------------------------------------------------------- 2. tabella

create table local_business_photos (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references local_businesses (id) on delete cascade,
  pack_id       text not null references packs (id),
  storage_path  text not null unique check (business_photo_path_ok(storage_path)),
  position      smallint not null default 0,
  alt           jsonb not null default '{}' check (jsonb_typeof(alt) = 'object'),   -- {"it": "…", "en": "…"}
  author        text check (length(author) <= 200),
  license       media_license not null,
  source        media_source not null,
  original_url  text check (original_url is null or is_public_https_url(original_url)),
  license_note  text check (length(license_note) <= 500),
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users (id),
  check (license = 'public-domain' or author is not null),
  check (license <> 'licensed' or license_note is not null),
  check (source <> 'web' or original_url is not null),
  check (license <> 'all-rights-reserved')
);
create index local_business_photos_business_idx on local_business_photos (business_id, position);

-- Integrità per tutti: territorio dell'attività, percorso nella sua cartella, file presente, testi alternativi nelle
-- lingue del territorio (obbligatorio nella principale), licenza ammessa dal territorio, al massimo 6 foto.
create function local_business_photos_prepare()
returns trigger language plpgsql set search_path = public as $$
declare
  v_pack text;
  v_locales text[];
  v_default text;
  v_nc boolean;
  v_out jsonb := '{}';
  l record;
begin
  if tg_op = 'UPDATE' and (new.business_id, new.storage_path) is distinct from (old.business_id, old.storage_path) then
    raise exception 'una foto non cambia attività né file: eliminala e caricala di nuovo';
  end if;
  select b.pack_id into v_pack from local_businesses b where b.id = new.business_id;
  if v_pack is null then raise exception 'attività non trovata'; end if;
  new.pack_id := v_pack;
  if split_part(new.storage_path, '/', 1) <> v_pack or split_part(new.storage_path, '/', 2) <> new.business_id::text then
    raise exception 'il file della foto non è nella cartella dell''attività';
  end if;
  if not business_photo_file_exists(new.storage_path) then raise exception 'il file della foto non è stato caricato'; end if;
  select coalesce(nullif(locales, '{}'), array[default_locale]), default_locale,
         coalesce((config #>> '{media,allowNonCommercial}')::boolean, false)
    into v_locales, v_default, v_nc
  from packs where id = v_pack;
  for l in select key, value from jsonb_each(case when jsonb_typeof(new.alt) = 'object' then new.alt else '{}' end) loop
    continue when not (l.key = any (v_locales)) or jsonb_typeof(l.value) <> 'string' or btrim(l.value #>> '{}') = '';
    if length(btrim(l.value #>> '{}')) > 300 then raise exception 'testo alternativo troppo lungo (%): al massimo 300 caratteri', l.key; end if;
    v_out := v_out || jsonb_build_object(l.key, btrim(l.value #>> '{}'));
  end loop;
  if coalesce(v_out ->> v_default, '') = '' then
    raise exception 'manca il testo alternativo nella lingua principale del territorio (%): cosa si vede nella foto', v_default;
  end if;
  new.alt := v_out;
  new.author := nullif(btrim(new.author), '');
  new.license_note := nullif(btrim(new.license_note), '');
  if not v_nc and not (select commercial_use from media_license_rules where license = new.license) then
    raise exception 'licenza non commerciale: questo territorio non le ammette (come per le foto dei luoghi)';
  end if;
  if tg_op = 'INSERT' then
    if (select count(*) from local_business_photos where business_id = new.business_id) >= 6 then
      raise exception 'al massimo 6 foto per attività';
    end if;
    if current_user = 'authenticated' then new.created_by := auth.uid(); end if;
    new.created_at := now();
  end if;
  return new;
end;
$$;
create trigger local_business_photos_prepare_trg before insert or update on local_business_photos
  for each row execute function local_business_photos_prepare();
create trigger local_business_photos_revision_trg after insert or update or delete on local_business_photos
  for each row execute function record_revision();

alter table local_business_photos enable row level security;
revoke all on local_business_photos from anon;
grant select, insert, update, delete on local_business_photos to authenticated;
create policy local_business_photos_editor_read on local_business_photos for select using (can_edit_pack(pack_id));
create policy local_business_photos_editor_insert on local_business_photos for insert with check (can_edit_pack(pack_id));
create policy local_business_photos_editor_update on local_business_photos for update
  using (can_edit_pack(pack_id)) with check (can_edit_pack(pack_id));
create policy local_business_photos_editor_delete on local_business_photos for delete using (can_edit_pack(pack_id));

-- ---------------------------------------------------------------- 3. funzioni dello Studio

-- Registra una foto già caricata nel bucket. p: { path, alt {it, en}, author, license, source, originalUrl, licenseNote }
create function studio_add_business_photo(p_business uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_pack text;
  v_id uuid;
begin
  select pack_id into v_pack from local_businesses where id = p_business;
  if v_pack is null then raise exception 'attività non trovata'; end if;
  perform studio_require(can_edit_pack(v_pack), 'non hai i permessi per le attività di questo territorio');
  begin
    perform (p ->> 'license')::media_license, (p ->> 'source')::media_source;
  exception when others then raise exception 'licenza o provenienza non riconosciute'; end;
  insert into local_business_photos (business_id, pack_id, storage_path, position, alt, author, license, source, original_url, license_note)
  values (p_business, v_pack, p ->> 'path',
          coalesce((select max(position) + 1 from local_business_photos where business_id = p_business), 0),
          coalesce(p -> 'alt', '{}'), p ->> 'author', (p ->> 'license')::media_license, (p ->> 'source')::media_source,
          local_event_url(p, 'originalUrl', 'indirizzo originale'), p ->> 'licenseNote')
  returning id into v_id;
  return (select jsonb_build_object('id', f.id, 'path', f.storage_path) from local_business_photos f where f.id = v_id);
end;
$$;

-- Toglie la registrazione e restituisce il percorso del file, che lo Studio elimina dal bucket con la stessa sessione.
create function studio_delete_business_photo(p_id uuid)
returns text language plpgsql set search_path = public as $$
declare v_path text; v_pack text;
begin
  select storage_path, pack_id into v_path, v_pack from local_business_photos where id = p_id;
  if v_path is null then raise exception 'foto non trovata'; end if;
  perform studio_require(can_edit_pack(v_pack), 'non hai i permessi per le attività di questo territorio');
  delete from local_business_photos where id = p_id;
  return v_path;
end;
$$;

-- Prima foto: quella che la guida mostra per prima (copertina dell'attività).
create function studio_first_business_photo(p_id uuid)
returns void language plpgsql set search_path = public as $$
declare v_business uuid; v_pack text;
begin
  select business_id, pack_id into v_business, v_pack from local_business_photos where id = p_id;
  if v_business is null then raise exception 'foto non trovata'; end if;
  perform studio_require(can_edit_pack(v_pack), 'non hai i permessi per le attività di questo territorio');
  update local_business_photos set position = case when id = p_id then 0 else position + 1 end where business_id = v_business;
end;
$$;

create or replace function studio_local_business_json(b local_businesses)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', b.id, 'pack', b.pack_id, 'slug', b.slug, 'name', b.name, 'category', b.category, 'subcategory', b.subcategory,
    'labels', b.labels, 'address', b.address,
    'lat', case when b.location is not null then st_y(b.location::geometry) end,
    'lng', case when b.location is not null then st_x(b.location::geometry) end,
    'phone', b.phone, 'email', b.email, 'website', b.website, 'publication', b.publication,
    'verifiedAt', b.verified_at, 'verifiedBy', b.verified_by, 'verificationNote', b.verification_note,
    'createdAt', b.created_at, 'updatedAt', b.updated_at, 'publishedAt', b.published_at,
    'photos', coalesce((select jsonb_agg(jsonb_build_object(
        'id', f.id, 'path', f.storage_path, 'alt', f.alt, 'author', f.author, 'license', f.license, 'source', f.source,
        'originalUrl', f.original_url, 'licenseNote', f.license_note) order by f.position, f.created_at)
      from local_business_photos f where f.business_id = b.id), '[]'));
$$;

-- ---------------------------------------------------------------- 4. lettura pubblica (con le foto)

create or replace function public_local_businesses(p_pack text, p_lang text default null)
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
        'verifiedAt', b.verified_at,
        -- Foto: percorso nel bucket pubblico «business-photos» e crediti; mai chi le ha caricate né note interne.
        'photos', coalesce((select jsonb_agg(jsonb_build_object(
            'path', f.storage_path,
            'alt', coalesce(f.alt ->> v_lang, f.alt ->> v_default),
            'author', f.author, 'license', f.license, 'originalUrl', f.original_url) order by f.position, f.created_at)
          from local_business_photos f where f.business_id = b.id), '[]'))
        order by lower(b.name), b.id)
      from local_businesses b
      where b.pack_id = p_pack and b.publication = 'published'), '[]'));
end;
$$;

-- ---------------------------------------------------------------- 5. permessi sulle funzioni

do $$
declare f text;
begin
  foreach f in array array[
    'studio_add_business_photo(uuid,jsonb)', 'studio_delete_business_photo(uuid)', 'studio_first_business_photo(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  execute 'revoke execute on function local_business_photos_prepare() from public, anon, authenticated';
  execute 'revoke execute on function business_photo_file_exists(text) from public, anon';
  execute 'grant execute on function business_photo_file_exists(text) to authenticated, service_role';
end $$;
grant execute on function business_photo_path_ok(text) to anon, authenticated, service_role;
