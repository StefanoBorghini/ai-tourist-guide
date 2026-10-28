-- Revoca di 20261103000000_admin_self_verify.sql: torna la regola dei quattro occhi per tutti.
-- Le affermazioni verificate dall'autore tornano in revisione (non si cancella niente).

update assertions set status = 'in_review', verified_by = null, verified_at = null, self_verified = false,
  review_note = left('Verifica dell''autore ritirata dalla revoca della migrazione 20261103', 2000)
where self_verified;

create or replace function editorial_assertion_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.authored_by := auth.uid()::text;
    if new.status not in ('draft', 'in_review') then
      raise exception 'una nuova affermazione nasce in bozza o in revisione';
    end if;
    return new;
  end if;
  -- Chi non verifica non può cambiare un'affermazione già verificata senza riportarla in revisione.
  if new.status is distinct from old.status and new.status in ('verified', 'rejected', 'blocked', 'deprecated') then
    if not can_verify_pack(new.pack_id) then
      raise exception 'solo un esperto o la redazione possono portare un''affermazione a %', new.status;
    end if;
    if new.status = 'verified' then
      new.verified_by := auth.uid()::text;   -- il vincolo dei quattro occhi impedisce che sia l'autore
      new.verified_at := now();
    end if;
  end if;
  -- Un'affermazione verificata modificata nel contenuto torna in revisione.
  if old.status = 'verified' and new.status = 'verified'
     and (new.type, new.certainty, new.year_from, new.year_to, new.amount, new.subject_id, new.object_id)
         is distinct from (old.type, old.certainty, old.year_from, old.year_to, old.amount, old.subject_id, old.object_id) then
    new.status := 'in_review';
    new.verified_by := null;
    new.verified_at := null;
  end if;
  new.authored_by := old.authored_by;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function editorial_assertion_text_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' and (tg_op = 'INSERT' or new.statement is distinct from old.statement) then
    update assertions set status = 'in_review', verified_by = null, verified_at = null, updated_at = now()
    where id = new.assertion_id and status = 'verified' and not can_verify_pack(pack_id);
    new.reviewed := false;
  end if;
  return new;
end;
$$;

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

create or replace function studio_create_assertion(p_pack text, p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  k packs%rowtype;
  v_texts jsonb := studio_clean_texts(p -> 'texts');
  v_subject uuid;
  v_type text := coalesce(p ->> 'type', 'fact');
  v_id uuid;
  v_slug text;
begin
  perform studio_require(can_edit_pack(p_pack) or can_verify_pack(p_pack), 'non hai i permessi per aggiungere affermazioni a questo territorio');
  select * into k from packs where id = p_pack;
  if coalesce(v_texts ->> k.default_locale, '') = '' then raise exception 'serve il testo nella lingua principale (%)', k.default_locale; end if;
  if v_type not in ('fact', 'interpretation', 'hypothesis', 'tradition', 'legend') then raise exception 'tipo non ammesso: %', v_type; end if;
  if v_type in ('fact', 'interpretation') and coalesce(p ->> 'certainty', '') not in ('established', 'probable', 'uncertain') then
    raise exception 'per un fatto o un''interpretazione indica la certezza';
  end if;
  select id into v_subject from nodes where pack_id = p_pack and slug = p ->> 'subject';
  if v_subject is null then raise exception 'soggetto non trovato nel territorio: %', p ->> 'subject'; end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p -> 'evidence', '[]')) e
             where not exists (select 1 from sources s where s.pack_id = p_pack and s.slug = e ->> 'source')) then
    raise exception 'una delle fonti indicate non esiste nel territorio';
  end if;

  v_slug := studio_free_slug(coalesce(nullif(p ->> 'slug', ''), (select slug from nodes where id = v_subject) || '-' || left(v_texts ->> k.default_locale, 30)),
                             array(select slug from assertions where pack_id = p_pack));
  insert into assertions (pack_id, slug, subject_id, predicate_id, type, certainty, status, authored_by)
  values (p_pack, v_slug, v_subject, 'described_as', v_type::assertion_type,
          case when v_type in ('fact', 'interpretation') then (p ->> 'certainty')::certainty_level end,
          case when coalesce((p ->> 'submit')::boolean, false) then 'in_review' else 'draft' end::assertion_status,
          coalesce(auth.uid()::text, 'studio'))
  returning id into v_id;
  insert into assertion_texts (assertion_id, locale, statement) select v_id, t.key, t.value #>> '{}' from jsonb_each(v_texts) t;
  insert into evidence (assertion_id, source_id, attribution, locator, position)
  select v_id, s.id, 'explicit', nullif(trim(e.value ->> 'locator'), ''), (e.ordinality - 1)::smallint
  from jsonb_array_elements(coalesce(p -> 'evidence', '[]')) with ordinality e
  join sources s on s.pack_id = p_pack and s.slug = e.value ->> 'source';
  return (select x from jsonb_array_elements(studio_assertions(p_pack)) x where x ->> 'slug' = v_slug);
