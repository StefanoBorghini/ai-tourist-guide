-- Studio: territori creati e gestiti dal CMS (vedi docs/v0.3-platform/TERRITORI-DAL-CMS.md).
--
-- Nessuna tabella nuova: packs, pack_dependencies, destinations, publications e le tabelle dei contenuti.
-- Le funzioni girano con i privilegi di chi chiama (RLS e trigger redazionali restano in vigore) e
-- controllano esplicitamente i permessi per dare messaggi chiari.

-- ---------------------------------------------------------------- permessi

-- Un territorio lo crea chi lo potrà modificare: amministratore e redazione ovunque, un editor solo
-- dentro il proprio ambito (can_edit_pack è gerarchico: ambito it.liguria → it.liguria.*).
create policy packs_editor_insert on packs for insert with check (can_edit_pack(id));

-- Le dipendenze di un territorio le decide chi lo modifica, e solo verso territori che può leggere.
create policy pack_dependencies_editor_write on pack_dependencies for all
  using (can_edit_pack(pack_id))
  with check (can_edit_pack(pack_id) and is_pack_staff(depends_on_id));

-- Lo staff rilegge il proprio territorio nel formato dei pack (per il controllo di pubblicazione):
-- la funzione gira con i suoi permessi, quindi vede solo ciò che le policy gli mostrano.
grant execute on function pack_snapshot(text) to authenticated;

-- ---------------------------------------------------------------- supporto

-- «Chiesa di San Pietro» → «chiesa-di-san-pietro»
create or replace function studio_slugify(p text)
returns text language sql immutable as $$
  select coalesce(nullif(trim(both '-' from regexp_replace(
           translate(lower(coalesce(p, '')), 'àáâäãåèéêëìíîïòóôöõùúûüçñ''’', 'aaaaaaeeeeiiiiooooouuuucn--'),
           '[^a-z0-9]+', '-', 'g')), ''), 'elemento');
$$;

-- Primo slug libero: base, base-2, base-3…
create or replace function studio_free_slug(p_base text, p_taken text[])
returns text language plpgsql immutable as $$
declare
  v text := left(studio_slugify(p_base), 60);
  i int := 1;
begin
  v := trim(both '-' from v);
  while v = any (coalesce(p_taken, '{}')) loop
    i := i + 1;
    v := left(studio_slugify(p_base), 55) || '-' || i;
  end loop;
  return v;
end;
$$;

-- Testi per lingua { "it": "…", "en": "…" }: solo lingue attive, senza voci vuote.
create or replace function studio_clean_texts(p jsonb)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(t.key, trim(t.value #>> '{}')), '{}')
  from jsonb_each(coalesce(p, '{}')) t
  where t.key in (select code from locales where enabled) and coalesce(trim(t.value #>> '{}'), '') <> '';
$$;

-- ---------------------------------------------------------------- territori

-- Elenco dello Studio: come prima, con tipologia, stato e permessi di pubblicazione.
create or replace function studio_packs()
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'kind', p.kind,
    'title', p.title,
    'version', p.version,
    'releaseStage', p.release_stage,
    'status', (select d.status from destinations d where d.pack_id = p.id),
    'dependsOn', coalesce((select jsonb_agg(depends_on_id order by depends_on_id) from pack_dependencies where pack_id = p.id), '[]'),
    'places', (select count(*) from nodes n join places pl on pl.node_id = n.id where n.pack_id = p.id),
    'routes', (select count(*) from routes r where r.pack_id = p.id),
    'units', (select count(*) from narrative_units u where u.pack_id = p.id),
    'media', (select count(*) from media_assets m where m.pack_id = p.id),
    'assertions', (select coalesce(jsonb_object_agg(s.status, s.n), '{}')
                   from (select status, count(*) n from assertions a where a.pack_id = p.id group by status) s),
    'canEdit', can_edit_pack(p.id),
    'canVerify', can_verify_pack(p.id),
    'canPublish', can_publish_pack(p.id)) order by p.id), '[]')
  from packs p where is_pack_staff(p.id);
$$;

-- Dove l'utente può creare territori: ovunque (null) o sotto gli ambiti elencati.
create or replace function studio_creation_scopes()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'anywhere', is_platform_admin()
                or exists (select 1 from memberships m where m.user_id = auth.uid() and m.role = 'platform_editor' and m.pack_scope is null),
    'scopes', coalesce((select jsonb_agg(distinct m.pack_scope) from memberships m
                        where m.user_id = auth.uid() and m.role in ('platform_editor', 'territory_editor') and m.pack_scope is not null), '[]'),
    'organizations', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) order by o.name) from organizations o), '[]'),
    'admin', is_platform_admin());
