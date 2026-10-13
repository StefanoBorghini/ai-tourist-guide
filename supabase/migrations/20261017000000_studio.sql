-- Studio (milestone 4): funzioni usate da /studio.
--
-- Nessuna tabella nuova. Le funzioni girano con i privilegi di chi chiama (security invoker):
-- valgono le policy RLS e i trigger redazionali già presenti (quattro occhi, storico, pubblicazione);
-- in più ogni modifica controlla esplicitamente il permesso, per dare un messaggio chiaro invece di
-- non cambiare nulla in silenzio. Le chiama il server dell'app con la sessione dell'utente.
--
-- Le modifiche restano nel database: arrivano all'app solo con la pubblicazione (milestone 5).

-- Motivazione dell'ultima decisione di revisione (rifiuto, ritiro della verifica). Lo storico
-- delle decisioni precedenti resta in content_revisions.
alter table assertions add column review_note text check (char_length(review_note) <= 2000);

-- Limiti del bucket dei media (gli stessi dei vincoli su media_assets; 50 MB è il massimo del piano gratuito).
update storage.buckets
set file_size_limit = 50 * 1024 * 1024,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm',
                               'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav']
where id = 'media';

-- ---------------------------------------------------------------- supporto

create or replace function studio_node_name(p_node uuid)
returns text language sql stable set search_path = public as $$
  select coalesce(
    (select name from node_labels where node_id = p_node and locale = 'it'),
    (select name from node_labels where node_id = p_node order by locale limit 1),
    (select slug from nodes where id = p_node));
$$;

create or replace function studio_require(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception '%', p_message using errcode = '42501'; end if;
end;
$$;

-- Riferimento «slug» o «pack:slug» → id del nodo, solo nel pack o nei pack da cui dipende.
create or replace function studio_place_ref(p_pack text, p_ref text)
returns uuid language plpgsql stable set search_path = public as $$
declare
  v_pack text := case when position(':' in p_ref) > 0 then split_part(p_ref, ':', 1) else p_pack end;
  v_slug text := case when position(':' in p_ref) > 0 then split_part(p_ref, ':', 2) else p_ref end;
  v uuid;
begin
  if v_pack <> p_pack and not exists (select 1 from pack_dependencies where pack_id = p_pack and depends_on_id = v_pack) then
    raise exception 'il luogo % non appartiene al territorio né ai territori da cui dipende', p_ref;
  end if;
  select n.id into v from nodes n join places pl on pl.node_id = n.id where n.pack_id = v_pack and n.slug = v_slug;
  if v is null then raise exception 'luogo non trovato: %', p_ref; end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------- chi sono

create or replace function studio_me()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'userId', auth.uid(),
    'admin', is_platform_admin(),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('role', m.role, 'pack', m.pack_scope) order by m.role, m.pack_scope)
                       from memberships m where m.user_id = auth.uid()), '[]'));
$$;

-- ---------------------------------------------------------------- territori

create or replace function studio_packs()
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'kind', p.kind,
    'title', p.title,
    'version', p.version,
    'releaseStage', p.release_stage,
    'places', (select count(*) from nodes n join places pl on pl.node_id = n.id where n.pack_id = p.id),
    'routes', (select count(*) from routes r where r.pack_id = p.id),
    'media', (select count(*) from media_assets m where m.pack_id = p.id),
    'assertions', (select coalesce(jsonb_object_agg(s.status, s.n), '{}')
                   from (select status, count(*) n from assertions a where a.pack_id = p.id group by status) s),
    'canEdit', can_edit_pack(p.id),
    'canVerify', can_verify_pack(p.id)) order by p.id), '[]')
  from packs p where is_pack_staff(p.id);
$$;

-- ---------------------------------------------------------------- luoghi

create or replace function studio_places(p_pack text)
returns jsonb language sql stable set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', n.slug,
    'name', studio_node_name(n.id),
    'placeKind', pl.place_kind,
    'categories', to_jsonb(pl.categories),
    'importance', pl.importance,
    'coordinateStatus', pl.coordinate_status,
    'media', (select count(*) from media_subjects ms where ms.node_id = n.id)) order by studio_node_name(n.id)), '[]')
  from nodes n join places pl on pl.node_id = n.id
  where n.pack_id = p_pack;
$$;

