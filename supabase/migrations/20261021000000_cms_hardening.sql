-- CMS: hardening dei permessi (vedi docs/v0.3-platform/CMS-SECURITY-HARDENING.md).
--
-- Risolve le criticità P1–P8 di CMS-AUDIT-REPORT.md e la vista node_refs leggibile da chiunque:
-- 1. i permessi tengono conto dell'organizzazione: l'ambito nullo e i ruoli di piattaforma valgono per tutti i
--    territori solo nell'organizzazione di tipo «platform» (lo staff interno); un ruolo in un'organizzazione cliente
--    vale solo per i territori di quell'organizzazione, e un ambito gerarchico non attraversa le organizzazioni;
-- 2. le regole editoriali sono nel database (trigger), non solo nelle funzioni dello Studio: valgono anche per le
--    scritture dirette via REST con la sessione dell'utente;
-- 3. il bucket pubblico «bundles» accetta solo i file dei bundle (tipi, dimensioni e percorsi ammessi);
-- 4. riferimenti tra contenuti solo dentro il territorio e i territori da cui dipende.
-- Le importazioni (import_pack, ruolo di servizio, SQL Editor) non passano dai controlli per «authenticated».
-- Nessuna tabella nuova. Revoca in supabase/rollback/.

-- ---------------------------------------------------------------- 0. prerequisiti sui dati esistenti

-- Si ferma, senza cambiare nulla, se i ruoli esistenti diventerebbero incoerenti con le nuove regole.
do $$
declare v text;
begin
  select string_agg(format('%s (%s) in «%s»', m.user_id, m.role, o.name), '; ') into v
  from memberships m join organizations o on o.id = m.organization_id
  where m.role in ('platform_admin', 'platform_editor') and o.kind <> 'platform';
  if v is not null then
    raise exception 'HARDENING: ruoli di piattaforma in organizzazioni non di tipo platform: %. Spostali nell''organizzazione della piattaforma (o imposta kind = ''platform'' se è quella) e riesegui.', v;
  end if;
  select string_agg(format('%s → %s', m.user_id, m.pack_scope), '; ') into v
  from memberships m join organizations o on o.id = m.organization_id join packs p on p.id = m.pack_scope
  where o.kind <> 'platform' and p.organization_id <> m.organization_id;
  if v is not null then
    raise exception 'HARDENING: ruoli con ambito su territori di un''altra organizzazione: %. Correggili e riesegui.', v;
  end if;
end $$;

-- ---------------------------------------------------------------- 1. permessi per organizzazione

-- Ruolo valido per un territorio di una data organizzazione (anche un territorio non ancora creato).
create or replace function has_role_in(p_roles member_role[], p_pack text, p_org uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid()
      and m.role = any (p_roles)
      and (
        -- Staff della piattaforma: l'ambito vale come sempre (nullo = tutti i territori).
        (o.kind = 'platform' and (m.pack_scope is null or p_pack is null
                                  or p_pack = m.pack_scope or p_pack like m.pack_scope || '.%'))
        or
        -- Organizzazioni clienti: solo i territori dell'organizzazione (ambito nullo = tutti i suoi territori).
        (o.kind <> 'platform' and (p_pack is null or (
           p_org = m.organization_id
           and (m.pack_scope is null or p_pack = m.pack_scope or p_pack like m.pack_scope || '.%'))))
      ));
$$;

create or replace function has_role(p_roles member_role[], p_pack text default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select has_role_in(p_roles, p_pack, (select organization_id from packs where id = p_pack));
$$;

-- L'amministratore è tale solo nell'organizzazione della piattaforma.
create or replace function is_platform_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m join organizations o on o.id = m.organization_id
                 where m.user_id = auth.uid() and m.role = 'platform_admin' and o.kind = 'platform');
$$;

