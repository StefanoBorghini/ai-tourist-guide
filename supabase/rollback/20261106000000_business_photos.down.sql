-- Revoca di 20261106000000_business_photos.sql: toglie le foto delle attività e il loro bucket.
-- Si ferma PRIMA di cambiare qualcosa se c'è anche una sola foto registrata o un file nel bucket: vanno eliminati dallo
-- Studio (che toglie anche i file) prima di tornare indietro.
begin;
set local lock_timeout = '10s';
lock table local_business_photos in access exclusive mode;
do $$
declare v bigint; f bigint;
begin
  select count(*) into v from local_business_photos;
  select count(*) into f from storage.objects where bucket_id = 'business-photos';
  if v > 0 or f > 0 then
    raise exception 'REVOCA FOTO DELLE ATTIVITÀ interrotta, nulla è stato modificato: % foto registrate e % file nel bucket.', v, f;
  end if;
end $$;

create or replace function studio_local_business_json(b local_businesses)
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
        'verifiedAt', b.verified_at)
        order by lower(b.name), b.id)
      from local_businesses b
      where b.pack_id = p_pack and b.publication = 'published'), '[]'));
end;
$$;

drop function if exists studio_first_business_photo(uuid);
drop function if exists studio_delete_business_photo(uuid);
drop function if exists studio_add_business_photo(uuid, jsonb);
drop table if exists local_business_photos;
drop function if exists local_business_photos_prepare();
drop policy if exists business_photos_editor_insert on storage.objects;
drop policy if exists business_photos_editor_read on storage.objects;
drop policy if exists business_photos_editor_delete on storage.objects;
drop function if exists business_photo_file_exists(text);
drop function if exists business_photo_path_ok(text);
delete from storage.buckets where id = 'business-photos';
commit;