create or replace function studio_place(p_pack text, p_slug text)
returns jsonb language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'slug', n.slug,
    'labels', pack_node_labels(n.id),
    'placeKind', pl.place_kind,
    'categories', to_jsonb(pl.categories),
    'location', pack_lnglat(pl.location),
    'importance', pl.importance,
    'dwellMin', pl.dwell_min,
    'walkable', pl.walkable,
    'coordinates', jsonb_build_object(
      'status', pl.coordinate_status, 'method', pl.coordinate_method,
      'verifiedAt', pl.coordinate_verified_at, 'verifiedBy', pl.coordinate_verified_by,
      'mapVerifiedAt', pl.coordinate_map_verified_at, 'previousLocation', pack_lnglat(pl.previous_location)),
    'storyStatus', pl.story_status,
    'fieldNotes', to_jsonb(pl.field_notes),
    'media', coalesce((select jsonb_agg(jsonb_build_object(
                         'slug', m.slug, 'kind', m.kind, 'path', m.storage_path, 'poster', m.poster_path,
                         'alt', (select alt from media_labels l where l.media_id = m.id order by (l.locale <> 'it'), l.locale limit 1),
                         'author', m.author, 'license', m.license) order by ms.position, m.slug)
                       from media_subjects ms join media_assets m on m.id = ms.media_id where ms.node_id = n.id), '[]'),
    'canEdit', can_edit_pack(p_pack))
  from nodes n join places pl on pl.node_id = n.id
  where n.pack_id = p_pack and n.slug = p_slug;
$$;

-- Modifica di un luogo. Campi facoltativi: labels { it|en: { name, short } }, importance, dwellMin,
-- categories, fieldNotes, location + coordinateMethod. Le coordinate cambiate tornano «preliminari»:
-- la verifica su mappa o sul campo si dichiara a parte, non si deduce da una modifica.
create or replace function studio_update_place(p_pack text, p_slug text, p jsonb)
returns jsonb language plpgsql set search_path = public, extensions as $$
declare
  v_node uuid;
  v_old geography;
  v_new geography;
  l record;
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per modificare i luoghi di questo territorio');
  select n.id, pl.location into v_node, v_old from nodes n join places pl on pl.node_id = n.id
  where n.pack_id = p_pack and n.slug = p_slug;
  if v_node is null then raise exception 'luogo non trovato: %', p_slug; end if;

  for l in select key, value from jsonb_each(coalesce(p -> 'labels', '{}')) loop
    if l.key not in (select code from locales where enabled) then raise exception 'lingua non attiva: %', l.key; end if;
    if coalesce(trim(l.value ->> 'name'), '') = '' then raise exception 'il nome (%) non può essere vuoto', l.key; end if;
    insert into node_labels (node_id, locale, name, short_description)
    values (v_node, l.key, trim(l.value ->> 'name'), nullif(trim(l.value ->> 'short'), ''))
    on conflict (node_id, locale) do update
      set name = excluded.name, short_description = excluded.short_description;
  end loop;

  if p ? 'importance' and ((p ->> 'importance')::int not between 1 and 5) then
    raise exception 'importanza tra 1 e 5';
  end if;
  if p ? 'dwellMin' and ((p ->> 'dwellMin')::int not between 1 and 240) then
    raise exception 'sosta tra 1 e 240 minuti';
  end if;
  if p ? 'categories' and (jsonb_array_length(p -> 'categories') = 0 or exists (
        select 1 from jsonb_array_elements_text(p -> 'categories') c where c !~ '^[a-z0-9]+(-[a-z0-9]+)*$')) then
    raise exception 'almeno una categoria; solo minuscole, cifre e trattini';
  end if;

  update places set
    importance = coalesce((p ->> 'importance')::smallint, importance),
    dwell_min = coalesce((p ->> 'dwellMin')::smallint, dwell_min),
    categories = case when p ? 'categories' then pack_text_array(p -> 'categories') else categories end,
    field_notes = case when p ? 'fieldNotes'
                       then array(select trim(x) from jsonb_array_elements_text(p -> 'fieldNotes') x where trim(x) <> '')
                       else field_notes end
  where node_id = v_node;

  if p ? 'location' then
    v_new := pack_point(p -> 'location');
    if (p #>> '{location,0}')::float8 not between -180 and 180 or (p #>> '{location,1}')::float8 not between -90 and 90 then
      raise exception 'coordinate fuori dai limiti';
    end if;
    if not st_equals(v_new::geometry, v_old::geometry) then
      if coalesce(trim(p ->> 'coordinateMethod'), '') = '' then
        raise exception 'per cambiare le coordinate indica come sono state ottenute';
      end if;
      update places set
        previous_location = v_old, location = v_new, coordinate_status = 'preliminary',
        coordinate_method = trim(p ->> 'coordinateMethod'), coordinate_verified_at = null,
        coordinate_verified_by = null, coordinate_map_verified_at = null
      where node_id = v_node;
    end if;
  end if;

  update nodes set updated_at = now() where id = v_node;
  return studio_place(p_pack, p_slug);
end;
$$;

-- ---------------------------------------------------------------- percorsi

create or replace function studio_routes(p_pack text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', r.slug,
    'name', coalesce(r.labels #>> '{it,name}', r.labels #>> '{en,name}', r.slug),
    'durationMin', r.duration_min,
    'calibration', r.calibration,
    'stops', (select count(*) from route_stops s where s.route_id = r.id)) order by r.slug), '[]')
  from routes r where r.pack_id = p_pack;
