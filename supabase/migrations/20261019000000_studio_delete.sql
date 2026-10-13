-- Studio: eliminazione di territori e contenuti (vedi docs/v0.3-platform/TERRITORI-DAL-CMS.md, «Eliminazione»).
--
-- Nessuna tabella nuova. Regole:
-- - prima si chiede il piano (studio_delete_plan): cosa sparisce insieme all'elemento, cosa lo impedisce;
-- - non si lasciano riferimenti rotti: se un altro contenuto usa l'elemento (una tappa, un racconto, una
--   prova), l'eliminazione è bloccata e il piano dice cosa sistemare prima;
-- - ciò che appartiene solo all'elemento sparisce con lui (un luogo porta con sé i suoi racconti, le
--   affermazioni su di lui e le foto che raffigurano solo lui);
-- - prima di eliminare si salva una copia completa del territorio in content_revisions
--   (table_name 'pack_snapshot', formato di import_pack): si può sempre ripristinare;
-- - eliminare un'affermazione verificata richiede chi verifica; un contenuto pubblicato, chi pubblica;
--   un territorio intero, l'amministratore.
-- I file nel bucket media li toglie lo Studio con la sessione dell'utente (policy di Storage): il piano
-- restituisce i percorsi.

-- ---------------------------------------------------------------- copia di sicurezza

