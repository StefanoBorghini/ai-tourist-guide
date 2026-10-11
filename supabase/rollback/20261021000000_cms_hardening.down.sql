-- Revoca di 20261021000000_cms_hardening.sql: tornano le regole precedenti (permessi per territorio senza
-- organizzazione). I dati non cambiano.
drop trigger if exists memberships_guard_trg on memberships;
drop trigger if exists packs_guard_trg on packs;
drop trigger if exists places_guard_trg on places;
drop trigger if exists destinations_guard_trg on destinations;
drop trigger if exists editorial_delete_guard_assertions on assertions;
drop trigger if exists editorial_delete_guard_units on narrative_units;
drop trigger if exists editorial_delete_guard_routes on routes;
drop trigger if exists editorial_delete_guard_nodes on nodes;
drop trigger if exists editorial_evidence_guard_trg on evidence;
drop trigger if exists pack_dependencies_guard_trg on pack_dependencies;
drop trigger if exists media_assets_guard_trg on media_assets;
do $$
declare t text;
begin
  foreach t in array array['assertions', 'narrative_units', 'unit_assertions', 'evidence', 'route_stops', 'media_subjects',
                           'places', 'territory_memberships', 'walk_edges', 'disputes'] loop
    execute format('drop trigger if exists %I on %I', t || '_references_guard', t);
  end loop;
end $$;

drop policy if exists packs_editor_insert on packs;
create policy packs_editor_insert on packs for insert with check (can_edit_pack(id));
drop policy if exists packs_editor_update on packs;
create policy packs_editor_update on packs for update using (can_edit_pack(id)) with check (can_edit_pack(id));
drop policy if exists publications_request on publications;
create policy publications_request on publications for insert
  with check (requested_by = auth.uid() and status = 'requested' and can_publish_pack(pack_id));

drop policy if exists bundles_files_publisher_insert on storage.objects;
drop policy if exists bundles_files_publisher_update on storage.objects;
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
drop policy if exists media_files_editor_insert on storage.objects;
create policy media_files_editor_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.can_edit_pack((storage.foldername(name))[1]));
update storage.buckets set file_size_limit = null, allowed_mime_types = null where id = 'bundles';

alter view node_refs reset (security_invoker);
grant select on node_refs to anon;

create or replace function has_role(p_roles member_role[], p_pack text default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.user_id = auth.uid()
      and m.role = any (p_roles)
      and (m.pack_scope is null or p_pack is null
           or p_pack = m.pack_scope or p_pack like m.pack_scope || '.%')
  );
$$;

create or replace function is_platform_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m where m.user_id = auth.uid() and m.role = 'platform_admin');
$$;

create or replace function studio_can_publish_any()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m where m.user_id = auth.uid()
                 and m.role in ('platform_admin', 'platform_editor', 'territory_editor'));
$$;

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

  -- Dentro un territorio fittizio (di prova) si crea solo un territorio fittizio: un territorio reale non
  -- può dipendere da contenuti inventati (lo stesso controllo del validatore, FICTIONAL_DEPENDENCY).
  insert into packs (id, kind, organization_id, default_locale, locales, title, description, release_stage, quality_tier, version, config, fictional)
  values (v_id, v_kind::pack_kind, v_org, v_default, v_locales, v_title, studio_clean_texts(p -> 'description'),
          coalesce(p ->> 'releaseStage', 'research')::release_stage, 'silver', '0.1.0', '{}',
          exists (select 1 from packs d where d.fictional and d.id in (select jsonb_array_elements_text(coalesce(p -> 'dependsOn', '[]')))));
  insert into pack_dependencies (pack_id, depends_on_id)
  select v_id, d from jsonb_array_elements_text(coalesce(p -> 'dependsOn', '[]')) d;
  if v_kind = 'destination' then
    insert into destinations (pack_id, status) values (v_id, 'draft');
  end if;
  return studio_pack(v_id);
end;
$$;

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

drop function if exists bundle_object_name_ok(text);
drop function if exists media_assets_guard();
drop function if exists pack_dependencies_guard();
drop function if exists references_guard();
drop function if exists pack_of(text, uuid);
drop function if exists media_file_exists(text);
drop function if exists pack_reaches(text, text);
drop function if exists editorial_evidence_guard();
drop function if exists editorial_delete_guard();
drop function if exists destinations_guard();
drop function if exists places_guard();
drop function if exists packs_guard();
drop function if exists memberships_guard();
drop function if exists can_edit_pack_in(text, uuid);
drop function if exists has_role_in(member_role[], text, uuid);