$$;

create or replace function studio_route(p_pack text, p_slug text)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'slug', r.slug,
    'labels', r.labels,
    'durationMin', r.duration_min,
    'calibration', r.calibration,
    'difficulty', r.difficulty,
    'notes', to_jsonb(r.notes),
    'stops', coalesce((select jsonb_agg(jsonb_build_object(
                         'place', n.pack_id || ':' || n.slug, 'name', studio_node_name(n.id),
                         'dwellMin', s.dwell_min, 'optional', s.optional) order by s.position)
                       from route_stops s join nodes n on n.id = s.place_node_id where s.route_id = r.id), '[]'),
    'places', coalesce((select jsonb_agg(jsonb_build_object('place', n.pack_id || ':' || n.slug, 'name', studio_node_name(n.id))
                                         order by studio_node_name(n.id))
                        from nodes n join places pl on pl.node_id = n.id
                        where n.pack_id = p_pack
                           or n.pack_id in (select depends_on_id from pack_dependencies where pack_id = p_pack)), '[]'),
    'canEdit', can_edit_pack(p_pack))
  from routes r where r.pack_id = p_pack and r.slug = p_slug;
$$;

-- Sostituisce le tappe (ordine, aggiunte, rimozioni) in un colpo solo. Un percorso calibrato sul
-- campo con tappe diverse non è più calibrato: torna «draft».
create or replace function studio_set_route_stops(p_pack text, p_slug text, p_stops jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_route uuid;
  v_before text;
  v_after text;
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per modificare i percorsi di questo territorio');
  select id into v_route from routes where pack_id = p_pack and slug = p_slug;
  if v_route is null then raise exception 'percorso non trovato: %', p_slug; end if;
  if jsonb_typeof(p_stops) <> 'array' or jsonb_array_length(p_stops) = 0 then
    raise exception 'un percorso ha almeno una tappa';
  end if;
  if (select count(distinct s ->> 'place') from jsonb_array_elements(p_stops) s) <> jsonb_array_length(p_stops) then
    raise exception 'un luogo compare due volte tra le tappe';
  end if;
  if exists (select 1 from jsonb_array_elements(p_stops) s
             where s ? 'dwellMin' and jsonb_typeof(s -> 'dwellMin') <> 'null' and (s ->> 'dwellMin')::int not between 1 and 240) then
    raise exception 'sosta tra 1 e 240 minuti';
  end if;

  select string_agg(place_node_id::text || '/' || coalesce(dwell_min::text, '') || '/' || optional::text, ',' order by position)
  into v_before from route_stops where route_id = v_route;

  delete from route_stops where route_id = v_route;
  insert into route_stops (route_id, position, place_node_id, dwell_min, optional)
  select v_route, (s.ordinality - 1)::smallint, studio_place_ref(p_pack, s.value ->> 'place'),
         nullif(s.value ->> 'dwellMin', '')::smallint, coalesce((s.value ->> 'optional')::boolean, false)
  from jsonb_array_elements(p_stops) with ordinality s;

  select string_agg(place_node_id::text || '/' || coalesce(dwell_min::text, '') || '/' || optional::text, ',' order by position)
  into v_after from route_stops where route_id = v_route;
  if v_before is distinct from v_after then
    update routes set calibration = 'draft' where id = v_route and calibration = 'field_calibrated';
  end if;
  return studio_route(p_pack, p_slug);
end;
$$;

-- ---------------------------------------------------------------- affermazioni e revisione

create or replace function studio_assertions(p_pack text, p_status text default null)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', a.slug,
    'text', coalesce((select statement from assertion_texts t where t.assertion_id = a.id and t.locale = 'it'),
                     (select statement from assertion_texts t where t.assertion_id = a.id order by t.locale limit 1)),
    'subject', studio_node_name(a.subject_id),
    'type', a.type,
    'certainty', a.certainty,
    'status', a.status,
    'authoredBy', a.authored_by,
    'verifiedBy', a.verified_by,
    'verifiedAt', a.verified_at,
    'reviewNote', a.review_note,
    'evidence', coalesce((select jsonb_agg(jsonb_build_object('position', e.position, 'title', s.title, 'attribution', e.attribution,
                                                              'locator', e.locator, 'url', s.url) order by e.position)
                          from evidence e join sources s on s.id = e.source_id where e.assertion_id = a.id), '[]'),
    'mine', a.authored_by = auth.uid()::text) order by a.status, a.slug), '[]')
  from assertions a
  where a.pack_id = p_pack and (p_status is null or a.status::text = p_status);