create or replace function can_edit_pack_in(p_pack text, p_org uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select is_platform_admin() or has_role_in(array['platform_editor', 'territory_editor']::member_role[], p_pack, p_org);
$$;

-- Ruoli coerenti: i ruoli di piattaforma solo nell'organizzazione della piattaforma; l'ambito di un ruolo cliente
-- solo su territori della sua organizzazione.
create or replace function memberships_guard()
returns trigger language plpgsql set search_path = public as $$
declare v_kind text;
begin
  select kind into v_kind from organizations where id = new.organization_id;
  if new.role in ('platform_admin', 'platform_editor') and v_kind <> 'platform' then
    raise exception 'il ruolo % esiste solo nell''organizzazione della piattaforma', new.role;
  end if;
  if v_kind <> 'platform' and new.pack_scope is not null
     and (select organization_id from packs where id = new.pack_scope) is distinct from new.organization_id then
    raise exception 'l''ambito % appartiene a un''altra organizzazione', new.pack_scope;
  end if;
  return new;
end;
$$;
create trigger memberships_guard_trg before insert or update on memberships
  for each row execute function memberships_guard();

-- Territori: si crea e si aggiorna solo dentro le organizzazioni in cui si ha il ruolo.
drop policy if exists packs_editor_insert on packs;
create policy packs_editor_insert on packs for insert with check (can_edit_pack_in(id, organization_id));
drop policy if exists packs_editor_update on packs;
create policy packs_editor_update on packs for update
  using (can_edit_pack(id)) with check (can_edit_pack_in(id, organization_id));

-- Campi che non cambia chi non è amministratore: organizzazione, tipologia, «fittizio».
-- Stadio «production», configurazione e livello di qualità li cambia solo chi pubblica.
create or replace function packs_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' or is_platform_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if new.kind = 'core' then raise exception 'solo l''amministratore crea territori di tipo core'; end if;
    return new;
  end if;
  if new.organization_id is distinct from old.organization_id then
    raise exception 'solo l''amministratore della piattaforma cambia l''organizzazione di un territorio';
  end if;
  if new.kind is distinct from old.kind then raise exception 'la tipologia di un territorio non cambia'; end if;
  if new.fictional is distinct from old.fictional then raise exception 'solo l''amministratore cambia «fittizio»'; end if;
  if (new.release_stage is distinct from old.release_stage and 'production' in (new.release_stage::text, old.release_stage::text))
     or new.config is distinct from old.config or new.quality_tier is distinct from old.quality_tier then
    perform studio_require(can_publish_pack(new.id), 'stadio di produzione, configurazione e livello di qualità li cambia chi pubblica');
  end if;
  return new;
end;
$$;
create trigger packs_guard_trg before insert or update on packs for each row execute function packs_guard();

-- Studio: creazione con l'organizzazione verificata prima di scrivere.
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
  -- (l'ambito più specifico, con le regole di has_role_in: un cliente crea solo nella propria organizzazione).
  if is_platform_admin() and p ? 'organizationId' and nullif(p ->> 'organizationId', '') is not null then
    v_org := (p ->> 'organizationId')::uuid;
  end if;
  v_org := coalesce(v_org,
    (select m.organization_id from memberships m join organizations o on o.id = m.organization_id
     where m.user_id = auth.uid() and m.role in ('platform_admin', 'platform_editor', 'territory_editor')
       and (m.pack_scope is null or v_id = m.pack_scope or v_id like m.pack_scope || '.%')
     order by (o.kind = 'platform') desc, length(coalesce(m.pack_scope, '')) desc limit 1));
  -- Nessun ruolo che autorizzi la creazione: stesso rifiuto per permessi (42501) di un ambito sbagliato.
  perform studio_require(v_org is not null and can_edit_pack_in(v_id, v_org),
    format('non puoi creare il territorio %s: è fuori dai territori che ti sono assegnati', v_id));

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


create or replace function studio_creation_scopes()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'anywhere', is_platform_admin()
                or exists (select 1 from memberships m join organizations o on o.id = m.organization_id
                           where m.user_id = auth.uid() and m.role in ('platform_editor', 'territory_editor')
                             and m.pack_scope is null),
    'scopes', coalesce((select jsonb_agg(distinct m.pack_scope) from memberships m
                        where m.user_id = auth.uid() and m.role in ('platform_editor', 'territory_editor') and m.pack_scope is not null), '[]'),
    'organizations', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) order by o.name) from organizations o), '[]'),
    'admin', is_platform_admin());
$$;

