-- =====================================================================
-- AI Guide Engine — modello dati v0.2 (Fase 0)
-- =====================================================================
--
-- Il database è il SISTEMA DI REDAZIONE. L'app turistica non lo legge a
-- runtime: legge i bundle compilati dai Territory Pack e pubblicati su CDN.
--
-- Domini:
--   1. Knowledge  — grafo globale: nodi, affermazioni con prove, fonti, controversie
--   2. Spatial    — luoghi, geofence, territori sovrapposti, ancore, grafo pedonale
--   3. Narrative  — unità narrative componibili, concetti, richiami, percorsi
--   4. Editorial  — organizzazioni, permessi ruolo × territorio × dominio, changeset
--   5. Product    — pack, destinazioni, bundle
--
-- I vocabolari (tipi di nodo, tipi di affermazione…) rispecchiano
-- packages/domain/src/vocabulary.ts: tenere allineati i due file.
-- =====================================================================

create extension if not exists postgis;

-- =====================================================================
-- 0. VOCABOLARI
-- =====================================================================

create type node_kind as enum (
  'place', 'territory', 'person', 'organization', 'event', 'period', 'theme', 'work', 'legend'
);
create type place_kind as enum ('site', 'poi', 'feature');
create type territory_kind as enum ('administrative', 'tourism', 'cultural', 'park');
create type assertion_type as enum ('fact', 'interpretation', 'tradition', 'legend', 'disputed');
create type certainty_level as enum ('established', 'probable', 'uncertain');
create type assertion_status as enum ('draft', 'in_review', 'verified', 'rejected', 'deprecated', 'blocked');
create type quality_tier as enum ('bronze', 'silver', 'gold');
create type source_reliability as enum ('A', 'B', 'C', 'D');
create type predicate_kind as enum ('relation', 'value', 'statement');
create type geofence_kind as enum ('arrival', 'viewpoint');
create type anchor_kind as enum ('pier', 'bus_stop', 'train_station', 'parking', 'cruise_terminal', 'other');
create type unit_type as enum ('opening', 'context', 'detail', 'curiosity', 'legend', 'closing', 'transition');
create type audience_kind as enum ('general', 'family', 'kids', 'expert');
create type concept_role as enum ('introduces', 'requires', 'mentions');
create type publish_status as enum ('draft', 'in_review', 'published', 'archived');
create type pack_kind as enum ('core', 'region', 'area', 'destination');
create type member_role as enum ('platform_editor', 'territory_editor', 'expert', 'institution', 'contributor', 'translator');
create type changeset_risk as enum ('low', 'medium', 'high', 'institutional');
create type changeset_status as enum ('open', 'approved', 'rejected', 'applied', 'withdrawn');

create table locales (
  code    text primary key,
  name    text not null,
  enabled boolean not null default false
);

-- =====================================================================
-- 1. EDITORIAL (prima, perché i nodi appartengono a un pack/organizzazione)
-- =====================================================================

create table organizations (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('platform', 'institution', 'association', 'partner')),
  name       text not null,
  created_at timestamptz not null default now()
);