$$;

create or replace function studio_pack(p_pack text)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p.id,
    'kind', p.kind,
    'title', p.title,
    'description', p.description,
    'defaultLocale', p.default_locale,
    'locales', to_jsonb(p.locales),
    'releaseStage', p.release_stage,
    'qualityTier', p.quality_tier,
    'version', p.version,
    'organization', (select jsonb_build_object('id', o.id, 'name', o.name) from organizations o where o.id = p.organization_id),
    'dependsOn', coalesce((select jsonb_agg(depends_on_id order by depends_on_id) from pack_dependencies where pack_id = p.id), '[]'),
    'dependents', coalesce((select jsonb_agg(pack_id order by pack_id) from pack_dependencies where depends_on_id = p.id), '[]'),
    'status', d.status,
    'publishedAt', d.published_at,
    'cover', (select m.slug from media_assets m where m.pack_id = p.id and m.is_cover order by m.slug limit 1),
    'coverCandidates', coalesce((select jsonb_agg(m.slug order by m.slug) from media_assets m where m.pack_id = p.id and m.kind = 'image'), '[]'),
    'publications', coalesce((select jsonb_agg(jsonb_build_object('status', pu.status, 'createdAt', pu.created_at, 'report', pu.report) order by pu.created_at desc)
                              from publications pu where pu.pack_id = p.id), '[]'),
    'counts', jsonb_build_object(
      'places', (select count(*) from nodes n join places pl on pl.node_id = n.id where n.pack_id = p.id),
      'sources', (select count(*) from sources s where s.pack_id = p.id),
      'assertions', (select count(*) from assertions a where a.pack_id = p.id),
      'units', (select count(*) from narrative_units u where u.pack_id = p.id),
      'routes', (select count(*) from routes r where r.pack_id = p.id),
      'media', (select count(*) from media_assets m where m.pack_id = p.id)),
    'canEdit', can_edit_pack(p.id),
    'canPublish', can_publish_pack(p.id))
  from packs p left join destinations d on d.pack_id = p.id
  where p.id = p_pack;
$$;

-- Le dipendenze non devono creare cicli né puntare a territori inesistenti o non leggibili.
create or replace function studio_check_dependencies(p_pack text, p_deps jsonb)
returns void language plpgsql stable set search_path = public as $$
declare d text;
begin
  for d in select jsonb_array_elements_text(coalesce(p_deps, '[]')) loop
    if d = p_pack then raise exception 'un territorio non può dipendere da sé stesso'; end if;
    if not is_pack_staff(d) then raise exception 'non puoi collegare il territorio % (non esiste o non rientra nei tuoi permessi)', d using errcode = '42501'; end if;
    if not exists (select 1 from packs where id = d) then raise exception 'territorio da cui dipendere non trovato: %', d; end if;
    if exists (
      with recursive up(id) as (
        select d union select pd.depends_on_id from pack_dependencies pd join up on pd.pack_id = up.id
      ) select 1 from up where id = p_pack
    ) then
      raise exception 'dipendenza circolare: % dipende già da %', d, p_pack;
    end if;
  end loop;
end;
$$;