create or replace function studio_archive_snapshot(p_pack text, p_what jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  perform studio_require(can_edit_pack(p_pack) or can_verify_pack(p_pack), 'non hai i permessi per modificare questo territorio');
  insert into content_revisions (pack_id, table_name, row_id, operation, actor_id, before, after)
  values (p_pack, 'pack_snapshot', coalesce(p_what ->> 'kind', '?') || ':' || coalesce(p_what ->> 'slug', p_pack),
          'DELETE', auth.uid(), pack_snapshot(p_pack), p_what)
  returning id into v;
  return v;
end;
$$;

-- ---------------------------------------------------------------- piano

-- Gira con i privilegi del proprietario per vedere anche i riferimenti da territori che l'utente non
-- legge (altrimenti il piano direbbe «nessun blocco» e l'eliminazione fallirebbe sul vincolo).
-- Per questo controlla da sé che l'utente sia staff del territorio e non restituisce contenuti altrui
-- oltre all'identificativo.
create or replace function studio_delete_plan(p_pack text, p_kind text, p_slug text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_items jsonb := '[]';
  v_blockers text[] := '{}';
  v_notes text[] := '{}';
  v_files text[] := '{}';
  v_name text;
  v_id uuid;
  v_units uuid[];
  v_asserts uuid[];
  v_media uuid[];
  v_status text;
  r record;
begin
  perform studio_require(is_pack_staff(p_pack), 'territorio non trovato o fuori dai tuoi permessi');
  -- Le affermazioni le eliminano anche gli esperti (come le scrivono); il resto chi modifica il territorio.
  if not (can_edit_pack(p_pack) or (p_kind = 'assertion' and can_verify_pack(p_pack))) then
    v_blockers := v_blockers || 'il tuo ruolo non modifica questo territorio'::text;
  end if;

  if p_kind = 'pack' then
    select coalesce(p.title ->> p.default_locale, p.id) into v_name from packs p where p.id = p_pack;
    if not is_platform_admin() then
      v_blockers := v_blockers || 'un territorio intero lo elimina solo l''amministratore'::text;
    end if;
    for r in select pack_id from pack_dependencies where depends_on_id = p_pack order by pack_id loop
      v_blockers := v_blockers || format('il territorio %s ne fa parte: eliminalo o spostalo prima', r.pack_id);
    end loop;
    select status::text into v_status from destinations where pack_id = p_pack;
    if v_status = 'published' then
      v_blockers := v_blockers || 'è pubblicato: ritira prima la pubblicazione'::text;
    end if;
    if exists (select 1 from publications where pack_id = p_pack and status in ('building', 'published')) then
      v_blockers := v_blockers || 'ha una pubblicazione in corso o in linea'::text;
    end if;
    if exists (select 1 from products where pack_id = p_pack or route_id in (select id from routes where pack_id = p_pack)) then
      v_blockers := v_blockers || 'è legato a prodotti a pagamento'::text;
    end if;
    v_items := jsonb_build_array(
      jsonb_build_object('kind', 'place', 'count', (select count(*) from nodes n join places pl on pl.node_id = n.id where n.pack_id = p_pack)),
      jsonb_build_object('kind', 'source', 'count', (select count(*) from sources where pack_id = p_pack)),
      jsonb_build_object('kind', 'assertion', 'count', (select count(*) from assertions where pack_id = p_pack)),
      jsonb_build_object('kind', 'unit', 'count', (select count(*) from narrative_units where pack_id = p_pack)),
      jsonb_build_object('kind', 'route', 'count', (select count(*) from routes where pack_id = p_pack)),
      jsonb_build_object('kind', 'media', 'count', (select count(*) from media_assets where pack_id = p_pack)));
    v_files := array(select distinct storage_path from media_assets where pack_id = p_pack order by 1);
    if exists (select 1 from memberships where pack_scope = p_pack) then
      v_notes := v_notes || format('%s ruoli limitati a questo territorio vengono tolti (restano nella copia di sicurezza)',
                                   (select count(*) from memberships where pack_scope = p_pack));
    end if;
    v_notes := v_notes || 'se il territorio esiste anche nei file del repository (territories/), lì resta: si elimina solo dal database'::text;

  elsif p_kind = 'place' then
    select n.id, studio_node_name(n.id), n.status::text into v_id, v_name, v_status
    from nodes n join places pl on pl.node_id = n.id where n.pack_id = p_pack and n.slug = p_slug;
    if v_id is null then raise exception 'luogo non trovato: %', p_slug; end if;
    v_units := array(select id from narrative_units where anchor_node_id = v_id and pack_id = p_pack);
    v_asserts := array(select id from assertions where subject_id = v_id and pack_id = p_pack);
    v_media := array(select ms.media_id from media_subjects ms join media_assets m on m.id = ms.media_id
                     where ms.node_id = v_id and m.pack_id = p_pack
                       and not exists (select 1 from media_subjects o where o.media_id = ms.media_id and o.node_id <> v_id));
    if v_status = 'published' and not can_publish_pack(p_pack) then
      v_blockers := v_blockers || 'il luogo è pubblicato: lo elimina chi ha il permesso di pubblicazione'::text;
    end if;
    for r in select distinct ro.pack_id, ro.slug from route_stops s join routes ro on ro.id = s.route_id
             where s.place_node_id = v_id order by 1, 2 loop
      v_blockers := v_blockers || format('è una tappa del percorso %s: toglilo prima dal percorso', studio_ref(p_pack, r.pack_id, r.slug));
    end loop;
    for r in select pack_id, slug from narrative_units where anchor_node_id = v_id and pack_id <> p_pack order by 1, 2 loop
      v_blockers := v_blockers || format('il racconto %s di un altro territorio è ambientato qui', studio_ref(p_pack, r.pack_id, r.slug));
    end loop;
    for r in select pack_id, slug from assertions where (subject_id = v_id and pack_id <> p_pack)
             or (object_id = v_id and id <> all (v_asserts)) order by 1, 2 loop
      v_blockers := v_blockers || format('l''affermazione %s parla di questo luogo', studio_ref(p_pack, r.pack_id, r.slug));
    end loop;
    for r in select distinct u.pack_id, u.slug from unit_assertions ua join narrative_units u on u.id = ua.unit_id
             where ua.assertion_id = any (v_asserts) and u.id <> all (v_units) order by 1, 2 loop
      v_blockers := v_blockers || format('il racconto %s usa affermazioni su questo luogo', studio_ref(p_pack, r.pack_id, r.slug));
    end loop;
    for r in select distinct u.pack_id, u.slug from narrative_units u
             where u.id <> all (v_units)
               and (exists (select 1 from unit_concepts c where c.unit_id = u.id and c.concept_node_id = v_id)
                    or exists (select 1 from unit_hooks h where h.unit_id = u.id and h.target_node_id = v_id)) order by 1, 2 loop
      v_blockers := v_blockers || format('il racconto %s richiama questo luogo', studio_ref(p_pack, r.pack_id, r.slug));
    end loop;
    for r in select n.pack_id, n.slug from places pl join nodes n on n.id = pl.node_id where pl.part_of_node_id = v_id order by 1, 2 loop
      v_blockers := v_blockers || format('il luogo %s ne fa parte', studio_ref(p_pack, r.pack_id, r.slug));
    end loop;
    if exists (select 1 from disputes where preferred_assertion_id = any (v_asserts)) then
      v_blockers := v_blockers || 'un''affermazione su questo luogo è la preferita di una controversia'::text;
    end if;
    if exists (select 1 from assertions where id = any (v_asserts) and status = 'verified') and not can_verify_pack(p_pack) then
      v_blockers := v_blockers || 'ci sono affermazioni verificate su questo luogo: le elimina un esperto o la redazione'::text;
    end if;
    if exists (select 1 from narrative_units where id = any (v_units) and status = 'published') and not can_publish_pack(p_pack) then
      v_blockers := v_blockers || 'ci sono racconti pubblicati in questo luogo: li elimina chi pubblica'::text;
    end if;
    v_items := coalesce((select jsonb_agg(jsonb_build_object('kind', 'unit', 'slug', slug, 'label', slug || ' (' || locale || ')') order by slug)
                         from narrative_units where id = any (v_units)), '[]')
            || coalesce((select jsonb_agg(jsonb_build_object('kind', 'assertion', 'slug', a.slug, 'label', studio_assertion_label(a.id)) order by a.slug)
                         from assertions a where a.id = any (v_asserts)), '[]')
            || coalesce((select jsonb_agg(jsonb_build_object('kind', 'media', 'slug', slug, 'label', slug) order by slug)
                         from media_assets where id = any (v_media)), '[]');
    v_files := studio_orphan_files(v_media);
    if exists (select 1 from media_subjects ms where ms.node_id = v_id and ms.media_id <> all (v_media)) then
      v_notes := v_notes || 'le foto che raffigurano anche altri luoghi restano, senza questo luogo'::text;
    end if;

  elsif p_kind = 'route' then
    select id, coalesce(labels -> 'it' ->> 'name', slug), status::text into v_id, v_name, v_status
    from routes where pack_id = p_pack and slug = p_slug;
    if v_id is null then raise exception 'percorso non trovato: %', p_slug; end if;
    if v_status = 'published' and not can_publish_pack(p_pack) then
      v_blockers := v_blockers || 'il percorso è pubblicato: lo elimina chi ha il permesso di pubblicazione'::text;
    end if;
    if exists (select 1 from products where route_id = v_id) then
      v_blockers := v_blockers || 'il percorso è venduto come prodotto a pagamento'::text;
    end if;
    v_notes := v_notes || format('%s tappe; i luoghi restano', (select count(*) from route_stops where route_id = v_id));

  elsif p_kind = 'source' then
    select id, title into v_id, v_name from sources where pack_id = p_pack and slug = p_slug;
    if v_id is null then raise exception 'fonte non trovata: %', p_slug; end if;
    for r in select distinct a.pack_id, a.slug from evidence e join assertions a on a.id = e.assertion_id
             where e.source_id = v_id order by 1, 2 loop
      v_blockers := v_blockers || format('è la prova dell''affermazione %s', studio_ref(p_pack, r.pack_id, r.slug));
    end loop;
    for r in select distinct ro.pack_id, ro.slug from route_sources rs join routes ro on ro.id = rs.route_id
             where rs.source_id = v_id order by 1, 2 loop
      v_blockers := v_blockers || format('documenta il percorso %s', studio_ref(p_pack, r.pack_id, r.slug));
    end loop;

  elsif p_kind = 'assertion' then
    select id, studio_assertion_label(id), status::text into v_id, v_name, v_status
    from assertions where pack_id = p_pack and slug = p_slug;
    if v_id is null then raise exception 'affermazione non trovata: %', p_slug; end if;
    if v_status = 'verified' and not can_verify_pack(p_pack) then
      v_blockers := v_blockers || 'è verificata: la elimina un esperto o la redazione'::text;
    end if;
    for r in select distinct u.pack_id, u.slug from unit_assertions ua join narrative_units u on u.id = ua.unit_id
             where ua.assertion_id = v_id order by 1, 2 loop
      v_blockers := v_blockers || format('la usa il racconto %s', studio_ref(p_pack, r.pack_id, r.slug));
    end loop;
    if exists (select 1 from disputes where preferred_assertion_id = v_id) then
      v_blockers := v_blockers || 'è la preferita di una controversia'::text;
    end if;

  elsif p_kind = 'unit' then
    select id, slug || ' (' || locale || ')', status::text into v_id, v_name, v_status
    from narrative_units where pack_id = p_pack and slug = p_slug;
    if v_id is null then raise exception 'racconto non trovato: %', p_slug; end if;
    if v_status = 'published' and not can_publish_pack(p_pack) then
      v_blockers := v_blockers || 'il racconto è pubblicato: lo elimina chi ha il permesso di pubblicazione'::text;
    end if;
    v_notes := v_notes || 'le affermazioni su cui si basa restano'::text;

  elsif p_kind = 'media' then
    select id, slug into v_id, v_name from media_assets where pack_id = p_pack and slug = p_slug;
    if v_id is null then raise exception 'foto non trovata: %', p_slug; end if;
    v_files := studio_orphan_files(array[v_id]);
    if exists (select 1 from media_assets where id = v_id and is_cover) then
      v_notes := v_notes || 'è la copertina: il territorio resterà senza copertina finché non ne scegli un''altra'::text;
    end if;

  else
    raise exception 'tipo da eliminare non valido: %', p_kind;
  end if;

  return jsonb_build_object('kind', p_kind, 'pack', p_pack, 'slug', p_slug, 'name', coalesce(v_name, p_slug, p_pack),
    'items', v_items, 'blockers', to_jsonb(v_blockers), 'notes', to_jsonb(v_notes), 'files', to_jsonb(v_files),
    'allowed', cardinality(v_blockers) = 0);
end;
$$;

-- File del bucket che restano senza media dopo aver eliminato quelli indicati (lo stesso file può
-- servire a più media: si toglie solo l'ultimo).
create or replace function studio_orphan_files(p_media uuid[])
returns text[] language sql stable set search_path = public as $$
  select coalesce(array_agg(distinct m.storage_path order by m.storage_path), '{}')
  from media_assets m
  where m.id = any (p_media)
    and not exists (select 1 from media_assets o where o.storage_path = m.storage_path and o.id <> all (p_media));
$$;

-- «slug» se è nello stesso territorio, altrimenti «pack:slug».
create or replace function studio_ref(p_pack text, p_other text, p_slug text)
returns text language sql immutable as $$
  select case when p_other = p_pack then p_slug else p_other || ':' || p_slug end;
$$;

create or replace function studio_assertion_label(p_id uuid)
returns text language sql stable set search_path = public as $$
  select coalesce(left((select statement from assertion_texts where assertion_id = p_id order by locale <> 'it', locale limit 1), 90),
                  (select slug from assertions where id = p_id));
$$;

-- ---------------------------------------------------------------- eliminazione dei contenuti

-- Gira con i privilegi di chi chiama: le policy RLS restano l'ultima parola.
create or replace function studio_delete(p_pack text, p_kind text, p_slug text)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_plan jsonb;
  v_id uuid;
  v_units uuid[];
  v_asserts uuid[];
  v_media uuid[];
  v_n int;
begin
  if p_kind = 'pack' then raise exception 'un territorio intero si elimina con studio_delete_pack'; end if;
  v_plan := studio_delete_plan(p_pack, p_kind, p_slug);
  if not (v_plan ->> 'allowed')::boolean then
    raise exception 'non si può eliminare: %', array_to_string(array(select jsonb_array_elements_text(v_plan -> 'blockers')), '; ')
      using errcode = '42501';
  end if;
  perform studio_archive_snapshot(p_pack, jsonb_build_object('kind', p_kind, 'slug', p_slug, 'name', v_plan ->> 'name'));

  if p_kind = 'place' then
    select n.id into v_id from nodes n join places pl on pl.node_id = n.id where n.pack_id = p_pack and n.slug = p_slug;
    v_units := array(select id from narrative_units where anchor_node_id = v_id and pack_id = p_pack);
    v_asserts := array(select id from assertions where subject_id = v_id and pack_id = p_pack);
    v_media := array(select m.id from media_assets m where m.pack_id = p_pack
                     and exists (select 1 from media_subjects ms where ms.media_id = m.id and ms.node_id = v_id)
                     and not exists (select 1 from media_subjects o where o.media_id = m.id and o.node_id <> v_id));
    delete from media_assets where id = any (v_media);
    delete from media_subjects where node_id = v_id;
    delete from narrative_units where id = any (v_units);
    delete from assertions where id = any (v_asserts);
    delete from nodes where id = v_id;   -- con places, nomi, geofence, tempi di cammino, appartenenze
  elsif p_kind = 'route' then
    delete from routes where pack_id = p_pack and slug = p_slug;
  elsif p_kind = 'source' then
    delete from sources where pack_id = p_pack and slug = p_slug;
  elsif p_kind = 'assertion' then
    delete from assertions where pack_id = p_pack and slug = p_slug;
  elsif p_kind = 'unit' then
    delete from narrative_units where pack_id = p_pack and slug = p_slug;
  elsif p_kind = 'media' then
    delete from media_assets where pack_id = p_pack and slug = p_slug;
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'eliminazione non riuscita: il tuo ruolo non può eliminare questo elemento' using errcode = '42501';
  end if;
  return v_plan;
end;
$$;

-- ---------------------------------------------------------------- eliminazione di un territorio

-- Solo l'amministratore, con l'identificativo riscritto per conferma. Gira con i privilegi del
-- proprietario perché tocca anche righe che nessuna policy fa scrivere al CMS (pubblicazioni,
-- bundle, changeset); i controlli sono qui, espliciti.
create or replace function studio_delete_pack(p_pack text, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_plan jsonb;
begin
  perform studio_require(is_platform_admin(), 'un territorio intero lo elimina solo l''amministratore');
  if p_confirm is distinct from p_pack then
    raise exception 'per confermare scrivi esattamente l''identificativo del territorio (%)', p_pack;
  end if;
  v_plan := studio_delete_plan(p_pack, 'pack');
  if not (v_plan ->> 'allowed')::boolean then
    raise exception 'non si può eliminare: %', array_to_string(array(select jsonb_array_elements_text(v_plan -> 'blockers')), '; ')
      using errcode = '42501';
  end if;
  perform studio_archive_snapshot(p_pack, jsonb_build_object('kind', 'pack', 'slug', p_pack, 'name', v_plan ->> 'name',
    'memberships', (select coalesce(jsonb_agg(jsonb_build_object('userId', user_id, 'organizationId', organization_id, 'role', role)), '[]')
                    from memberships where pack_scope = p_pack)));

  update disputes set preferred_assertion_id = null where pack_id = p_pack;
  delete from media_assets where pack_id = p_pack;
  delete from narrative_units where pack_id = p_pack;
  delete from assertions where pack_id = p_pack;
  delete from disputes where pack_id = p_pack;
  delete from routes where pack_id = p_pack;
  delete from anchors where pack_id = p_pack;
  delete from sources where pack_id = p_pack;
  delete from places where node_id in (select id from nodes where pack_id = p_pack);   -- prima, per «fa parte di»
  delete from nodes where pack_id = p_pack;
  delete from changesets where pack_id = p_pack;
  delete from publications where pack_id = p_pack;
  delete from bundles where pack_id = p_pack;
  delete from destinations where pack_id = p_pack;
  delete from favorites where pack_id = p_pack;
  delete from pack_dependencies where pack_id = p_pack;
  delete from memberships where pack_scope = p_pack;
  delete from packs where id = p_pack;
  return v_plan;
end;
$$;

-- ---------------------------------------------------------------- permessi di esecuzione

do $$
declare f text;
begin
  foreach f in array array[
    'studio_archive_snapshot(text, jsonb)', 'studio_delete_plan(text, text, text)', 'studio_delete(text, text, text)',
    'studio_delete_pack(text, text)', 'studio_ref(text, text, text)', 'studio_assertion_label(uuid)', 'studio_orphan_files(uuid[])'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