end;
$$;

create or replace function import_pack(p jsonb, p_organization uuid default null)
returns jsonb language plpgsql set search_path = public, extensions as $$
#variable_conflict use_column
declare
  m       jsonb := p -> 'manifest';
  v_pack  text := m ->> 'id';
  v_org   uuid;
  e       jsonb;
  x       jsonb;
  i       int;
  v_node  uuid;
  v_id    uuid;
  v_slugs text[];
begin
  if v_pack is null then raise exception 'istantanea senza manifest.id'; end if;

  -- Organizzazione: quella del pack se esiste già, altrimenti quella indicata, altrimenti la piattaforma.
  select organization_id into v_org from packs where id = v_pack;
  v_org := coalesce(v_org, p_organization,
                    (select id from organizations where kind = 'platform' order by created_at, id limit 1));
  if v_org is null then raise exception 'nessuna organizzazione a cui assegnare il pack %', v_pack; end if;

  insert into packs (id, kind, organization_id, default_locale, quality_tier, fictional, config, version,
                     release_stage, editorial_status, locales, title)
  values (v_pack, (m ->> 'kind')::pack_kind, v_org, m ->> 'defaultLocale', (m ->> 'qualityTier')::quality_tier,
          coalesce((m ->> 'fictional')::boolean, false), coalesce(p -> 'config', '{}'), m ->> 'version',
          coalesce(m ->> 'releaseStage', 'production')::release_stage, m ->> 'editorialStatus',
          pack_text_array(m -> 'locales'), coalesce(m -> 'name', '{}'))
  on conflict (id) do update set
    kind = excluded.kind, default_locale = excluded.default_locale, quality_tier = excluded.quality_tier,
    fictional = excluded.fictional, config = excluded.config, version = excluded.version,
    release_stage = excluded.release_stage, editorial_status = excluded.editorial_status,
    locales = excluded.locales, title = excluded.title, updated_at = now();

  delete from pack_dependencies where pack_id = v_pack;
  insert into pack_dependencies (pack_id, depends_on_id)
  select v_pack, d from unnest(pack_text_array(m -> 'dependsOn')) d;

  if m ->> 'kind' = 'destination' then
    insert into destinations (pack_id) values (v_pack) on conflict (pack_id) do nothing;
  end if;

  -- Nodi (luoghi e nodi della conoscenza): prima tutti, così i riferimenti si risolvono.
  for e in select * from jsonb_array_elements(coalesce(p -> 'places', '[]')) loop
    insert into nodes (pack_id, slug, kind) values (v_pack, e ->> 'id', 'place')
    on conflict (pack_id, slug) do update set kind = excluded.kind, updated_at = now();
  end loop;
  for e in select * from jsonb_array_elements(coalesce(p -> 'nodes', '[]')) loop
    insert into nodes (pack_id, slug, kind, attributes)
    values (v_pack, e ->> 'id', (e ->> 'kind')::node_kind, coalesce(e -> 'attributes', '{}'))
    on conflict (pack_id, slug) do update set kind = excluded.kind, attributes = excluded.attributes, updated_at = now();
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p -> 'places', '[]') || coalesce(p -> 'nodes', '[]')) loop
    v_node := pack_ref_node(v_pack || ':' || (e ->> 'id'));
    delete from node_labels where node_id = v_node;
    insert into node_labels (node_id, locale, name, short_description, aliases)
    select v_node, l.key, l.value ->> 'name', l.value ->> 'short', pack_text_array(l.value -> 'aliases')
    from jsonb_each(coalesce(e -> 'labels', '{}')) l;
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p -> 'places', '[]')) loop
    v_node := pack_ref_node(v_pack || ':' || (e ->> 'id'));
    insert into places (node_id, place_kind, categories, location, elevation_m, importance, dwell_min, accessibility,
                        practical, coordinate_status, coordinate_verified_at, coordinate_verified_by, coordinate_method,
                        coordinate_map_verified_at, coordinate_sources, previous_location, story_status, field_notes,
                        last_verified_at, verified_by, walkable, part_of_node_id)
    values (v_node, (e ->> 'placeKind')::place_kind, pack_text_array(e -> 'categories'), pack_point(e -> 'location'),
            (e ->> 'elevationM')::real, (e ->> 'importance')::smallint, (e ->> 'dwellMin')::smallint,
            coalesce(e -> 'accessibility', '{}'), coalesce(e -> 'practical', '[]'),
            coalesce(e #>> '{coordinates,status}', 'preliminary')::coordinate_status,
            (e #>> '{coordinates,verifiedAt}')::date, e #>> '{coordinates,verifiedBy}', e #>> '{coordinates,method}',
            (e #>> '{coordinates,mapVerifiedAt}')::date, coalesce(e #> '{coordinates,mapSources}', '[]'),
            pack_point(e #> '{coordinates,previousLocation}'),
            e #>> '{curation,storyStatus}', pack_text_array(e #> '{curation,notes}'),
            (e #>> '{curation,lastVerifiedAt}')::date, e #>> '{curation,verifiedBy}',
            coalesce((e ->> 'walkable')::boolean, true),
            case when e ? 'partOf' then pack_ref_node(e ->> 'partOf') end)
    on conflict (node_id) do update set
      place_kind = excluded.place_kind, categories = excluded.categories, location = excluded.location,
      elevation_m = excluded.elevation_m, importance = excluded.importance, dwell_min = excluded.dwell_min,
      accessibility = excluded.accessibility, practical = excluded.practical,
      coordinate_status = excluded.coordinate_status, coordinate_verified_at = excluded.coordinate_verified_at,
      coordinate_verified_by = excluded.coordinate_verified_by, coordinate_method = excluded.coordinate_method,
      coordinate_map_verified_at = excluded.coordinate_map_verified_at, coordinate_sources = excluded.coordinate_sources,
      previous_location = excluded.previous_location, story_status = excluded.story_status,
      field_notes = excluded.field_notes, last_verified_at = excluded.last_verified_at,
      verified_by = excluded.verified_by, walkable = excluded.walkable, part_of_node_id = excluded.part_of_node_id;

    delete from geofences where place_node_id = v_node;
    i := 0;
    for x in select * from jsonb_array_elements(coalesce(e -> 'geofences', '[]')) loop
      insert into geofences (place_node_id, kind, center, radius_m, min_dwell_s, max_accuracy_m, view_bearing_deg,
                             view_tolerance_deg, position)
      values (v_node, (x ->> 'kind')::geofence_kind, pack_point(x -> 'center'), (x ->> 'radiusM')::real,
              coalesce((x ->> 'minDwellS')::smallint, 8), coalesce((x ->> 'maxAccuracyM')::smallint, 35),
              (x ->> 'viewBearingDeg')::smallint, (x ->> 'viewToleranceDeg')::smallint, i);
      i := i + 1;
    end loop;
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p -> 'anchors', '[]')) loop
    insert into anchors (pack_id, slug, kind, location, safety_margin_min, labels)
    values (v_pack, e ->> 'id', (e ->> 'anchorKind')::anchor_kind, pack_point(e -> 'location'),
            (e ->> 'safetyMarginMin')::smallint, coalesce(e -> 'labels', '{}'))
    on conflict (pack_id, slug) do update set kind = excluded.kind, location = excluded.location,
      safety_margin_min = excluded.safety_margin_min, labels = excluded.labels;
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p -> 'sources', '[]')) loop
    insert into sources (pack_id, slug, kind, title, authors, institution, year, language, reliability, url, license,
                         fictional, priority, original_id, accessed_at)
    values (v_pack, e ->> 'id', e ->> 'sourceKind', e ->> 'title', pack_text_array(e -> 'authors'), e ->> 'institution',
            (e ->> 'year')::smallint, e ->> 'language', (e ->> 'reliability')::source_reliability, e ->> 'url',
            e ->> 'license', coalesce((e ->> 'fictional')::boolean, false), e ->> 'priority', e ->> 'originalId',
            (e ->> 'accessedAt')::date)
    on conflict (pack_id, slug) do update set kind = excluded.kind, title = excluded.title, authors = excluded.authors,
      institution = excluded.institution, year = excluded.year, language = excluded.language,
      reliability = excluded.reliability, url = excluded.url, license = excluded.license,
      fictional = excluded.fictional, priority = excluded.priority, original_id = excluded.original_id,
      accessed_at = excluded.accessed_at;
  end loop;

  insert into disputes (pack_id, slug)
  select distinct v_pack, a ->> 'dispute' from jsonb_array_elements(coalesce(p -> 'assertions', '[]')) a
  where a ? 'dispute'
  on conflict (pack_id, slug) do nothing;

  for e in select * from jsonb_array_elements(coalesce(p -> 'assertions', '[]')) loop
    insert into assertions (pack_id, slug, subject_id, predicate_id, object_id, year_from, year_to, circa, amount, unit,
                            type, certainty, status, quality_tier, dispute_id, authored_by, verified_by, original_claim)
    values (v_pack, e ->> 'id', pack_ref_node(e ->> 'subject'), e ->> 'predicate',
            case when e ? 'object' then pack_ref_node(e ->> 'object') end,
            (e #>> '{value,yearFrom}')::smallint, (e #>> '{value,yearTo}')::smallint,
            coalesce((e #>> '{value,circa}')::boolean, false),
            (e #>> '{value,amount}')::numeric, e #>> '{value,unit}',
            (e ->> 'type')::assertion_type, (e ->> 'certainty')::certainty_level, (e ->> 'status')::assertion_status,
            (e ->> 'qualityTier')::quality_tier,
            (select id from disputes where pack_id = v_pack and slug = e ->> 'dispute'),
            e ->> 'authoredBy', e ->> 'verifiedBy', e ->> 'originalClaim')
    on conflict (pack_id, slug) do update set subject_id = excluded.subject_id, predicate_id = excluded.predicate_id,
      object_id = excluded.object_id, year_from = excluded.year_from, year_to = excluded.year_to,
      circa = excluded.circa, amount = excluded.amount, unit = excluded.unit, type = excluded.type,
      certainty = excluded.certainty, status = excluded.status, quality_tier = excluded.quality_tier,
      dispute_id = excluded.dispute_id, authored_by = excluded.authored_by, verified_by = excluded.verified_by,
      original_claim = excluded.original_claim, updated_at = now()
    returning id into v_id;

    delete from assertion_texts where assertion_id = v_id;
    insert into assertion_texts (assertion_id, locale, statement)
    select v_id, t.key, t.value #>> '{}' from jsonb_each(coalesce(e -> 'texts', '{}')) t;

    delete from evidence where assertion_id = v_id;
    insert into evidence (assertion_id, source_id, attribution, locator, excerpt, position)
    select v_id, pack_ref_source(ev.value ->> 'source'), coalesce(ev.value ->> 'attribution', 'explicit')::evidence_attribution,
           ev.value ->> 'locator', ev.value ->> 'excerpt', (ev.ordinality - 1)::smallint
    from jsonb_array_elements(coalesce(e -> 'evidence', '[]')) with ordinality ev;
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p -> 'units', '[]')) loop
    insert into narrative_units (pack_id, slug, anchor_node_id, unit_type, locale, audience, duration_s, text, resume_hook)
    values (v_pack, e ->> 'id', pack_ref_node(e ->> 'anchor'), (e ->> 'unitType')::unit_type, e ->> 'locale',
            coalesce(e ->> 'audience', 'general')::audience_kind, (e ->> 'durationS')::smallint, e ->> 'text',
            e ->> 'resumeHook')
    on conflict (pack_id, slug) do update set anchor_node_id = excluded.anchor_node_id, unit_type = excluded.unit_type,
      locale = excluded.locale, audience = excluded.audience, duration_s = excluded.duration_s, text = excluded.text,
      resume_hook = excluded.resume_hook, updated_at = now()
    returning id into v_id;

    delete from unit_assertions where unit_id = v_id;
    insert into unit_assertions (unit_id, assertion_id, position)
    select v_id, (select id from assertions where pack_id = v_pack and slug = s.value), (s.ordinality - 1)::smallint
    from jsonb_array_elements_text(coalesce(e -> 'assertions', '[]')) with ordinality s;

    delete from unit_concepts where unit_id = v_id;
    insert into unit_concepts (unit_id, concept_node_id, role, position)
    select v_id, pack_ref_node(c.value), 'introduces'::concept_role, (c.ordinality - 1)::smallint
    from jsonb_array_elements_text(coalesce(e -> 'introduces', '[]')) with ordinality c
    union all
    select v_id, pack_ref_node(c.value), 'requires'::concept_role, (c.ordinality - 1)::smallint
    from jsonb_array_elements_text(coalesce(e -> 'requires', '[]')) with ordinality c;

    delete from unit_hooks where unit_id = v_id;
    insert into unit_hooks (unit_id, target_node_id, text, position)
    select v_id, pack_ref_node(h.value ->> 'target'), h.value ->> 'text', (h.ordinality - 1)::smallint
    from jsonb_array_elements(coalesce(e -> 'hooks', '[]')) with ordinality h;
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p -> 'routes', '[]')) loop
    insert into routes (pack_id, slug, duration_min, labels, end_anchor_id, calibration, difficulty, elevation_gain_m, notes)
    values (v_pack, e ->> 'id', (e ->> 'durationMin')::smallint, coalesce(e -> 'labels', '{}'),
            (select id from anchors where pack_id = v_pack and slug = e ->> 'endAnchor'),
            coalesce(e ->> 'calibration', 'draft')::route_calibration, (e ->> 'difficulty')::route_difficulty,
            (e ->> 'elevationGainM')::smallint, pack_text_array(e -> 'notes'))
    on conflict (pack_id, slug) do update set duration_min = excluded.duration_min, labels = excluded.labels,
      end_anchor_id = excluded.end_anchor_id, calibration = excluded.calibration, difficulty = excluded.difficulty,
      elevation_gain_m = excluded.elevation_gain_m, notes = excluded.notes
    returning id into v_id;

    delete from route_stops where route_id = v_id;
    insert into route_stops (route_id, position, place_node_id, dwell_min, optional)
    select v_id, (s.ordinality - 1)::smallint, pack_ref_node(s.value ->> 'place'), (s.value ->> 'dwellMin')::smallint,
           coalesce((s.value ->> 'optional')::boolean, false)
    from jsonb_array_elements(coalesce(e -> 'stops', '[]')) with ordinality s;

    delete from route_sources where route_id = v_id;
    insert into route_sources (route_id, source_id, position)
    select v_id, pack_ref_source(s.value), (s.ordinality - 1)::smallint
    from jsonb_array_elements_text(coalesce(e -> 'sources', '[]')) with ordinality s;
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p -> 'media', '[]')) loop
    insert into media_assets (pack_id, slug, kind, storage_path, sha256, source, author, license, attribution, original_url,
                              license_note, taken_at, location, poster_path, is_cover, mime_type, bytes)
    values (v_pack, e ->> 'id', coalesce(e ->> 'kind', 'image'), v_pack || '/' || (e ->> 'file'), e ->> 'sha256',
            (e ->> 'source')::media_source, e ->> 'author', (e ->> 'license')::media_license, e ->> 'attribution',
            e ->> 'originalUrl', e ->> 'licenseNote', (e ->> 'takenAt')::date, pack_point(e -> 'location'),
            case when e ? 'poster' then v_pack || '/' || (e ->> 'poster') end,
            coalesce((e ->> 'cover')::boolean, false), e ->> 'mimeType', (e ->> 'bytes')::bigint)
    on conflict (pack_id, slug) do update set kind = excluded.kind, storage_path = excluded.storage_path,
      sha256 = excluded.sha256, source = excluded.source, author = excluded.author, license = excluded.license,
      attribution = excluded.attribution, original_url = excluded.original_url, license_note = excluded.license_note,
      taken_at = excluded.taken_at, location = excluded.location, poster_path = excluded.poster_path,
      is_cover = excluded.is_cover, mime_type = excluded.mime_type, bytes = excluded.bytes, updated_at = now()
    returning id into v_id;

    delete from media_labels where media_id = v_id;
    insert into media_labels (media_id, locale, alt, caption)
    select v_id, a.key, a.value #>> '{}', e #>> array['caption', a.key]
    from jsonb_each(coalesce(e -> 'alt', '{}')) a;

    delete from media_subjects where media_id = v_id;
    insert into media_subjects (media_id, node_id, position)
    select v_id, pack_ref_node(s.value), (s.ordinality - 1)::smallint
    from jsonb_array_elements_text(coalesce(e -> 'subjects', '[]')) with ordinality s;
  end loop;

  -- Ciò che non è più nel pack si rimuove (nell'ordine imposto dai riferimenti).
  v_slugs := array(select x ->> 'id' from jsonb_array_elements(coalesce(p -> 'units', '[]')) x);
  delete from narrative_units where pack_id = v_pack and slug <> all (v_slugs);
  v_slugs := array(select x ->> 'id' from jsonb_array_elements(coalesce(p -> 'routes', '[]')) x);
  delete from routes where pack_id = v_pack and slug <> all (v_slugs);
  v_slugs := array(select x ->> 'id' from jsonb_array_elements(coalesce(p -> 'media', '[]')) x);
  delete from media_assets where pack_id = v_pack and slug <> all (v_slugs);
  v_slugs := array(select x ->> 'id' from jsonb_array_elements(coalesce(p -> 'assertions', '[]')) x);
  delete from assertions where pack_id = v_pack and slug <> all (v_slugs);
  delete from disputes d where d.pack_id = v_pack and not exists (select 1 from assertions a where a.dispute_id = d.id);
  v_slugs := array(select x ->> 'id' from jsonb_array_elements(coalesce(p -> 'sources', '[]')) x);
  delete from sources where pack_id = v_pack and slug <> all (v_slugs);
  v_slugs := array(select x ->> 'id' from jsonb_array_elements(coalesce(p -> 'anchors', '[]')) x);
  delete from anchors where pack_id = v_pack and slug <> all (v_slugs);
  v_slugs := array(select x ->> 'id' from jsonb_array_elements(coalesce(p -> 'places', '[]') || coalesce(p -> 'nodes', '[]')) x);
  delete from places where node_id in (select id from nodes where pack_id = v_pack and slug <> all (v_slugs));
  delete from nodes where pack_id = v_pack and slug <> all (v_slugs);
  -- Un nodo che non è più un luogo perde la parte spaziale.
  delete from places pl using nodes n where n.id = pl.node_id and n.pack_id = v_pack and n.kind <> 'place';

  return jsonb_build_object(
    'pack', v_pack,
    'places', (select count(*) from places pl join nodes n on n.id = pl.node_id where n.pack_id = v_pack),
    'nodes', (select count(*) from nodes where pack_id = v_pack and kind <> 'place'),
    'sources', (select count(*) from sources where pack_id = v_pack),
    'assertions', (select count(*) from assertions where pack_id = v_pack),
    'units', (select count(*) from narrative_units where pack_id = v_pack),
    'routes', (select count(*) from routes where pack_id = v_pack),
    'media', (select count(*) from media_assets where pack_id = v_pack));
end;
$$;

create or replace function pack_snapshot(p_pack text)
returns jsonb language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'manifest', jsonb_strip_nulls(jsonb_build_object(
      'schemaVersion', 1,
      'id', pk.id,
      'kind', pk.kind,
      'version', pk.version,
      'name', pk.title,
      'defaultLocale', pk.default_locale,
      'locales', to_jsonb(pk.locales),
      'qualityTier', pk.quality_tier,
      'dependsOn', coalesce((select jsonb_agg(d.depends_on_id order by d.depends_on_id)
                             from pack_dependencies d where d.pack_id = pk.id), '[]'),
      'fictional', pk.fictional,
      'releaseStage', pk.release_stage,
      'editorialStatus', pk.editorial_status)),
    'config', pk.config,
    'places', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', n.slug,
        'placeKind', pl.place_kind,
        'categories', to_jsonb(pl.categories),
        'location', pack_lnglat(pl.location),
        'elevationM', pl.elevation_m,
        'importance', pl.importance,
        'dwellMin', pl.dwell_min,
        'partOf', pack_full_ref(pl.part_of_node_id),
        'labels', pack_node_labels(n.id),
        'geofences', coalesce((
          select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'kind', g.kind, 'radiusM', g.radius_m, 'center', pack_lnglat(g.center),
            'minDwellS', g.min_dwell_s, 'maxAccuracyM', g.max_accuracy_m,
            'viewBearingDeg', g.view_bearing_deg, 'viewToleranceDeg', g.view_tolerance_deg)) order by g.position)
          from geofences g where g.place_node_id = n.id), '[]'),
        'accessibility', nullif(pl.accessibility, '{}'),
        'coordinates', jsonb_strip_nulls(jsonb_build_object(
          'status', pl.coordinate_status,
          'verifiedAt', pl.coordinate_verified_at,
          'verifiedBy', pl.coordinate_verified_by,
          'method', pl.coordinate_method,
          'mapVerifiedAt', pl.coordinate_map_verified_at,
          'mapSources', pl.coordinate_sources,
          'previousLocation', pack_lnglat(pl.previous_location))),
        'curation', case when pl.story_status is not null or cardinality(pl.field_notes) > 0
                              or pl.last_verified_at is not null or pl.verified_by is not null
                         then jsonb_strip_nulls(jsonb_build_object(
                           'storyStatus', pl.story_status, 'notes', to_jsonb(pl.field_notes),
                           'lastVerifiedAt', pl.last_verified_at, 'verifiedBy', pl.verified_by)) end,
        'practical', case when jsonb_typeof(pl.practical) = 'array' then pl.practical else '[]' end,
        'walkable', pl.walkable)) order by n.slug)
      from nodes n join places pl on pl.node_id = n.id where n.pack_id = pk.id), '[]'),
    'anchors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.slug, 'anchorKind', a.kind, 'location', pack_lnglat(a.location),
        'safetyMarginMin', a.safety_margin_min, 'labels', a.labels) order by a.slug)
      from anchors a where a.pack_id = pk.id), '[]'),
    'nodes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.slug, 'kind', n.kind, 'labels', pack_node_labels(n.id), 'attributes', n.attributes) order by n.slug)
      from nodes n where n.pack_id = pk.id and n.kind <> 'place'), '[]'),
    'sources', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', s.slug, 'sourceKind', s.kind, 'title', s.title, 'authors', to_jsonb(s.authors),
        'institution', s.institution, 'year', s.year, 'language', s.language, 'reliability', s.reliability,
        'url', s.url, 'license', s.license, 'priority', s.priority, 'originalId', s.original_id,
        'accessedAt', s.accessed_at, 'fictional', s.fictional)) order by s.slug)
      from sources s where s.pack_id = pk.id), '[]'),
    'assertions', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', a.slug,
        'subject', pack_full_ref(a.subject_id),
        'predicate', a.predicate_id,
        'object', pack_full_ref(a.object_id),
        'value', case when a.year_from is not null
                      then jsonb_strip_nulls(jsonb_build_object('yearFrom', a.year_from, 'yearTo', a.year_to, 'circa', a.circa))
                      when a.amount is not null then jsonb_build_object('amount', a.amount, 'unit', a.unit) end,
        'type', a.type,
        'certainty', a.certainty,
        'status', a.status,
        'qualityTier', a.quality_tier,
        'dispute', (select d.slug from disputes d where d.id = a.dispute_id),
        'texts', coalesce((select jsonb_object_agg(t.locale, t.statement) from assertion_texts t where t.assertion_id = a.id), '{}'),
        'evidence', coalesce((
          select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'source', s.pack_id || ':' || s.slug, 'attribution', ev.attribution,
            'locator', ev.locator, 'excerpt', ev.excerpt)) order by ev.position)
          from evidence ev join sources s on s.id = ev.source_id where ev.assertion_id = a.id), '[]'),
        'authoredBy', a.authored_by,
        'verifiedBy', a.verified_by,
        'originalClaim', a.original_claim)) order by a.slug)
      from assertions a where a.pack_id = pk.id), '[]'),
    'units', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', u.slug,
        'anchor', pack_full_ref(u.anchor_node_id),
        'unitType', u.unit_type,
        'locale', u.locale,
        'audience', u.audience,
        'durationS', u.duration_s,
        'text', u.text,
        'assertions', coalesce((select jsonb_agg(a.slug order by ua.position)
                                from unit_assertions ua join assertions a on a.id = ua.assertion_id
                                where ua.unit_id = u.id), '[]'),
        'introduces', coalesce((select jsonb_agg(pack_full_ref(c.concept_node_id) order by c.position)
                                from unit_concepts c where c.unit_id = u.id and c.role = 'introduces'), '[]'),
        'requires', coalesce((select jsonb_agg(pack_full_ref(c.concept_node_id) order by c.position)
                              from unit_concepts c where c.unit_id = u.id and c.role = 'requires'), '[]'),
        'hooks', coalesce((select jsonb_agg(jsonb_build_object('target', pack_full_ref(h.target_node_id), 'text', h.text)
                                            order by h.position)
                           from unit_hooks h where h.unit_id = u.id), '[]'),
        'resumeHook', u.resume_hook)) order by u.slug)
      from narrative_units u where u.pack_id = pk.id), '[]'),
    'routes', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', r.slug,
        'labels', r.labels,
        'durationMin', r.duration_min,
        'calibration', r.calibration,
        'difficulty', r.difficulty,
        'elevationGainM', r.elevation_gain_m,
        'sources', coalesce((select jsonb_agg(s.pack_id || ':' || s.slug order by rs.position)
                             from route_sources rs join sources s on s.id = rs.source_id where rs.route_id = r.id), '[]'),
        'notes', to_jsonb(r.notes),
        'stops', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                             'place', pack_full_ref(st.place_node_id), 'dwellMin', st.dwell_min, 'optional', st.optional))
                           order by st.position)
                           from route_stops st where st.route_id = r.id), '[]'),
        'endAnchor', (select an.slug from anchors an where an.id = r.end_anchor_id))) order by r.slug)
      from routes r where r.pack_id = pk.id), '[]'),
    'media', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', md.slug,
        'kind', md.kind,
        'file', substr(md.storage_path, length(pk.id) + 2),
        'poster', substr(md.poster_path, length(pk.id) + 2),
        'cover', case when md.is_cover then true end,
        'subjects', coalesce((select jsonb_agg(pack_full_ref(ms.node_id) order by ms.position)
                              from media_subjects ms where ms.media_id = md.id), '[]'),
        'caption', (select jsonb_object_agg(l.locale, l.caption) from media_labels l
                    where l.media_id = md.id and l.caption is not null),
        'alt', coalesce((select jsonb_object_agg(l.locale, l.alt) from media_labels l where l.media_id = md.id), '{}'),
        'source', md.source,
        'author', md.author,
        'license', md.license,
        'attribution', md.attribution,
        'originalUrl', md.original_url,
        'licenseNote', md.license_note,
        'takenAt', md.taken_at,
        'location', pack_lnglat(md.location),
        'sha256', md.sha256)) order by md.slug)
      from media_assets md where md.pack_id = pk.id), '[]'))
  from packs pk where pk.id = p_pack;
$$;

alter table assertions drop constraint assertions_self_verified_consistent;
alter table assertions drop constraint assertions_four_eyes;
alter table assertions add constraint assertions_four_eyes
  check (status <> 'verified' or (verified_by is not null and verified_by <> authored_by));
alter table assertions drop column self_verified;