-- p: { id, kind, title {it,en}, description {it,en}, defaultLocale, locales [], releaseStage, dependsOn [], organizationId }
create or replace function studio_create_pack(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_id text := trim(coalesce(p ->> 'id', ''));
  v_kind text := coalesce(p ->> 'kind', 'destination');
  v_default text := coalesce(p ->> 'defaultLocale', 'it');
  v_locales text[] := coalesce(array(select distinct jsonb_array_elements_text(p -> 'locales')), array[v_default]);
  v_title jsonb := studio_clean_texts(p -> 'title');
  v_org uuid;
begin
  if v_id !~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$' then
    raise exception 'identificativo non valido: minuscole, cifre e trattini, livelli separati da punti (es. it.liguria.sp.lerici)';
  end if;
  perform studio_require(can_edit_pack(v_id),
    format('non puoi creare il territorio %s: è fuori dai territori che ti sono assegnati', v_id));
  if exists (select 1 from packs where id = v_id) then raise exception 'esiste già un territorio con identificativo %', v_id; end if;
  if v_kind not in ('region', 'area', 'destination') and not (v_kind = 'core' and is_platform_admin()) then
    raise exception 'tipologia non ammessa: %', v_kind;
  end if;
  if not v_default = any (v_locales) then v_locales := array_prepend(v_default, v_locales); end if;
  if exists (select 1 from unnest(v_locales) l where l not in (select code from locales where enabled)) then
    raise exception 'lingue ammesse: %', (select string_agg(code, ', ') from locales where enabled);
  end if;
  if coalesce(v_title ->> v_default, '') = '' then raise exception 'serve il nome nella lingua principale (%)', v_default; end if;
  perform studio_check_dependencies(v_id, p -> 'dependsOn');

  -- Organizzazione: scelta dall'amministratore; altrimenti quella del ruolo che autorizza la creazione
  -- (l'ambito più specifico), altrimenti quella del territorio da cui dipende.
  if is_platform_admin() and p ? 'organizationId' and nullif(p ->> 'organizationId', '') is not null then
    v_org := (p ->> 'organizationId')::uuid;
  end if;
  v_org := coalesce(v_org,
    (select m.organization_id from memberships m
     where m.user_id = auth.uid() and m.role in ('platform_admin', 'platform_editor', 'territory_editor')
       and (m.pack_scope is null or v_id = m.pack_scope or v_id like m.pack_scope || '.%')
     order by length(coalesce(m.pack_scope, '')) desc limit 1),
    (select pk.organization_id from packs pk where pk.id = (select jsonb_array_elements_text(p -> 'dependsOn') limit 1)));
  if v_org is null then raise exception 'nessuna organizzazione a cui assegnare il territorio'; end if;

  insert into packs (id, kind, organization_id, default_locale, locales, title, description, release_stage, quality_tier, version, config)
  values (v_id, v_kind::pack_kind, v_org, v_default, v_locales, v_title, studio_clean_texts(p -> 'description'),
          coalesce(p ->> 'releaseStage', 'research')::release_stage, 'silver', '0.1.0', '{}');
  insert into pack_dependencies (pack_id, depends_on_id)
  select v_id, d from jsonb_array_elements_text(coalesce(p -> 'dependsOn', '[]')) d;
  if v_kind = 'destination' then
    insert into destinations (pack_id, status) values (v_id, 'draft');
  end if;
  return studio_pack(v_id);
end;
$$;

-- Metadati modificabili: title, description, defaultLocale, locales, releaseStage, dependsOn, cover (slug o null).
-- Identificativo e tipologia non cambiano (vedi il documento dei limiti).
create or replace function studio_update_pack(p_pack text, p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  k record;
  v_default text;
  v_locales text[];
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per modificare questo territorio');
  select * into k from packs where id = p_pack;
  if k.id is null then raise exception 'territorio non trovato: %', p_pack; end if;
  if p ? 'id' and p ->> 'id' <> p_pack then raise exception 'l''identificativo di un territorio non si cambia'; end if;
  if p ? 'kind' and p ->> 'kind' <> k.kind::text then raise exception 'la tipologia di un territorio non si cambia'; end if;

  v_default := coalesce(p ->> 'defaultLocale', k.default_locale);
  v_locales := case when p ? 'locales' then array(select distinct jsonb_array_elements_text(p -> 'locales')) else k.locales end;
  if not v_default = any (v_locales) then v_locales := array_prepend(v_default, v_locales); end if;
  if exists (select 1 from unnest(v_locales) l where l not in (select code from locales where enabled)) then
    raise exception 'lingue ammesse: %', (select string_agg(code, ', ') from locales where enabled);
  end if;
  if p ? 'title' and coalesce(studio_clean_texts(p -> 'title') ->> v_default, '') = '' then
    raise exception 'serve il nome nella lingua principale (%)', v_default;
  end if;
  if p ? 'releaseStage' and p ->> 'releaseStage' = 'production' and k.release_stage <> 'production' and not can_publish_pack(p_pack) then
    raise exception 'solo chi pubblica può portare un territorio in produzione' using errcode = '42501';
  end if;

  update packs set
    title = case when p ? 'title' then studio_clean_texts(p -> 'title') else title end,
    description = case when p ? 'description' then studio_clean_texts(p -> 'description') else description end,
    default_locale = v_default,
    locales = v_locales,
    release_stage = coalesce((p ->> 'releaseStage')::release_stage, release_stage),
    updated_at = now()
  where id = p_pack;

  if p ? 'dependsOn' then
    perform studio_check_dependencies(p_pack, p -> 'dependsOn');
    delete from pack_dependencies where pack_id = p_pack
      and depends_on_id not in (select jsonb_array_elements_text(p -> 'dependsOn'));
    insert into pack_dependencies (pack_id, depends_on_id)
    select p_pack, d from jsonb_array_elements_text(p -> 'dependsOn') d
    on conflict do nothing;
  end if;

  if p ? 'cover' then
    if k.kind <> 'destination' then raise exception 'la copertina è solo delle destinazioni'; end if;
    if jsonb_typeof(p -> 'cover') = 'string' and not exists (
         select 1 from media_assets where pack_id = p_pack and slug = p ->> 'cover' and kind = 'image') then
      raise exception 'immagine di copertina non trovata: %', p ->> 'cover';
    end if;
    update media_assets set is_cover = (slug = p ->> 'cover') where pack_id = p_pack and is_cover is distinct from (slug = p ->> 'cover');
    update destinations set cover_media_id = (select id from media_assets where pack_id = p_pack and slug = p ->> 'cover'), updated_at = now()
    where pack_id = p_pack;
  end if;
  return studio_pack(p_pack);
end;
$$;

-- Controllo minimo di pubblicazione nel database (il controllo completo è il validatore dei pack,
-- sul server dello Studio e di nuovo nella pipeline di pubblicazione). Restituisce i problemi.
create or replace function studio_publish_blockers(p_pack text)
returns text[] language sql stable set search_path = public as $$
  with k as (select * from packs where id = p_pack)
  select array_remove(array[
    case when (select coalesce(title ->> default_locale, '') from k) = '' then 'manca il nome nella lingua principale' end,
    case when not exists (select 1 from nodes n join places pl on pl.node_id = n.id where n.pack_id = p_pack)
         then 'nessun luogo' end,
    case when not exists (
           select 1 from narrative_units u, k
           where u.pack_id = p_pack and u.locale = k.default_locale
             and exists (select 1 from unit_assertions ua where ua.unit_id = u.id)
             and not exists (select 1 from unit_assertions ua join assertions a on a.id = ua.assertion_id
                             where ua.unit_id = u.id
                               and not (a.status = 'verified' or (a.status = 'in_review' and k.release_stage <> 'production'))))
         then 'nessun racconto nella lingua principale con affermazioni raccontabili' end
  ], null);
$$;

-- Stati: draft → in_review → published (approvato per la pubblicazione); in_review → draft;
-- published → in_review (ritiro). Pubblicare registra la richiesta in publications con l'esito del controllo.
create or replace function studio_set_pack_status(p_pack text, p_status text, p_report jsonb default null)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_old publish_status;
  v_blockers text[];
begin
  select status into v_old from destinations where pack_id = p_pack;
  if v_old is null then
    if not exists (select 1 from packs where id = p_pack) then raise exception 'territorio non trovato: %', p_pack; end if;
    raise exception 'solo le destinazioni hanno uno stato di pubblicazione: le regioni e le aree sono contenitori';
  end if;
  if p_status = v_old::text then return studio_pack(p_pack); end if;

  if p_status = 'in_review' and v_old = 'draft' then
    perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per mandare in revisione questo territorio');
  elsif p_status = 'draft' and v_old = 'in_review' then
    perform studio_require(can_edit_pack(p_pack), 'non hai i permessi su questo territorio');
  elsif p_status = 'published' and v_old = 'in_review' then
    perform studio_require(can_publish_pack(p_pack), 'non hai i permessi per pubblicare questo territorio');
    v_blockers := studio_publish_blockers(p_pack);
    if cardinality(v_blockers) > 0 then
      raise exception 'non si può pubblicare: %', array_to_string(v_blockers, '; ');
    end if;
    if p_report is null or coalesce((p_report ->> 'ok')::boolean, false) is not true then
      raise exception 'manca un controllo di pubblicazione superato: eseguilo dallo Studio';
    end if;
  elsif p_status = 'in_review' and v_old = 'published' then
    perform studio_require(can_publish_pack(p_pack), 'non hai i permessi per ritirare la pubblicazione');
  else
    raise exception 'passaggio di stato non ammesso: % → %', v_old, p_status;
  end if;

  update destinations set
    status = p_status::publish_status,
    published_at = case when p_status = 'published' then now() else published_at end,
    published_by = case when p_status = 'published' then auth.uid() else published_by end,
    updated_at = now()
  where pack_id = p_pack;
  if p_status = 'published' then
    insert into publications (pack_id, requested_by, status, report, note)
    values (p_pack, auth.uid(), 'requested', p_report, 'richiesta dallo Studio');
  end if;
  return studio_pack(p_pack);
end;
$$;

-- ---------------------------------------------------------------- nuovi contenuti

-- Luogo: { name {it,en}, short {it,en}, placeKind, categories [], location [lng,lat], coordinateMethod,
--          importance, dwellMin, radiusM }
create or replace function studio_create_place(p_pack text, p jsonb)
returns jsonb language plpgsql set search_path = public, extensions as $$
declare
  k packs%rowtype;
  v_name jsonb := studio_clean_texts(p -> 'name');
  v_slug text;
  v_node uuid;
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per aggiungere luoghi a questo territorio');
  select * into k from packs where id = p_pack;
  if k.id is null then raise exception 'territorio non trovato: %', p_pack; end if;
  if coalesce(v_name ->> k.default_locale, '') = '' then raise exception 'serve il nome nella lingua principale (%)', k.default_locale; end if;
  if jsonb_typeof(p -> 'location') <> 'array' or (p #>> '{location,0}')::float8 not between -180 and 180
     or (p #>> '{location,1}')::float8 not between -90 and 90 then
    raise exception 'coordinate mancanti o fuori dai limiti';
  end if;
  if coalesce(trim(p ->> 'coordinateMethod'), '') = '' then raise exception 'indica come hai ottenuto le coordinate'; end if;
  if coalesce((p ->> 'importance')::int, 3) not between 1 and 5 then raise exception 'importanza tra 1 e 5'; end if;
  if coalesce((p ->> 'dwellMin')::int, 10) not between 1 and 240 then raise exception 'sosta tra 1 e 240 minuti'; end if;
  if coalesce((p ->> 'radiusM')::int, 40) not between 5 and 2000 then raise exception 'raggio tra 5 e 2000 metri'; end if;

  v_slug := studio_free_slug(coalesce(nullif(p ->> 'slug', ''), v_name ->> k.default_locale),
                             array(select slug from nodes where pack_id = p_pack));
  insert into nodes (pack_id, slug, kind) values (p_pack, v_slug, 'place') returning id into v_node;
  insert into node_labels (node_id, locale, name, short_description)
  select v_node, n.key, n.value #>> '{}', nullif(trim(p #>> array['short', n.key]), '')
  from jsonb_each(v_name) n;
  insert into places (node_id, place_kind, categories, location, importance, dwell_min, practical,
                      coordinate_status, coordinate_method)
  values (v_node, coalesce(p ->> 'placeKind', 'poi')::place_kind,
          coalesce(nullif(array(select studio_slugify(c) from jsonb_array_elements_text(p -> 'categories') c), '{}'), array['luogo']),
          pack_point(p -> 'location'), coalesce((p ->> 'importance')::smallint, 3), coalesce((p ->> 'dwellMin')::smallint, 10),
          '[]', 'preliminary', trim(p ->> 'coordinateMethod'));
  insert into geofences (place_node_id, kind, radius_m, position)
  values (v_node, 'arrival', coalesce((p ->> 'radiusM')::real, 40), 0);
  return studio_place(p_pack, v_slug);
end;
$$;

-- Fonte: { title, sourceKind, authors [], institution, year, url, reliability, language }
create or replace function studio_create_source(p_pack text, p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_slug text;
begin
  perform studio_require(can_edit_pack(p_pack) or can_verify_pack(p_pack), 'non hai i permessi per aggiungere fonti a questo territorio');
  if coalesce(trim(p ->> 'title'), '') = '' then raise exception 'serve il titolo della fonte'; end if;
  if coalesce(p ->> 'reliability', '') not in ('A', 'B', 'C', 'D') then raise exception 'affidabilità tra A e D'; end if;
  if nullif(trim(p ->> 'url'), '') is not null and p ->> 'url' !~ '^https?://' then raise exception 'indirizzo non valido'; end if;
  v_slug := studio_free_slug(p ->> 'title', array(select slug from sources where pack_id = p_pack));
  insert into sources (pack_id, slug, kind, title, authors, institution, year, language, reliability, url, accessed_at)
  values (p_pack, v_slug, coalesce(nullif(p ->> 'sourceKind', ''), 'other'), trim(p ->> 'title'),
          array(select trim(a) from jsonb_array_elements_text(coalesce(p -> 'authors', '[]')) a where trim(a) <> ''),
          nullif(trim(p ->> 'institution'), ''), nullif(p ->> 'year', '')::smallint, nullif(p ->> 'language', ''),
          (p ->> 'reliability')::source_reliability, nullif(trim(p ->> 'url'), ''),
          case when nullif(trim(p ->> 'url'), '') is not null then current_date end);
  return (select jsonb_build_object('slug', s.slug, 'title', s.title) from sources s where s.pack_id = p_pack and s.slug = v_slug);
end;
$$;

create or replace function studio_sources(p_pack text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', s.slug, 'title', s.title, 'kind', s.kind, 'authors', to_jsonb(s.authors), 'institution', s.institution,
    'year', s.year, 'url', s.url, 'reliability', s.reliability,
    'uses', (select count(*) from evidence e where e.source_id = s.id)) order by s.title), '[]')
  from sources s where s.pack_id = p_pack;
$$;

-- Affermazione: { subject (slug di un luogo o nodo), type, certainty, texts {it,en},
--                 evidence [{ source (slug), locator }], submit (true = subito in revisione) }
-- Nasce in bozza (o in revisione); l'autore è l'utente (lo impone il trigger redazionale).
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

-- Racconto (unità narrativa): { anchor (slug del luogo), unitType, locale, durationS, text, assertions [slug] }
create or replace function studio_create_unit(p_pack text, p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  k packs%rowtype;
  v_anchor uuid;
  v_id uuid;
  v_slug text;
  v_locale text;
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per aggiungere racconti a questo territorio');
  select * into k from packs where id = p_pack;
  v_locale := coalesce(nullif(p ->> 'locale', ''), k.default_locale);
  if not v_locale = any (k.locales) then raise exception 'la lingua % non è tra quelle del territorio', v_locale; end if;
  select id into v_anchor from nodes where pack_id = p_pack and slug = p ->> 'anchor';
  if v_anchor is null then raise exception 'luogo del racconto non trovato: %', p ->> 'anchor'; end if;
  if coalesce(trim(p ->> 'text'), '') = '' then raise exception 'il racconto è vuoto'; end if;
  if coalesce((p ->> 'durationS')::int, 30) not between 5 and 120 then raise exception 'durata tra 5 e 120 secondi'; end if;
  if coalesce(jsonb_array_length(p -> 'assertions'), 0) = 0 then
    raise exception 'collega almeno un''affermazione: la guida racconta solo fatti con fonte';
  end if;
  if exists (select 1 from jsonb_array_elements_text(p -> 'assertions') a
             where not exists (select 1 from assertions x where x.pack_id = p_pack and x.slug = a)) then
    raise exception 'una delle affermazioni indicate non esiste nel territorio';
  end if;

  v_slug := studio_free_slug((select slug from nodes where id = v_anchor) || '-' || coalesce(p ->> 'unitType', 'context') || '-' || v_locale,
                             array(select slug from narrative_units where pack_id = p_pack));
  insert into narrative_units (pack_id, slug, anchor_node_id, unit_type, locale, duration_s, text, origin)
  values (p_pack, v_slug, v_anchor, coalesce(p ->> 'unitType', 'context')::unit_type, v_locale,
          coalesce((p ->> 'durationS')::smallint, 30), trim(p ->> 'text'), 'human')
  returning id into v_id;
  insert into unit_assertions (unit_id, assertion_id, position)
  select v_id, x.id, (a.ordinality - 1)::smallint
  from jsonb_array_elements_text(p -> 'assertions') with ordinality a
  join assertions x on x.pack_id = p_pack and x.slug = a.value;
  return (select x from jsonb_array_elements(studio_units(p_pack)) x where x ->> 'slug' = v_slug);
end;
$$;

create or replace function studio_units(p_pack text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', u.slug,
    'anchor', studio_node_name(u.anchor_node_id),
    'unitType', u.unit_type,
    'locale', u.locale,
    'durationS', u.duration_s,
    'text', u.text,
    'assertions', coalesce((select jsonb_agg(jsonb_build_object('slug', a.slug, 'status', a.status) order by ua.position)
                            from unit_assertions ua join assertions a on a.id = ua.assertion_id where ua.unit_id = u.id), '[]'))
    order by studio_node_name(u.anchor_node_id), u.locale, u.slug), '[]')
  from narrative_units u where u.pack_id = p_pack;
$$;

-- Percorso: { name {it,en}, durationMin, stops [{ place, dwellMin, optional }] }
create or replace function studio_create_route(p_pack text, p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  k packs%rowtype;
  v_name jsonb := studio_clean_texts(p -> 'name');
  v_slug text;
begin
  perform studio_require(can_edit_pack(p_pack), 'non hai i permessi per aggiungere percorsi a questo territorio');
  select * into k from packs where id = p_pack;
  if coalesce(v_name ->> k.default_locale, '') = '' then raise exception 'serve il nome nella lingua principale (%)', k.default_locale; end if;
  if coalesce((p ->> 'durationMin')::int, 0) not between 5 and 600 then raise exception 'durata tra 5 e 600 minuti'; end if;
  v_slug := studio_free_slug(v_name ->> k.default_locale, array(select slug from routes where pack_id = p_pack));
  insert into routes (pack_id, slug, duration_min, labels, calibration)
  select p_pack, v_slug, (p ->> 'durationMin')::smallint,
         coalesce(jsonb_object_agg(n.key, jsonb_build_object('name', n.value #>> '{}')), '{}'), 'draft'
  from jsonb_each(v_name) n;
  return studio_set_route_stops(p_pack, v_slug, coalesce(p -> 'stops', '[]'));
end;
$$;

-- ---------------------------------------------------------------- permessi di esecuzione

do $$
declare f text;
begin
  foreach f in array array[
    'studio_creation_scopes()', 'studio_pack(text)', 'studio_create_pack(jsonb)', 'studio_update_pack(text, jsonb)',
    'studio_publish_blockers(text)', 'studio_set_pack_status(text, text, jsonb)', 'studio_create_place(text, jsonb)',
    'studio_create_source(text, jsonb)', 'studio_sources(text)', 'studio_create_assertion(text, jsonb)',
    'studio_create_unit(text, jsonb)', 'studio_units(text)', 'studio_create_route(text, jsonb)', 'studio_packs()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