$$;

-- Azioni: submit (bozza o respinta → in revisione), verify (in revisione → verificata: solo esperti
-- o redazione, mai l'autore, con almeno una prova non dedotta), reject (in revisione → respinta,
-- con motivazione), reopen (verificata → in revisione, con motivazione).
create or replace function studio_review_assertion(p_pack text, p_slug text, p_action text, p_note text default null)
returns jsonb language plpgsql set search_path = public as $$
declare
  a assertions%rowtype;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into a from assertions where pack_id = p_pack and slug = p_slug;
  if a.id is null then raise exception 'affermazione non trovata: %', p_slug; end if;

  if p_action = 'submit' then
    perform studio_require(can_edit_pack(p_pack) or can_verify_pack(p_pack), 'non hai i permessi su questo territorio');
    if a.status not in ('draft', 'rejected') then raise exception 'si manda in revisione solo una bozza o un''affermazione respinta'; end if;
    update assertions set status = 'in_review', review_note = v_note where id = a.id;
  elsif p_action = 'verify' then
    perform studio_require(can_verify_pack(p_pack), 'solo un esperto o la redazione possono verificare');
    if a.status <> 'in_review' then raise exception 'si verifica solo un''affermazione in revisione'; end if;
    if a.authored_by = auth.uid()::text then
      raise exception 'regola dei quattro occhi: chi ha scritto l''affermazione non può verificarla' using errcode = '42501';
    end if;
    if not exists (select 1 from evidence where assertion_id = a.id) then
      raise exception 'nessuna fonte collegata: non si può verificare';
    end if;
    if not exists (select 1 from evidence where assertion_id = a.id and attribution = 'explicit') then
      raise exception 'le fonti collegate sono solo dedotte: confermale sulla fonte prima di verificare';
    end if;
    if not exists (select 1 from assertion_texts where assertion_id = a.id) then
      raise exception 'manca il testo dell''affermazione';
    end if;
    update assertions set status = 'verified', review_note = v_note where id = a.id;
  elsif p_action = 'reject' then
    perform studio_require(can_verify_pack(p_pack), 'solo un esperto o la redazione possono respingere');
    if a.status <> 'in_review' then raise exception 'si respinge solo un''affermazione in revisione'; end if;
    if v_note is null then raise exception 'indica il motivo del rifiuto'; end if;
    update assertions set status = 'rejected', review_note = v_note where id = a.id;
  elsif p_action = 'reopen' then
    perform studio_require(can_edit_pack(p_pack) or can_verify_pack(p_pack), 'non hai i permessi su questo territorio');
    if a.status <> 'verified' then raise exception 'si riapre solo un''affermazione verificata'; end if;
    if v_note is null then raise exception 'indica perché la verifica va ritirata'; end if;
    update assertions set status = 'in_review', verified_by = null, verified_at = null, review_note = v_note where id = a.id;
  else
    raise exception 'azione sconosciuta: %', p_action;
  end if;

  return (select x from jsonb_array_elements(studio_assertions(p_pack)) x where x ->> 'slug' = p_slug);
end;
$$;

-- Conferma di una fonte dedotta: chi verifica l'ha controllata e indica dove (pagina, sezione, URL).
-- Senza almeno una fonte confermata un'affermazione non si verifica. La conferma resta nello storico
-- come nota dell'affermazione.
create or replace function studio_confirm_evidence(p_pack text, p_slug text, p_position int, p_locator text)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_assertion uuid;
  v_title text;
  v_locator text := nullif(trim(coalesce(p_locator, '')), '');
begin
  perform studio_require(can_verify_pack(p_pack), 'solo un esperto o la redazione possono confermare una fonte');
  select id into v_assertion from assertions where pack_id = p_pack and slug = p_slug;
  if v_assertion is null then raise exception 'affermazione non trovata: %', p_slug; end if;
  if v_locator is null then raise exception 'indica dove hai trovato l''informazione nella fonte (pagina, sezione o indirizzo)'; end if;
  update evidence e set attribution = 'explicit', locator = v_locator
  from sources s
  where s.id = e.source_id and e.assertion_id = v_assertion and e.position = p_position and e.attribution = 'inferred'
  returning s.title into v_title;
  if v_title is null then raise exception 'nessuna fonte dedotta in quella posizione'; end if;
  update assertions set review_note = left('Fonte confermata (' || v_title || '): ' || v_locator, 2000) where id = v_assertion;
  return (select x from jsonb_array_elements(studio_assertions(p_pack)) x where x ->> 'slug' = p_slug);