-- L'indice pubblico dell'app (bundles/index.json) lo riscrive solo lo staff della piattaforma che pubblica:
-- un cliente non può togliere o sostituire i territori degli altri.
create or replace function studio_can_publish_any()
returns boolean language sql stable security definer set search_path = public as $$
  select is_platform_admin() or exists (
    select 1 from memberships m join organizations o on o.id = m.organization_id
    where m.user_id = auth.uid() and o.kind = 'platform' and m.role in ('platform_editor', 'territory_editor'));
$$;

-- ---------------------------------------------------------------- 2. regole editoriali nel database

-- Coordinate: si spostano solo dallo Studio (studio_update_place, che chiede il metodo); un luogo nuovo ha il metodo;
-- lo stato «verificato» lo dichiara solo chi verifica.
create or replace function places_guard()
returns trigger language plpgsql set search_path = public as $$
declare v_pack text := (select pack_id from nodes where id = new.node_id);
begin
  if current_user <> 'authenticated' then return new; end if;
  if tg_op = 'INSERT' then
    if coalesce(trim(new.coordinate_method), '') = '' then raise exception 'indica come hai ottenuto le coordinate'; end if;
    if new.coordinate_status <> 'preliminary' and not can_verify_pack(v_pack) then
      raise exception 'un luogo nuovo ha coordinate preliminari';
    end if;
    return new;
  end if;
  if new.location is distinct from old.location
     and current_setting('app.studio', true) is distinct from 'coordinate:' || new.node_id then
    raise exception 'le coordinate si cambiano dallo Studio, indicando come sono state ottenute';
  end if;
  if new.coordinate_status is distinct from old.coordinate_status and new.coordinate_status <> 'preliminary'
     and not can_verify_pack(v_pack) then
    raise exception 'solo un esperto o la redazione dichiarano verificate le coordinate';
  end if;
  return new;
end;
$$;
create trigger places_guard_trg before insert or update on places for each row execute function places_guard();
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
      perform set_config('app.studio', 'coordinate:' || v_node, true);
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