-- Un Territory Pack: unità di contenuto e di versionamento.
create table packs (
  id              text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$'),
  kind            pack_kind not null,
  organization_id uuid not null references organizations (id),
  default_locale  text not null references locales (code),
  quality_tier    quality_tier not null default 'silver',
  fictional       boolean not null default false,
  config          jsonb not null default '{}',   -- validato con lo schema di config.yaml
  version         text not null default '0.1.0',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table pack_dependencies (
  pack_id       text not null references packs (id) on delete cascade,
  depends_on_id text not null references packs (id),
  primary key (pack_id, depends_on_id),
  check (pack_id <> depends_on_id)
);

-- =====================================================================
-- 2. KNOWLEDGE — grafo globale
-- =====================================================================

-- Tutti i nodi: luoghi, territori, persone, eventi, temi, leggende...
-- Identità globale = pack_id + slug (gli slug da soli non sono unici).
create table nodes (
  id           uuid primary key default gen_random_uuid(),
  pack_id      text not null references packs (id),
  slug         text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  kind         node_kind not null,
  attributes   jsonb not null default '{}',     -- validati per kind con zod
  quality_tier quality_tier,
  status       publish_status not null default 'draft',
  merged_into  uuid references nodes (id),      -- unione dei duplicati: il vecchio id resta e reindirizza
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (pack_id, slug)
);
create index nodes_kind_idx on nodes (kind);

create view node_refs as
  select id, pack_id || ':' || slug as ref, kind from nodes;

create table node_labels (
  node_id           uuid not null references nodes (id) on delete cascade,
  locale            text not null references locales (code),
  name              text not null,
  short_description text,
  aliases           text[] not null default '{}',
  pronunciation     text,
  primary key (node_id, locale)
);

create table node_external_ids (
  node_id uuid not null references nodes (id) on delete cascade,
  scheme  text not null check (scheme in ('wikidata', 'osm', 'iccd', 'arco', 'other')),
  value   text not null,
  primary key (node_id, scheme, value)
);

-- Ontologia controllata (rispecchia packages/domain/src/ontology.ts).
create table predicates (
  id          text primary key,
  kind        predicate_kind not null,
  domain      node_kind[],          -- null = qualsiasi
  range       node_kind[],          -- solo per le relazioni; null = qualsiasi
  value_shape text check (value_shape in ('year_range', 'measure')),
  label_it    text not null,
  label_en    text not null,
  check ((kind = 'value') = (value_shape is not null))
);

create table sources (
  id              uuid primary key default gen_random_uuid(),
  pack_id         text not null references packs (id),
  slug            text not null,
  kind            text not null,
  title           text not null,
  authors         text[] not null default '{}',
  institution     text,
  year            smallint,
  language        text references locales (code),
  reliability     source_reliability not null,
  url             text,
  license         text,
  fictional       boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (pack_id, slug)
);

-- Gruppi di affermazioni in conflitto tra loro.
create table disputes (
  id                     uuid primary key default gen_random_uuid(),
  pack_id                text not null references packs (id),
  slug                   text not null,
  preferred_assertion_id uuid,                    -- FK aggiunta dopo `assertions`
  rationale              text,
  unique (pack_id, slug)
);

-- Ogni fatto, attributo o relazione è un'affermazione con prove.
create table assertions (
  id             uuid primary key default gen_random_uuid(),
  pack_id        text not null references packs (id),
  slug           text not null,
  subject_id     uuid not null references nodes (id),
  predicate_id   text not null references predicates (id),
  object_id      uuid references nodes (id),
  -- valore strutturato: anni (year_range) o misura (measure)
  year_from      smallint,
  year_to        smallint,
  circa          boolean not null default false,
  amount         numeric,
  unit           text,
  type           assertion_type not null,
  certainty      certainty_level,
  status         assertion_status not null default 'draft',
  quality_tier   quality_tier,
  dispute_id     uuid references disputes (id),
  authored_by    text not null,
  verified_by    text,
  verified_at    timestamptz,
  review_due     date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (pack_id, slug),
  check (year_to is null or year_from is null or year_to >= year_from),
  check ((type in ('fact', 'interpretation')) = (certainty is not null)),
  check (type <> 'disputed' or dispute_id is not null),
  -- regola dei quattro occhi
  check (status <> 'verified' or (verified_by is not null and verified_by <> authored_by))
);
create index assertions_subject_idx on assertions (subject_id) where status = 'verified';
create index assertions_object_idx on assertions (object_id) where status = 'verified';

alter table disputes
  add constraint disputes_preferred_fk foreign key (preferred_assertion_id) references assertions (id);

create table assertion_texts (
  assertion_id uuid not null references assertions (id) on delete cascade,
  locale       text not null references locales (code),
  statement    text not null,
  reviewed     boolean not null default false,
  primary key (assertion_id, locale)
);

create table evidence (
  assertion_id uuid not null references assertions (id) on delete cascade,
  source_id    uuid not null references sources (id),
  locator      text,
  excerpt      text,
  primary key (assertion_id, source_id)
);

-- Coerenza dell'affermazione con l'ontologia (dominio, codominio, forma del valore).
create or replace function assertions_check_ontology()
returns trigger language plpgsql as $$
declare
  p predicates%rowtype;
  subject_kind node_kind;
  object_kind node_kind;
begin
  select * into p from predicates where id = new.predicate_id;
  select kind into subject_kind from nodes where id = new.subject_id;
  if p.domain is not null and not subject_kind = any (p.domain) then
    raise exception 'predicato % non ammesso per soggetti di tipo %', p.id, subject_kind;
  end if;
  if p.kind = 'relation' then
    if new.object_id is null then
      raise exception 'il predicato % richiede un oggetto', p.id;
    end if;
    select kind into object_kind from nodes where id = new.object_id;
    if p.range is not null and not object_kind = any (p.range) then
      raise exception 'il predicato % non ammette oggetti di tipo %', p.id, object_kind;
    end if;
  elsif new.object_id is not null then
    raise exception 'il predicato % non ammette un oggetto', p.id;
  end if;
  if p.value_shape = 'year_range' and new.year_from is null then
    raise exception 'il predicato % richiede year_from', p.id;
  end if;
  if p.value_shape = 'measure' and (new.amount is null or new.unit is null) then
    raise exception 'il predicato % richiede amount e unit', p.id;
  end if;
  return new;
end;
$$;

create trigger assertions_check_ontology_trg
before insert or update of subject_id, predicate_id, object_id, year_from, amount, unit on assertions
for each row execute function assertions_check_ontology();

-- =====================================================================
-- 3. SPATIAL
-- =====================================================================

-- Estensione spaziale dei nodi di tipo 'place'.
create table places (
  node_id       uuid primary key references nodes (id) on delete cascade,
  place_kind    place_kind not null,
  categories    text[] not null default '{}',
  location      geography (point, 4326) not null,
  elevation_m   real,
  importance    smallint not null check (importance between 1 and 5),
  dwell_min     smallint not null,
  accessibility jsonb not null default '{}',
  practical     jsonb not null default '{}'       -- orari, biglietti: informazioni operative, non storiche
);
create index places_location_gix on places using gist (location);

create table geofences (
  id                 uuid primary key default gen_random_uuid(),
  place_node_id      uuid not null references places (node_id) on delete cascade,
  kind               geofence_kind not null,
  center             geography (point, 4326),     -- null = posizione del luogo
  radius_m           real not null check (radius_m between 5 and 2000),
  min_dwell_s        smallint not null default 8,
  max_accuracy_m     smallint not null default 35,
  view_bearing_deg   smallint check (view_bearing_deg between 0 and 359),
  view_tolerance_deg smallint,
  check (kind = 'viewpoint' or view_bearing_deg is null),
  check (kind <> 'viewpoint' or center is not null)
);

-- Anche i territori sono nodi; possono sovrapporsi (Cinque Terre su più comuni).
create table territories (
  node_id  uuid primary key references nodes (id) on delete cascade,
  kind     territory_kind not null,
  boundary geography (multipolygon, 4326)
);
create index territories_boundary_gix on territories using gist (boundary);

create table territory_memberships (
  territory_node_id uuid not null references territories (node_id) on delete cascade,
  member_node_id    uuid not null references nodes (id) on delete cascade,
  primary key (territory_node_id, member_node_id)
);

create table anchors (
  id                uuid primary key default gen_random_uuid(),
  pack_id           text not null references packs (id),
  slug              text not null,
  kind              anchor_kind not null,
  location          geography (point, 4326) not null,
  safety_margin_min smallint not null,
  labels            jsonb not null,               -- { "it": { "name": ... }, ... }
  unique (pack_id, slug)
);

-- Grafo pedonale per zona (non una matrice completa tra tutti i luoghi).
create table walk_edges (
  from_node_id     uuid not null references nodes (id) on delete cascade,
  to_node_id       uuid not null references nodes (id) on delete cascade,
  zone             text not null,
  seconds          integer not null,
  distance_m       integer not null,
  elevation_gain_m integer not null default 0,
  step_free        boolean,
  path             geography (linestring, 4326),
  primary key (from_node_id, to_node_id)
);
create index walk_edges_zone_idx on walk_edges (zone);

-- =====================================================================
-- 4. NARRATIVE
-- =====================================================================

create table narrative_units (
  id             uuid primary key default gen_random_uuid(),
  pack_id        text not null references packs (id),
  slug           text not null,
  anchor_node_id uuid not null references nodes (id),
  unit_type      unit_type not null,
  locale         text not null references locales (code),
  audience       audience_kind not null default 'general',
  duration_s     smallint not null check (duration_s between 5 and 120),
  text           text not null,
  resume_hook    text,
  origin         text not null default 'human' check (origin in ('human', 'ai_assisted')),
  status         publish_status not null default 'draft',
  reviewed_by    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (pack_id, slug)
);

-- Grounding: quali affermazioni usa l'unità.
create table unit_assertions (
  unit_id      uuid not null references narrative_units (id) on delete cascade,
  assertion_id uuid not null references assertions (id),
  primary key (unit_id, assertion_id)
);

-- Progressione narrativa: concetti introdotti, richiesti, citati.
create table unit_concepts (
  unit_id         uuid not null references narrative_units (id) on delete cascade,
  concept_node_id uuid not null references nodes (id),
  role            concept_role not null,
  primary key (unit_id, concept_node_id, role)
);

create table unit_hooks (
  unit_id        uuid not null references narrative_units (id) on delete cascade,
  target_node_id uuid not null references nodes (id),
  text           text not null,
  primary key (unit_id, target_node_id)
);

create table audio_assets (
  id           uuid primary key default gen_random_uuid(),
  unit_id      uuid not null references narrative_units (id) on delete cascade,
  voice_id     text not null,
  path         text not null,                     -- indirizzato per contenuto (hash nel nome)
  duration_ms  integer not null,
  bytes        integer not null,
  source_hash  text not null,                     -- hash del testo al momento del render
  created_at   timestamptz not null default now(),
  unique (unit_id, voice_id, source_hash)
);

create table routes (
  id            uuid primary key default gen_random_uuid(),
  pack_id       text not null references packs (id),
  slug          text not null,
  duration_min  smallint not null,
  labels        jsonb not null,
  end_anchor_id uuid references anchors (id),
  status        publish_status not null default 'draft',
  unique (pack_id, slug)
);

create table route_stops (
  route_id      uuid not null references routes (id) on delete cascade,
  position      smallint not null,
  place_node_id uuid not null references places (node_id),
  dwell_min     smallint,
  optional      boolean not null default false,
  primary key (route_id, position)
);

-- Se un'affermazione smette di essere verificata, le unità che la usano tornano in revisione.
create or replace function assertions_invalidate_units()
returns trigger language plpgsql as $$
begin
  if old.status = 'verified' and new.status <> 'verified' then
    update narrative_units u set status = 'in_review', updated_at = now()
    where u.status = 'published'
      and exists (select 1 from unit_assertions ua where ua.unit_id = u.id and ua.assertion_id = new.id);
  end if;
  return new;
end;
$$;

create trigger assertions_invalidate_units_trg
after update of status on assertions
for each row execute function assertions_invalidate_units();

-- =====================================================================
-- 5. EDITORIAL — permessi e changeset
-- =====================================================================

-- Permessi a tre dimensioni: ruolo × territorio (pack) × dominio.
create table memberships (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  role            member_role not null,
  pack_scope      text references packs (id),   -- null = tutti i pack; altrimenti il pack e i suoi discendenti
  domain_scope    text,                          -- es. 'arte-sacra', 'archeologia'; null = tutti
  created_at      timestamptz not null default now(),
  unique nulls not distinct (user_id, organization_id, role, pack_scope, domain_scope)
);

-- Ogni modifica ai contenuti passa da un changeset.
create table changesets (
  id               uuid primary key default gen_random_uuid(),
  pack_id          text not null references packs (id),
  author_id        uuid not null references auth.users (id),
  title            text not null,
  rationale        text,
  risk             changeset_risk not null,
  status           changeset_status not null default 'open',
  diff             jsonb not null,               -- operazioni sul pack (aggiunte, modifiche, rimozioni)
  automated_checks jsonb,                        -- esito del validatore sul pack risultante
  created_at       timestamptz not null default now(),
  applied_at       timestamptz
);
create index changesets_open_idx on changesets (pack_id, created_at) where status = 'open';

create table changeset_reviews (
  id           uuid primary key default gen_random_uuid(),
  changeset_id uuid not null references changesets (id) on delete cascade,
  reviewer_id  uuid not null references auth.users (id),
  decision     text not null check (decision in ('approve', 'request_changes', 'reject')),
  note         text,
  created_at   timestamptz not null default now()
);

-- Chi propone non può approvare il proprio changeset.
create or replace function changeset_reviews_not_author()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from changesets c where c.id = new.changeset_id and c.author_id = new.reviewer_id) then
    raise exception 'chi propone un changeset non può revisionarlo';
  end if;
  return new;
