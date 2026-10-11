-- Import ed export dei Territory Pack (milestone 3).
--
-- Il formato di scambio è l'«istantanea» di un pack: lo stesso contenuto dei file YAML
-- (manifest, config, places, anchors, nodes, sources, assertions, units, routes, media) in un
-- unico JSON, con i riferimenti ai nodi sempre completi («pack:slug»). La producono e la leggono
-- `guide-pack db-sql` e `guide-pack db-export` (packages/territory-pack/src/db.ts).
--
--   import_pack(istantanea)  scrive il pack nel database (crea o aggiorna, rimuove ciò che non c'è più)
--   pack_snapshot(pack_id)   rilegge il pack dal database nello stesso formato
--
-- Pack → database → pack deve restituire lo stesso pack e lo stesso bundle: lo prova
-- supabase/tests/roundtrip.ts (npm run db:check). Per questo il database conserva anche l'ordine
-- degli elenchi che contano (geofence, prove, affermazioni e concetti delle unità, richiami,
-- soggetti dei media, fonti dei percorsi) e l'appartenenza di un luogo a un altro (partOf).
--
-- Le due funzioni girano con i privilegi di chi le chiama e sono riservate al servizio
-- (SQL Editor, servizio di pubblicazione): non le può chiamare un utente dell'app.

alter table places add column part_of_node_id uuid references nodes (id);
alter table geofences add column position smallint not null default 0;
alter table evidence add column position smallint not null default 0;
alter table unit_assertions add column position smallint not null default 0;
alter table unit_concepts add column position smallint not null default 0;
alter table unit_hooks add column position smallint not null default 0;
alter table media_subjects add column position smallint not null default 0;
alter table route_sources add column position smallint not null default 0;

-- Il formato dei pack ammette la certezza anche per ipotesi e controversie; resta obbligatoria
-- per fatti e interpretazioni.
do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'assertions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%certainty IS NOT NULL%';
  if c is not null then
    execute format('alter table assertions drop constraint %I', c);
  end if;
end $$;
alter table assertions add constraint assertions_certainty_required
  check (type not in ('fact', 'interpretation') or certainty is not null);

-- Storico: una destinazione senza slug si identifica con il pack (prima la riga non si registrava
-- e l'inserimento falliva).
create or replace function record_revision()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  pack text := coalesce(rec ->> 'pack_id', (
    select n.pack_id from nodes n where n.id = coalesce((rec ->> 'node_id')::uuid, (rec ->> 'place_node_id')::uuid)
  ));
  key text := coalesce(rec ->> 'id', rec ->> 'node_id', rec ->> 'slug', rec ->> 'pack_id');
begin
  if pack is null then
    return coalesce(new, old);
  end if;
  insert into content_revisions (pack_id, table_name, row_id, operation, actor_id, before, after)
  values (pack, tg_table_name, key, tg_op, auth.uid(),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------- funzioni di supporto

create or replace function pack_ref_node(p_ref text)
returns uuid language plpgsql stable set search_path = public as $$
declare v uuid;
begin
  select id into v from nodes where pack_id = split_part(p_ref, ':', 1) and slug = split_part(p_ref, ':', 2);
  if v is null then raise exception 'riferimento a un nodo inesistente: %', p_ref; end if;
  return v;
end;
$$;

create or replace function pack_ref_source(p_ref text)
returns uuid language plpgsql stable set search_path = public as $$
declare v uuid;
begin
  select id into v from sources where pack_id = split_part(p_ref, ':', 1) and slug = split_part(p_ref, ':', 2);
  if v is null then raise exception 'riferimento a una fonte inesistente: %', p_ref; end if;
  return v;
end;
$$;

-- [lng, lat] ↔ geography
create or replace function pack_point(p jsonb)
returns geography language sql immutable set search_path = public, extensions as $$
  select case when p is null or jsonb_typeof(p) <> 'array' then null
              else st_setsrid(st_makepoint((p ->> 0)::float8, (p ->> 1)::float8), 4326)::geography end;
$$;

create or replace function pack_lnglat(g geography)
returns jsonb language sql immutable set search_path = public, extensions as $$
  select case when g is null then null else jsonb_build_array(st_x(g::geometry), st_y(g::geometry)) end;
$$;

create or replace function pack_text_array(p jsonb)
returns text[] language sql immutable as $$
  select coalesce(array(select jsonb_array_elements_text(coalesce(p, '[]'))), '{}');
$$;

create or replace function pack_full_ref(p_node uuid)
returns text language sql stable set search_path = public as $$
  select pack_id || ':' || slug from nodes where id = p_node;
$$;

-- Etichette { "it": { "name", "short", "aliases" } } ↔ node_labels
create or replace function pack_node_labels(p_node uuid)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(l.locale, jsonb_strip_nulls(jsonb_build_object(
           'name', l.name,
           'short', l.short_description,
           'aliases', case when cardinality(l.aliases) > 0 then to_jsonb(l.aliases) end))
         order by l.locale), '{}')
  from node_labels l where l.node_id = p_node;
$$;

-- ---------------------------------------------------------------- import

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

-- ---------------------------------------------------------------- export

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

-- Solo il servizio (e il SQL Editor): gli utenti dell'app passano dallo Studio, con le sue regole.
revoke execute on function import_pack(jsonb, uuid) from public, anon, authenticated;
revoke execute on function pack_snapshot(text) from public, anon, authenticated;
grant execute on function import_pack(jsonb, uuid) to service_role;
grant execute on function pack_snapshot(text) to service_role;