-- Stato di pubblicazione: cambia solo da studio_set_pack_status (passaggi ammessi, permessi, blocchi, controllo).
-- Una destinazione nasce in bozza; eliminarla (= toglierla dall'app) richiede il permesso di pubblicazione.
create or replace function destinations_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'una destinazione nasce in bozza'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    perform studio_require(can_publish_pack(old.pack_id), 'non hai i permessi per togliere questa destinazione');
    return old;
  end if;
  if (new.status is distinct from old.status or new.published_at is distinct from old.published_at
      or new.published_by is distinct from old.published_by)
     and current_setting('app.studio', true) is distinct from 'stato:' || new.pack_id then
    raise exception 'lo stato di pubblicazione si cambia dallo Studio (controllo di pubblicazione e blocchi)';
  end if;
  return new;
end;
$$;
create trigger destinations_guard_trg before insert or update or delete on destinations
  for each row execute function destinations_guard();
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

  perform set_config('app.studio', 'stato:' || p_pack, true);
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
  perform set_config('app.studio', 'stato:' || p_pack, true);
  insert into publications (pack_id, requested_by, status, report, note)
  values (p_pack, auth.uid(), 'requested', p_report, 'ripubblicazione dallo Studio')
  returning id into v_id;
  return v_id;
end;
$$;


-- Richieste di pubblicazione: solo dalle funzioni dello Studio (dopo il controllo), non con INSERT diretti.
drop policy if exists publications_request on publications;
create policy publications_request on publications for insert
  with check (requested_by = auth.uid() and status = 'requested' and can_publish_pack(pack_id)
              and current_setting('app.studio', true) = 'stato:' || pack_id);

-- Eliminazioni: un'affermazione verificata la elimina chi verifica; un contenuto pubblicato chi pubblica.
create or replace function editorial_delete_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' then return old; end if;
  -- Stato confrontato come testo: le tabelle usano tipi diversi (assertion_status, publish_status).
  if tg_table_name = 'assertions' then
    if old.status::text = 'verified' then
      perform studio_require(can_verify_pack(old.pack_id), 'un''affermazione verificata la elimina un esperto o la redazione');
    end if;
  elsif old.status::text = 'published' then
    perform studio_require(can_publish_pack(old.pack_id), 'un contenuto pubblicato lo elimina chi pubblica');
  end if;
  return old;
end;
$$;
create trigger editorial_delete_guard_assertions before delete on assertions for each row execute function editorial_delete_guard();
create trigger editorial_delete_guard_units before delete on narrative_units for each row execute function editorial_delete_guard();
create trigger editorial_delete_guard_routes before delete on routes for each row execute function editorial_delete_guard();
create trigger editorial_delete_guard_nodes before delete on nodes for each row execute function editorial_delete_guard();

-- Prove di un'affermazione verificata: chi non verifica può cambiarle, ma l'affermazione torna in revisione
-- (come per i testi: editorial_assertion_text_guard).
create or replace function editorial_evidence_guard()
returns trigger language plpgsql set search_path = public as $$
declare v_assertion uuid := coalesce(new.assertion_id, old.assertion_id);
begin
  if current_user = 'authenticated' then
    update assertions set status = 'in_review', verified_by = null, verified_at = null, updated_at = now()
    where id = v_assertion and status = 'verified' and not can_verify_pack(pack_id);
  end if;
  return coalesce(new, old);
end;
$$;
create trigger editorial_evidence_guard_trg after insert or update or delete on evidence
  for each row execute function editorial_evidence_guard();

-- ---------------------------------------------------------------- 3. riferimenti dentro il territorio

-- Un contenuto può riferirsi solo al proprio territorio o ai territori da cui dipende (come il validatore dei pack).
create or replace function pack_reaches(p_from text, p_to text)
returns boolean language sql stable security definer set search_path = public as $$
  with recursive up(id) as (
    select p_from
    union
    select d.depends_on_id from pack_dependencies d join up on d.pack_id = up.id)
  select p_to is not null and exists (select 1 from up where id = p_to);
$$;

-- Territorio di una riga collegata, anche se l'utente non la vede (le RLS la nasconderebbero e il controllo
-- passerebbe senza accorgersene). Restituisce solo l'identificativo del territorio.
create or replace function pack_of(p_kind text, p_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'node' then (select pack_id from nodes where id = p_id)
    when 'source' then (select pack_id from sources where id = p_id)
    when 'assertion' then (select pack_id from assertions where id = p_id)
    when 'route' then (select pack_id from routes where id = p_id)
    when 'unit' then (select pack_id from narrative_units where id = p_id)
    when 'media' then (select pack_id from media_assets where id = p_id)
  end;
$$;

create or replace function references_guard()
returns trigger language plpgsql set search_path = public as $$
declare
  v_from text;
  v_to text[];
  t text;
begin
  if current_user <> 'authenticated' then return new; end if;
  case tg_table_name
    when 'assertions' then
      v_from := new.pack_id; v_to := array[pack_of('node', new.subject_id), pack_of('node', new.object_id)];
    when 'narrative_units' then
      v_from := new.pack_id; v_to := array[pack_of('node', new.anchor_node_id)];
    when 'unit_assertions' then
      v_from := pack_of('unit', new.unit_id); v_to := array[pack_of('assertion', new.assertion_id)];
    when 'evidence' then
      v_from := pack_of('assertion', new.assertion_id); v_to := array[pack_of('source', new.source_id)];
    when 'route_stops' then
      v_from := pack_of('route', new.route_id); v_to := array[pack_of('node', new.place_node_id)];
    when 'media_subjects' then
      v_from := pack_of('media', new.media_id); v_to := array[pack_of('node', new.node_id)];
    when 'places' then
      v_from := pack_of('node', new.node_id); v_to := array[pack_of('node', new.part_of_node_id)];
    when 'territory_memberships' then
      v_from := pack_of('node', new.territory_node_id); v_to := array[pack_of('node', new.member_node_id)];
    when 'walk_edges' then
      v_from := pack_of('node', new.from_node_id); v_to := array[pack_of('node', new.to_node_id)];
    when 'disputes' then
      v_from := new.pack_id; v_to := array[pack_of('assertion', new.preferred_assertion_id)];
  end case;
  foreach t in array v_to loop
    if t is not null and not pack_reaches(v_from, t) then
      raise exception 'riferimento a un contenuto di %: si possono usare solo il territorio e quelli da cui dipende', t;
    end if;
  end loop;
  return new;
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['assertions', 'narrative_units', 'unit_assertions', 'evidence', 'route_stops', 'media_subjects',
                           'places', 'territory_memberships', 'walk_edges', 'disputes'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function references_guard()',
                   t || '_references_guard', t);
  end loop;
end $$;

-- Dipendenze tra territori: niente cicli, anche con scritture dirette.
create or replace function pack_dependencies_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user = 'authenticated' and pack_reaches(new.depends_on_id, new.pack_id) then
    raise exception 'dipendenza circolare: % dipende già da %', new.depends_on_id, new.pack_id;
  end if;
  return new;
end;
$$;
create trigger pack_dependencies_guard_trg before insert or update on pack_dependencies
  for each row execute function pack_dependencies_guard();

-- Foto: il file sta nella cartella del territorio e c'è davvero nel bucket.
create or replace function media_file_exists(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from storage.objects where bucket_id = 'media' and name = p_path);
$$;

create or replace function media_assets_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if new.storage_path not like new.pack_id || '/%'
     or (new.poster_path is not null and new.poster_path not like new.pack_id || '/%') then
    raise exception 'il file di una foto sta nella cartella del suo territorio';
  end if;
  if tg_op = 'INSERT' and not media_file_exists(new.storage_path) then
    raise exception 'il file % non è nel bucket media', new.storage_path;
  end if;
  return new;
end;
$$;
create trigger media_assets_guard_trg before insert or update on media_assets
  for each row execute function media_assets_guard();

-- ---------------------------------------------------------------- 4. vista node_refs

-- Le viste girano con i privilegi del proprietario: senza security_invoker node_refs mostrava a chiunque
-- identificativi e riferimenti di tutti i nodi. Ora valgono le policy di nodes; agli anonimi nemmeno quelle.
alter view node_refs set (security_invoker = true);
revoke select on node_refs from anon;

-- ---------------------------------------------------------------- 5. bucket pubblico «bundles»

-- Solo i file dei bundle: JSON, immagini, video, audio; massimo 50 MB per file (come il bucket media).
update storage.buckets set
  file_size_limit = 50 * 1024 * 1024,
  allowed_mime_types = array['application/json', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm',
                             'audio/mpeg', 'audio/mp4']
where id = 'bundles';

-- E solo nei percorsi che produce la pipeline: <territorio>/<lingua>-full/(manifest.json | content.<hash>.json |
-- media/<impronta>.<estensione>), più index.json. Niente HTML, SVG o altri file, anche se il tipo dichiarato mente.
create or replace function bundle_object_name_ok(p_name text)
returns boolean language sql immutable as $$
  select p_name = 'index.json'
      or p_name ~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*/[a-z]{2}-full/(manifest\.json|content\.[0-9a-f]{8,64}\.json|media/[0-9a-f]{16}\.(jpg|jpeg|png|webp|mp4|webm|mp3|m4a))$';
$$;
drop policy if exists bundles_files_publisher_insert on storage.objects;
drop policy if exists bundles_files_publisher_update on storage.objects;
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

-- Bucket privato «media»: anche qui solo le estensioni dei formati ammessi.
drop policy if exists media_files_editor_insert on storage.objects;
create policy media_files_editor_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.can_edit_pack((storage.foldername(name))[1])
              and lower(name) ~ '\.(jpg|jpeg|png|webp|mp4|webm|mp3|m4a|aac|ogg|wav)$');

-- ---------------------------------------------------------------- permessi di esecuzione

do $$
declare f text;
begin
  foreach f in array array['has_role_in(member_role[], text, uuid)', 'can_edit_pack_in(text, uuid)', 'pack_reaches(text, text)',
                           'pack_of(text, uuid)', 'media_file_exists(text)',
                           'bundle_object_name_ok(text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array['memberships_guard()', 'packs_guard()', 'places_guard()', 'destinations_guard()',
                           'editorial_delete_guard()', 'editorial_evidence_guard()', 'references_guard()',
                           'pack_dependencies_guard()', 'media_assets_guard()'] loop
    execute format('revoke execute on function %s from public, anon', f);
  end loop;
end $$;