end;
$$;

create trigger changeset_reviews_not_author_trg
before insert on changeset_reviews
for each row execute function changeset_reviews_not_author();

-- =====================================================================
-- 6. PRODUCT — destinazioni e bundle
-- =====================================================================

create table destinations (
  pack_id    text primary key references packs (id),
  status     publish_status not null default 'draft',
  created_at timestamptz not null default now()
);

-- Build immutabile per destinazione × lingua × variante, pubblicata su CDN.
create table bundles (
  id              uuid primary key default gen_random_uuid(),
  pack_id         text not null references destinations (pack_id),
  locale          text not null references locales (code),
  flavor          text not null check (flavor in ('lite', 'full')),
  version         integer not null,
  schema_version  smallint not null,
  min_app_version text not null,
  kb_hash         text not null,                 -- hash delle affermazioni incluse
  manifest        jsonb not null,                -- file con sha256 e dimensioni
  total_bytes     bigint not null,
  url             text not null,
  built_at        timestamptz not null default now(),
  unique (pack_id, locale, flavor, version)
);

-- =====================================================================
-- 7. ROW LEVEL SECURITY
-- =====================================================================
-- La lettura pubblica non passa dal database (bundle su CDN): qui solo staff.

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

do $$
declare t text;
begin
  foreach t in array array[
    'packs', 'nodes', 'node_labels', 'sources', 'assertions', 'assertion_texts', 'evidence',
    'disputes', 'places', 'geofences', 'territories', 'anchors', 'narrative_units',
    'unit_assertions', 'unit_concepts', 'unit_hooks', 'routes', 'route_stops',
    'memberships', 'changesets', 'changeset_reviews', 'bundles'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Lettura per tutto lo staff; scrittura diretta solo per la redazione della piattaforma.
-- Gli altri ruoli modificano i contenuti tramite changeset, applicati dal backend.
create policy packs_staff_read on packs for select
  using (has_role(array['platform_editor', 'territory_editor', 'expert', 'institution', 'contributor', 'translator']::member_role[], id));
create policy nodes_staff_read on nodes for select
  using (has_role(array['platform_editor', 'territory_editor', 'expert', 'institution', 'contributor', 'translator']::member_role[], pack_id));
create policy nodes_platform_write on nodes for all
  using (has_role(array['platform_editor']::member_role[], pack_id))
  with check (has_role(array['platform_editor']::member_role[], pack_id));
create policy assertions_staff_read on assertions for select
  using (has_role(array['platform_editor', 'territory_editor', 'expert', 'institution', 'contributor', 'translator']::member_role[], pack_id));
create policy assertions_platform_write on assertions for all
  using (has_role(array['platform_editor']::member_role[], pack_id))
  with check (has_role(array['platform_editor']::member_role[], pack_id));
create policy units_staff_read on narrative_units for select
  using (has_role(array['platform_editor', 'territory_editor', 'expert', 'institution', 'contributor', 'translator']::member_role[], pack_id));

create policy memberships_self_read on memberships for select using (user_id = auth.uid());

create policy changesets_read on changesets for select
  using (author_id = auth.uid() or has_role(array['platform_editor', 'territory_editor', 'expert', 'institution']::member_role[], pack_id));
create policy changesets_propose on changesets for insert
  with check (author_id = auth.uid()
              and has_role(array['platform_editor', 'territory_editor', 'expert', 'institution', 'contributor', 'translator']::member_role[], pack_id));
create policy changeset_reviews_insert on changeset_reviews for insert
  with check (reviewer_id = auth.uid() and exists (
    select 1 from changesets c where c.id = changeset_id
      and has_role(array['platform_editor', 'territory_editor', 'expert', 'institution']::member_role[], c.pack_id)));

-- =====================================================================
-- 8. DATI DI BASE: lingue e ontologia v1
-- =====================================================================

insert into locales (code, name, enabled) values
  ('it', 'Italiano', true), ('en', 'English', true),
  ('fr', 'Français', false), ('de', 'Deutsch', false), ('es', 'Español', false);

insert into predicates (id, kind, domain, range, value_shape, label_it, label_en) values
  ('part_of',         'relation', '{place}', '{place,territory}', null, 'fa parte di', 'is part of'),
  ('located_in',      'relation', '{place,territory}', '{territory}', null, 'si trova in', 'is located in'),
  ('built_by',        'relation', '{place,work}', '{person,organization}', null, 'costruito da', 'built by'),
  ('commissioned_by', 'relation', '{place,work}', '{person,organization}', null, 'commissionato da', 'commissioned by'),
  ('visited',         'relation', '{person}', '{place,territory}', null, 'visitò', 'visited'),
  ('lived_in',        'relation', '{person}', '{place,territory}', null, 'visse a', 'lived in'),
  ('created',         'relation', '{person,organization}', '{work}', null, 'creò', 'created'),
  ('depicts',         'relation', '{work}', '{person,event,place,territory,legend}', null, 'raffigura', 'depicts'),
  ('occurred_at',     'relation', '{event}', '{place,territory}', null, 'avvenne a', 'took place at'),
  ('participated_in', 'relation', '{person,organization}', '{event}', null, 'partecipò a', 'took part in'),
  ('controlled_by',   'relation', '{place,territory}', '{organization,person}', null, 'controllato da', 'controlled by'),
  ('set_in',          'relation', '{legend,work}', '{place,territory}', null, 'ambientato a', 'set in'),
  ('dedicated_to',    'relation', '{place,work}', '{person,event,legend}', null, 'dedicato a', 'dedicated to'),
  ('named_after',     'relation', '{place,territory}', '{person,legend,theme,event}', null, 'prende il nome da', 'named after'),
  ('during',          'relation', '{event,place,work}', '{period}', null, 'durante', 'during'),
  ('has_theme',       'relation', null, '{theme}', null, 'riguarda il tema', 'relates to theme'),
  ('dated',           'value', '{place,work,event}', null, 'year_range', 'datato', 'dated'),
  ('lifespan',        'value', '{person}', null, 'year_range', 'visse', 'lived'),
  ('measures',        'value', '{place,work}', null, 'measure', 'misura', 'measures'),
  ('described_as',    'statement', null, null, null, 'descrizione', 'description'),
  ('tells',           'statement', '{legend}', null, null, 'racconta', 'tells');
