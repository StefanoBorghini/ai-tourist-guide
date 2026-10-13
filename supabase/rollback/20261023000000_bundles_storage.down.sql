-- Revoca di 20261023000000_bundles_storage.sql: torna la lettura pubblica delle righe del bucket «bundles»
-- (elenco dei file per chiunque) e sparisce la cancellazione dei contenuti superati.
drop policy if exists bundles_files_publisher_delete on storage.objects;
drop policy if exists bundles_files_publisher_read on storage.objects;
drop policy if exists bundles_index_public_list on storage.objects;
create policy bundles_public_read on storage.objects for select
  using (bucket_id = 'bundles');

-- Pubblicazioni immutabili (R2): tornano i nomi, l'inserimento e l'aggiornamento di 20261021000000. I file già
-- scritti nelle cartelle delle pubblicazioni e gli indici numerati restano nel bucket; l'app precedente non li
-- legge (prima di questa revoca va rimessa l'app precedente, vedi ACCESSO-CONTENUTI.md).
drop policy if exists bundles_files_publisher_insert on storage.objects;
drop policy if exists bundles_files_publisher_update on storage.objects;
create or replace function bundle_object_name_ok(p_name text)
returns boolean language sql immutable as $$
  select p_name = 'index.json'
      or p_name ~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}-full/(manifest\.json|content\.[0-9a-f]{8,64}\.json|media/[0-9a-f]{16}\.(jpg|jpeg|png|webp|mp4|webm|mp3|m4a))$';
$$;
create policy bundles_files_publisher_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'bundles' and public.bundle_object_name_ok(name) and (
    (name <> 'index.json' and public.can_publish_pack((storage.foldername(name))[1]))
    or (name = 'index.json' and public.studio_can_publish_any())));
create policy bundles_files_publisher_update on storage.objects for update to authenticated
  using (bucket_id = 'bundles' and public.bundle_object_name_ok(name) and (
    (name <> 'index.json' and public.can_publish_pack((storage.foldername(name))[1]))
    or (name = 'index.json' and public.studio_can_publish_any())))
  with check (bucket_id = 'bundles' and public.bundle_object_name_ok(name) and (
    (name <> 'index.json' and public.can_publish_pack((storage.foldername(name))[1]))
    or (name = 'index.json' and public.studio_can_publish_any())));
drop function if exists studio_index_snapshot();
drop function if exists studio_index_issued(text);
drop sequence if exists public_index_generation;
drop function if exists studio_publication_writable(text, text);
drop function if exists studio_publication_dead_ids(text);
drop function if exists studio_publication_dead(text, text);
drop function if exists studio_legacy_layout_dead(text);
drop function if exists studio_index_reflects(bigint);

-- Una pubblicazione alla volta: sparisce la forma con l'identificativo e torna studio_publication_finish di
-- 20261020000000 (le pubblicazioni «building» rimaste si chiudono ancora: la funzione precedente le considera).
drop function if exists studio_publication_claim(text);
drop function if exists studio_publication_renew(text, uuid);
drop function if exists studio_publication_finish(text, boolean, jsonb, jsonb, uuid);
drop function if exists studio_publication_record(uuid, text, boolean, jsonb, jsonb);
-- p_bundles: [{ locale, url, manifest, entry }] — manifest come nel file, entry come nell'indice dell'app.
create or replace function studio_publication_finish(p_pack text, p_ok boolean, p_report jsonb, p_bundles jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_pub uuid;
  v_ids uuid[] := '{}';
  v_id uuid;
  b jsonb;
begin
  perform studio_require(can_publish_pack(p_pack), 'non hai i permessi per pubblicare questo territorio');
  select id into v_pub from publications
  where pack_id = p_pack and status in ('requested', 'building') order by created_at desc limit 1;
  if v_pub is null then raise exception 'nessuna pubblicazione in corso per %', p_pack; end if;

  if not p_ok then
    update publications set status = 'failed', finished_at = now(),
      report = coalesce(report, '{}') || jsonb_build_object('pipeline', p_report)
    where id = v_pub;
    return jsonb_build_object('publication', v_pub, 'status', 'failed');
  end if;

  if jsonb_typeof(p_bundles) is distinct from 'array' or jsonb_array_length(p_bundles) = 0 then
    raise exception 'una pubblicazione riuscita ha almeno un bundle';
  end if;
  for b in select value from jsonb_array_elements(p_bundles) loop
    if b -> 'manifest' ->> 'destination' is distinct from p_pack or b -> 'entry' ->> 'destination' is distinct from p_pack then
      raise exception 'bundle di un altro territorio';
    end if;
    if coalesce(b ->> 'url', '') !~ ('^/pub/' || replace(p_pack, '.', '\.') || '/') then
      raise exception 'indirizzo del bundle fuori dalla cartella del territorio: %', b ->> 'url';
    end if;
    insert into bundles (pack_id, locale, flavor, version, schema_version, min_app_version, kb_hash, manifest, total_bytes, url)
    values (p_pack, b ->> 'locale', 'full',
            coalesce((select max(version) from bundles where pack_id = p_pack and locale = b ->> 'locale' and flavor = 'full'), 0) + 1,
            (b -> 'manifest' ->> 'bundleSchemaVersion')::smallint, b -> 'manifest' ->> 'minAppVersion',
            b -> 'manifest' ->> 'kbHash', b -> 'manifest', (b -> 'manifest' ->> 'totalBytes')::bigint, b ->> 'url')
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  update publications set status = 'published', finished_at = now(), bundle_ids = v_ids,
    report = coalesce(report, '{}') || jsonb_build_object('pipeline', p_report,
      'entries', (select jsonb_agg(value -> 'entry') from jsonb_array_elements(p_bundles)))
  where id = v_pub;
  return jsonb_build_object('publication', v_pub, 'status', 'published', 'bundles', to_jsonb(v_ids));
end;
$$;

