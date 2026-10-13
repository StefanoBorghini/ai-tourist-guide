-- Pubblicazione dallo Studio all'app (milestone 5; vedi docs/v0.3-platform/PUBBLICAZIONE.md).
--
-- Nessuna tabella nuova: publications (richiesta ed esito), bundles (un record per lingua compilata),
-- bucket pubblico «bundles» (file dei bundle e indice letto dall'app).
-- La compilazione la fa il server dell'app con la sessione di chi pubblica: nessuna chiave di servizio.
-- Il database decide chi può pubblicare e quale versione è in linea; l'indice pubblico si calcola da qui.

-- ---------------------------------------------------------------- chi pubblica

-- Chi ha il permesso di pubblicare almeno un territorio (può riscrivere l'indice, che si calcola dal database).
create or replace function studio_can_publish_any()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m where m.user_id = auth.uid()
                 and m.role in ('platform_admin', 'platform_editor', 'territory_editor'));
$$;

-- File dei bundle: <pack>/<lingua>-full/... li scrive chi pubblica quel territorio; index.json chi pubblica.
-- Nessuna eliminazione: i file restano (hanno l'impronta nel nome), così chi ha già scaricato una versione
-- non si ritrova con file mancanti.
create policy bundles_files_publisher_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'bundles' and (
    public.can_publish_pack((storage.foldername(name))[1])
    or (name = 'index.json' and public.studio_can_publish_any())));
create policy bundles_files_publisher_update on storage.objects for update to authenticated
  using (bucket_id = 'bundles' and (
    public.can_publish_pack((storage.foldername(name))[1])
    or (name = 'index.json' and public.studio_can_publish_any())))
  with check (bucket_id = 'bundles' and (
    public.can_publish_pack((storage.foldername(name))[1])
    or (name = 'index.json' and public.studio_can_publish_any())));

-- ---------------------------------------------------------------- richiesta di ripubblicazione

-- Un territorio già pubblicato si ripubblica (per portare nell'app le modifiche) con un nuovo controllo superato.
create or replace function studio_request_publication(p_pack text, p_report jsonb)
returns uuid language plpgsql set search_path = public as $$
declare
  v_status publish_status;
  v_blockers text[];
  v_id uuid;
begin
  perform studio_require(can_publish_pack(p_pack), 'non hai i permessi per pubblicare questo territorio');
  select status into v_status from destinations where pack_id = p_pack;
  if v_status is distinct from 'published' then
    raise exception 'si ripubblica solo un territorio già approvato per la pubblicazione';
  end if;
  v_blockers := studio_publish_blockers(p_pack);
  if cardinality(v_blockers) > 0 then raise exception 'non si può pubblicare: %', array_to_string(v_blockers, '; '); end if;
  if p_report is null or coalesce((p_report ->> 'ok')::boolean, false) is not true then
    raise exception 'manca un controllo di pubblicazione superato: eseguilo dallo Studio';
  end if;
  insert into publications (pack_id, requested_by, status, report, note)
  values (p_pack, auth.uid(), 'requested', p_report, 'ripubblicazione dallo Studio')
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- esito della compilazione

-- Chiude l'ultima pubblicazione richiesta del territorio. Con esito positivo registra i bundle (uno per
-- lingua, versione progressiva) e le voci dell'indice; con esito negativo la segna come fallita e la
-- versione in linea resta quella di prima.
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

-- ---------------------------------------------------------------- indice pubblico

-- Ciò che l'app mostra: per ogni destinazione approvata (stato «published»), le voci dell'ultima
-- pubblicazione riuscita. Una destinazione ritirata o mai compilata non c'è. Stesso formato
-- dell'indice dei bundle compilati dai file ({ bundles: [...] }).
create or replace function public_bundle_index()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('bundles', coalesce(jsonb_agg(e.value order by e.value ->> 'name', e.value ->> 'locale'), '[]'))
  from destinations d
  join packs pk on pk.id = d.pack_id and not pk.fictional
  cross join lateral (
    select p.report from publications p
    where p.pack_id = d.pack_id and p.status = 'published'
    order by p.finished_at desc nulls last, p.created_at desc limit 1) lp
  cross join lateral jsonb_array_elements(coalesce(lp.report -> 'entries', '[]')) e
  where d.status = 'published';
$$;

-- ---------------------------------------------------------------- permessi di esecuzione

do $$
declare f text;
begin
  foreach f in array array[
    'studio_can_publish_any()', 'studio_request_publication(text, jsonb)',
    'studio_publication_finish(text, boolean, jsonb, jsonb)', 'public_bundle_index()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