end;
$$;

-- ---------------------------------------------------------------- media

create or replace function studio_media(p_pack text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', m.slug,
    'kind', m.kind,
    'path', m.storage_path,
    'poster', m.poster_path,
    'alt', (select alt from media_labels l where l.media_id = m.id order by (l.locale <> 'it'), l.locale limit 1),
    'author', m.author,
    'license', m.license,
    'source', m.source,
    'bytes', m.bytes,
    'cover', m.is_cover,
    'subjects', coalesce((select jsonb_agg(studio_node_name(ms.node_id) order by ms.position)
                          from media_subjects ms where ms.media_id = m.id), '[]')) order by m.slug), '[]')
  from media_assets m where m.pack_id = p_pack;
$$;

-- Registra un'immagine già caricata nel bucket «media» (percorso <pack>/<file>).
-- p: { file, sha256, mimeType, bytes, alt { it, en }, caption { it, en }, author, license, source,
--      attribution, originalUrl, licenseNote, subjects [ref] }
create or replace function studio_register_media(p_pack text, p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_path text := p_pack || '/' || (p ->> 'file');
  v_base text := lower(regexp_replace(regexp_replace(p ->> 'file', '\.[^.]*$', ''), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug text;
  v_id uuid;
  i int := 1;
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per aggiungere media a questo territorio');
  if coalesce(p ->> 'file', '') !~ '^[A-Za-z0-9._-]+\.(jpe?g|png|webp)$' then
    raise exception 'nome file non valido (jpg, png o webp)';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'media' and name = v_path) then
    raise exception 'il file % non è nel bucket media: caricalo prima', v_path;
  end if;
  if coalesce(trim(p #>> '{alt,it}'), '') = '' then raise exception 'serve il testo alternativo in italiano'; end if;
  if coalesce(jsonb_array_length(p -> 'subjects'), 0) = 0 then raise exception 'indica almeno un luogo raffigurato'; end if;
  if coalesce(p ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then raise exception 'impronta sha256 non valida'; end if;

  v_base := trim(both '-' from v_base);
  if v_base = '' then v_base := 'immagine'; end if;
  v_slug := v_base;
  while exists (select 1 from media_assets where pack_id = p_pack and slug = v_slug) loop
    i := i + 1;
    v_slug := v_base || '-' || i;
  end loop;

  insert into media_assets (pack_id, slug, kind, storage_path, sha256, source, author, license, attribution,
                            original_url, license_note, mime_type, bytes, uploaded_by, status)
  values (p_pack, v_slug, 'image', v_path, p ->> 'sha256', (p ->> 'source')::media_source,
          nullif(trim(p ->> 'author'), ''), (p ->> 'license')::media_license, nullif(trim(p ->> 'attribution'), ''),
          nullif(trim(p ->> 'originalUrl'), ''), nullif(trim(p ->> 'licenseNote'), ''),
          p ->> 'mimeType', (p ->> 'bytes')::bigint, auth.uid(), 'ready')
  returning id into v_id;

  insert into media_labels (media_id, locale, alt, caption)
  select v_id, l.code, trim(p #>> array['alt', l.code]), nullif(trim(p #>> array['caption', l.code]), '')
  from locales l where l.enabled and coalesce(trim(p #>> array['alt', l.code]), '') <> '';

  insert into media_subjects (media_id, node_id, position)
  select v_id, studio_place_ref(p_pack, s.value), (s.ordinality - 1)::smallint
  from jsonb_array_elements_text(p -> 'subjects') with ordinality s;

  return (select x from jsonb_array_elements(studio_media(p_pack)) x where x ->> 'slug' = v_slug);
end;
$$;

-- ---------------------------------------------------------------- permessi di esecuzione

do $$
declare f text;
begin
  foreach f in array array[
    'studio_me()', 'studio_packs()', 'studio_places(text)', 'studio_place(text, text)',
    'studio_update_place(text, text, jsonb)', 'studio_routes(text)', 'studio_route(text, text)',
    'studio_set_route_stops(text, text, jsonb)', 'studio_assertions(text, text)',
    'studio_review_assertion(text, text, text, text)', 'studio_confirm_evidence(text, text, int, text)', 'studio_media(text)', 'studio_register_media(text, jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
