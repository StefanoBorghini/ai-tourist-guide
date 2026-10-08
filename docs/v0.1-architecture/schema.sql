-- =====================================================================
-- AI TOURIST GUIDE — Schema Supabase / PostgreSQL (v0.1, proposta)
-- =====================================================================
--
-- Principi:
--   1. FATTI ≠ NARRAZIONE. I fatti verificati vivono in `claims`
--      (affermazioni atomiche, con fonti e stato di verifica).
--      Le narrazioni (`stories`, `story_variants`) DICHIARANO quali
--      claim usano. L'AI riceve solo claim verificati.
--   2. NIENTE HARDCODING DI PORTOVENERE. Gerarchia generica di
--      `territories` (country > region > area > destination > district).
--   3. MULTILINGUA NATIVO. Tabelle *_translations tipizzate per i
--      contenuti strutturati; varianti narrative per locale (non
--      traduzioni parola per parola).
--   4. OFFLINE-FIRST. Tutto ciò che serve al tour base è
--      impacchettabile in un `content_pack` per territorio × lingua.
--   5. PRIVACY BY DESIGN. Nessuna traccia GPS grezza lato server.
--
-- Estensioni richieste (tutte disponibili su Supabase).
-- =====================================================================

create extension if not exists postgis;
create extension if not exists vector;
create extension if not exists pg_trgm;

-- =====================================================================
-- 0. TIPI ENUMERATI
-- =====================================================================

create type publish_status as enum ('draft', 'in_review', 'published', 'archived');

-- Stato di verifica di un fatto. Solo 'verified' arriva all'AI e al pubblico.
create type verification_status as enum ('draft', 'in_review', 'verified', 'rejected', 'deprecated');

-- Grado di certezza storica: determina il linguaggio con cui l'AI
-- può esprimere il fatto ("fu costruita" vs "secondo la leggenda").
create type certainty_level as enum ('established', 'probable', 'debated', 'traditional', 'legendary');

create type territory_kind as enum ('country', 'region', 'province', 'area', 'municipality', 'destination', 'district');

create type entity_kind as enum (
  'person', 'event', 'legend', 'artwork', 'architectural_feature',
  'tradition', 'natural_feature', 'period', 'organization', 'literary_work', 'product'
);

create type geofence_kind as enum (
  'arrival',     -- sei arrivato al POI
  'approach',    -- ti stai avvicinando (pre-caricamento, notifica soft)
  'viewpoint',   -- da qui VEDI il POI (es. il castello sopra di te)
  'interior'     -- sei dentro (es. navata della chiesa)
);

create type audience_kind as enum ('general', 'family', 'kids', 'expert');

create type staff_role as enum ('admin', 'editor', 'historian', 'translator', 'reviewer');

create type guide_mode as enum ('auto', 'ask', 'notify_only', 'when_stopped', 'silent');

create type tour_mode as enum ('curated', 'dynamic', 'free_roam');

create type tour_status as enum ('planned', 'active', 'paused', 'completed', 'abandoned');

-- =====================================================================
-- 1. ORGANIZZAZIONI, LINGUE, STAFF
-- =====================================================================

-- Chi possiede/cura i contenuti (Portovenere.com oggi, Italy Horizon
-- o partner istituzionali domani). Abilita il multi-tenant B2B.
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table locales (
  code         text primary key,              -- 'it', 'en', 'fr', 'de', 'es'
  name         text not null,
  -- tier 1: contenuti curati + audio pre-renderizzato
  -- tier 2: contenuti generati AI + revisione madrelingua
  -- tier 3: solo risposte live (nessun pack curato)
  content_tier smallint not null default 3 check (content_tier between 1 and 3),
  enabled      boolean not null default false
);

-- Ruoli redazionali, opzionalmente limitati a un territorio.
create table staff_members (
  user_id         uuid not null references auth.users (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  role            staff_role not null,
  territory_id    uuid,  -- FK aggiunta dopo `territories`; null = tutta l'organizzazione
  created_at      timestamptz not null default now(),
  primary key (user_id, organization_id, role)
);

-- =====================================================================
-- 2. TERRITORI (gerarchia generica, nessun hardcoding)
-- =====================================================================

create table territories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  parent_id       uuid references territories (id),
  kind            territory_kind not null,
  slug            text not null unique,              -- 'italia', 'liguria', 'golfo-dei-poeti', 'portovenere'
  boundary        geography (multipolygon, 4326),
  centroid        geography (point, 4326),
  default_locale  text not null references locales (code) default 'it',
  timezone        text not null default 'Europe/Rome',
  status          publish_status not null default 'draft',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index territories_parent_idx on territories (parent_id);
create index territories_boundary_gix on territories using gist (boundary);

alter table staff_members
  add constraint staff_members_territory_fk foreign key (territory_id) references territories (id);

create table territory_translations (
  territory_id uuid not null references territories (id) on delete cascade,
  locale       text not null references locales (code),
  name         text not null,
  tagline      text,
  description  text,
  primary key (territory_id, locale)
);

-- =====================================================================
-- 3. FONTI
-- =====================================================================

create table sources (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  kind            text not null check (kind in (
                    'book', 'academic_paper', 'archive_document', 'inscription',
                    'official_institution', 'heritage_registry', 'expert_interview',
                    'local_tradition', 'website', 'other')),
  title           text not null,
  authors         text[],
  publisher       text,
  year            smallint,
  isbn            text,
  url             text,
  -- A = fonte primaria / accademica, B = istituzionale, C = secondaria / divulgativa.
  -- Un claim 'established' dovrebbe avere almeno una fonte A o B (regola redazionale).
  reliability     char(1) not null check (reliability in ('A', 'B', 'C')),
  license_notes   text,
  notes           text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now()
);

-- =====================================================================
-- 4. POI (luoghi fisici visitabili) + CATEGORIE + GEOFENCE
-- =====================================================================

-- Categorie gerarchiche: monument > religious_building > church
create table poi_categories (
  id         text primary key,                 -- 'church', 'castle', 'museum', 'viewpoint', 'cave', 'street'...
  parent_id  text references poi_categories (id),
  icon       text
);

create table poi_category_translations (
  category_id text not null references poi_categories (id) on delete cascade,
  locale      text not null references locales (code),
  name        text not null,
  primary key (category_id, locale)
);

create table pois (
  id                  uuid primary key default gen_random_uuid(),
  territory_id        uuid not null references territories (id),
  parent_poi_id       uuid references pois (id),  -- es. "Torre" dentro "Castello Doria"
  category_id         text not null references poi_categories (id),
  slug                text not null,
  location            geography (point, 4326) not null,
  elevation_m         real,
  -- 1..5: guida la selezione nei tour dinamici e la priorità tra geofence sovrapposti
  importance          smallint not null default 3 check (importance between 1 and 5),
  suggested_dwell_min smallint not null default 5,
  period_from_year    smallint,                   -- datazione sintetica per filtri (fatti veri: in `claims`)
  period_to_year      smallint,
  interest_tags       text[] not null default '{}', -- 'history','architecture','art','nature','legends','literature','food'
  accessibility       jsonb not null default '{}',  -- { "step_free": false, "stairs": 120, "notes_ref": ... }
  practical_info      jsonb not null default '{}',  -- orari, biglietti (informazioni operative, non storiche)
  external_ids        jsonb not null default '{}',  -- { "wikidata": "Q...", "osm": "way/..." } solo come riferimento
  status              publish_status not null default 'draft',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (territory_id, slug)
);
create index pois_location_gix on pois using gist (location);
create index pois_territory_idx on pois (territory_id) where status = 'published';
create index pois_tags_gin on pois using gin (interest_tags);

create table poi_translations (
  poi_id            uuid not null references pois (id) on delete cascade,
  locale            text not null references locales (code),
  name              text not null,
  short_description text,          -- 1-2 frasi, per card e notifiche
  full_description  text,          -- testo editoriale (approvato) per la scheda
  pronunciation     text,          -- alias/IPA per TTS
  reviewed          boolean not null default false,
  primary key (poi_id, locale)
);
create index poi_translations_name_trgm on poi_translations using gin (name gin_trgm_ops);

-- Più geofence per POI: arrivo, avvicinamento, punti di vista, interno.
create table geofences (
  id                uuid primary key default gen_random_uuid(),
  poi_id            uuid not null references pois (id) on delete cascade,
  kind              geofence_kind not null default 'arrival',
  -- O cerchio (center + radius) O poligono (per caruggi, piazze, moli).
  center            geography (point, 4326),
  radius_m          real check (radius_m is null or radius_m between 5 and 2000),
  shape             geography (polygon, 4326),
  -- Isteresi: si esce solo oltre radius_m * exit_factor (evita "ping-pong" GPS).
  exit_factor       real not null default 1.3,
  min_dwell_s       smallint not null default 8,    -- tempo minimo dentro prima di triggerare
  max_accuracy_m    smallint not null default 35,   -- fix GPS meno precisi vengono ignorati
  -- Direzione in cui si guarda il POI da qui (per 'viewpoint'): 0-360, con tolleranza.
  view_bearing_deg  smallint check (view_bearing_deg between 0 and 359),
  view_tolerance_deg smallint default 45,
  priority          smallint not null default 0,
  cooldown_min      smallint not null default 30,
  active            boolean not null default true,
  constraint geofence_shape_chk check (
    (center is not null and radius_m is not null and shape is null)
    or (shape is not null and center is null)
  )
);
create index geofences_poi_idx on geofences (poi_id);
create index geofences_center_gix on geofences using gist (center);
create index geofences_shape_gix on geofences using gist (shape);

-- Tempi di cammino precomputati (grafo pedonale OSM, scale e pendenze incluse).
-- Popolata dal pack builder; usata dal route engine anche offline.
create table poi_walk_matrix (
  from_poi_id      uuid not null references pois (id) on delete cascade,
  to_poi_id        uuid not null references pois (id) on delete cascade,
  walk_seconds     integer not null,
  distance_m       integer not null,
  elevation_gain_m integer not null default 0,
  step_free        boolean,
  path             geography (linestring, 4326),
  computed_at      timestamptz not null default now(),
  primary key (from_poi_id, to_poi_id)
);

-- =====================================================================
-- 5. KNOWLEDGE GRAPH: ENTITÀ (persone, eventi, leggende, opere...)
-- =====================================================================
--
-- Un'unica tabella tipizzata invece di 10 tabelle (historical_people,
-- historical_events, legends, artworks...). Gli attributi specifici per
-- tipo stanno in `attributes` (validati con zod nell'app). Scala meglio
-- quando si aggiungono nuovi tipi (es. 'shipwreck', 'recipe').

create table entities (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id),
  kind             entity_kind not null,
  slug             text not null unique,            -- 'lord-byron', 'battaglia-della-meloria'
  -- Datazione strutturata (persona: nascita-morte; evento: inizio-fine; periodo: range)
  date_from        date,
  date_to          date,
  date_precision   text check (date_precision in ('day', 'month', 'year', 'decade', 'century')),
  attributes       jsonb not null default '{}',
  external_ids     jsonb not null default '{}',
  status           publish_status not null default 'draft',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index entities_kind_idx on entities (kind);

create table entity_translations (
  entity_id         uuid not null references entities (id) on delete cascade,
  locale            text not null references locales (code),
  name              text not null,
  short_description text,
  pronunciation     text,
  aliases           text[] not null default '{}',   -- per riconoscere "Byron", "Lord Byron", "George Gordon Byron"
  primary key (entity_id, locale)
);
create index entity_translations_name_trgm on entity_translations using gin (name gin_trgm_ops);

-- Collegamenti POI ↔ entità, con ruolo semantico.
create table poi_entities (
  poi_id     uuid not null references pois (id) on delete cascade,
  entity_id  uuid not null references entities (id) on delete cascade,
  role       text not null,   -- 'built_by','visited_by','occurred_at','depicts','located_in','named_after','legend_of'
  relevance  smallint not null default 3 check (relevance between 1 and 5),
  primary key (poi_id, entity_id, role)
);

-- Relazioni tra entità (grafo): Byron —friend_of→ Shelley
create table entity_relations (
  from_entity_id uuid not null references entities (id) on delete cascade,
  to_entity_id   uuid not null references entities (id) on delete cascade,
  relation       text not null,
  primary key (from_entity_id, to_entity_id, relation)
);

-- =====================================================================
-- 6. CLAIMS — LA BASE DI VERITÀ ("FACTS")
-- =====================================================================
--
-- Un claim è UNA affermazione atomica, verificabile, citata.
--   "La parte gotica della chiesa di San Pietro fu costruita tra
--    il XIII e il XIV secolo."          ← esempio, da verificare
-- L'AI può parafrasarlo, accorciarlo, adattarlo al pubblico, ma i
-- valori strutturati (date, nomi, numeri) devono restare invariati.

create table claims (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references organizations (id),
  -- Soggetto: un POI e/o un'entità.
  poi_id              uuid references pois (id) on delete cascade,
  entity_id           uuid references entities (id) on delete cascade,
  topic               text not null check (topic in (
                        'identity', 'dating', 'construction', 'architecture', 'art',
                        'history', 'person', 'etymology', 'legend', 'tradition',
                        'nature', 'geology', 'literature', 'curiosity', 'restoration',
                        'function', 'context')),
  certainty           certainty_level not null default 'established',
  -- Valori strutturati verificabili dal validatore anti-allucinazione.
  year_from           smallint,
  year_to             smallint,
  numeric_value       numeric,
  numeric_unit        text,
  mentioned_entity_ids uuid[] not null default '{}',
  importance          smallint not null default 3 check (importance between 1 and 5),
  kid_friendly        boolean not null default true,
  verification_status verification_status not null default 'draft',
  authored_by         uuid references auth.users (id),
  verified_by         uuid references auth.users (id),
  verified_at         timestamptz,
  version             integer not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint claims_subject_chk check (poi_id is not null or entity_id is not null),
  -- Regola dei 4 occhi: chi verifica non è chi ha scritto.
  constraint claims_four_eyes_chk check (verified_by is null or verified_by is distinct from authored_by),
  constraint claims_verified_chk check (
    verification_status <> 'verified' or (verified_by is not null and verified_at is not null))
);
create index claims_poi_idx on claims (poi_id) where verification_status = 'verified';
create index claims_entity_idx on claims (entity_id) where verification_status = 'verified';

create table claim_translations (
  claim_id   uuid not null references claims (id) on delete cascade,
  locale     text not null references locales (code),
  statement  text not null,
  reviewed   boolean not null default false,
  primary key (claim_id, locale)
);

create table claim_sources (
  claim_id  uuid not null references claims (id) on delete cascade,
  source_id uuid not null references sources (id),
  locator   text,      -- pagina, sezione, segnatura d'archivio
  excerpt   text,      -- citazione breve a supporto
  primary key (claim_id, source_id)
);

-- Embedding per ricerca semantica cross-POI e matching domande.
-- Dimensione da allineare al modello di embedding scelto.
create table claim_embeddings (
  claim_id  uuid not null references claims (id) on delete cascade,
  locale    text not null references locales (code),
  model     text not null,
  embedding vector (1024) not null,
  primary key (claim_id, locale, model)
);
create index claim_embeddings_hnsw on claim_embeddings using hnsw (embedding vector_cosine_ops);

-- =====================================================================
-- 7. STORIE (narrazioni editoriali) + VARIANTI + AUDIO
-- =====================================================================

create table stories (
  id            uuid primary key default gen_random_uuid(),
  poi_id        uuid references pois (id) on delete cascade,
  entity_id     uuid references entities (id) on delete cascade,
  route_id      uuid,   -- FK dopo `routes`: storie di transizione tra due tappe
  story_type    text not null check (story_type in (
                  'arrival_hook', 'introduction', 'history', 'architecture', 'art',
                  'legend', 'curiosity', 'people', 'nature', 'transition', 'closing')),
  importance    smallint not null default 3,
  status        publish_status not null default 'draft',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint stories_subject_chk check (poi_id is not null or entity_id is not null or route_id is not null)
);

-- Quali fatti usa la storia (grounding esplicito). Se un claim viene
-- deprecato, tutte le storie collegate tornano automaticamente in revisione.
create table story_claims (
  story_id uuid not null references stories (id) on delete cascade,
  claim_id uuid not null references claims (id),
  primary key (story_id, claim_id)
);

-- Variante = stessa storia per lingua × pubblico × durata.
create table story_variants (
  id               uuid primary key default gen_random_uuid(),
  story_id         uuid not null references stories (id) on delete cascade,
  locale           text not null references locales (code),
  audience         audience_kind not null default 'general',
  target_seconds   smallint not null,            -- 30, 90, 180...
  title            text,
  -- Segmenti: unità di interruzione/ripresa. Ogni segmento dichiara i suoi claim
  -- e una frase-ponte per la ripresa ("Come ti stavo raccontando...").
  -- [{ "id": "s1", "text": "...", "claim_ids": [...], "resume_hook": "..." }]
  segments         jsonb not null,
  ssml             text,
  origin           text not null check (origin in ('human', 'ai_assisted', 'ai_generated')),
  generation_id    uuid,                          -- → ai_generations (audit)
  grounding_report jsonb,                         -- esito validatore automatico
  reviewed_by      uuid references auth.users (id),
  reviewed_at      timestamptz,
  status           publish_status not null default 'draft',
  content_hash     text not null,                 -- per invalidare l'audio quando il testo cambia
  created_at       timestamptz not null default now(),
  unique (story_id, locale, audience, target_seconds)
);

create table voices (
  id           text primary key,                  -- 'it-guida-f1'
  locale       text not null references locales (code),
  provider     text not null,                     -- provider TTS (astratto)
  provider_voice_id text not null,
  display_name text not null,
  is_default   boolean not null default false
);

create table audio_renditions (
  id                uuid primary key default gen_random_uuid(),
  story_variant_id  uuid not null references story_variants (id) on delete cascade,
  voice_id          text not null references voices (id),
  storage_path      text not null,                -- Supabase Storage / CDN, URL content-addressed
  codec             text not null default 'aac',
  bitrate_kbps      smallint not null default 48,
  duration_ms       integer not null,
  bytes             integer not null,
  -- Timestamp per segmento: [{ "segment_id": "s1", "start_ms": 0, "end_ms": 8400 }]
  segment_timings   jsonb not null,
  source_hash       text not null,                -- = story_variants.content_hash al momento del render
  created_at        timestamptz not null default now(),
  unique (story_variant_id, voice_id, source_hash)
);

-- Domande frequenti pre-generate per POI: servono la conversazione OFFLINE
-- e fanno da cache semantica online.
create table faqs (
  id          uuid primary key default gen_random_uuid(),
  poi_id      uuid references pois (id) on delete cascade,
  entity_id   uuid references entities (id) on delete cascade,
  intent_key  text not null,                     -- 'age', 'why_here', 'who_built', 'byron_visit'
  status      publish_status not null default 'draft',
  unique (poi_id, intent_key)
);

create table faq_variants (
  faq_id              uuid not null references faqs (id) on delete cascade,
  locale              text not null references locales (code),
  question_paraphrases text[] not null,          -- "quanti anni ha", "quando è stata costruita", ...
  answer_text         text not null,
  claim_ids           uuid[] not null,
  audio_path          text,
  reviewed            boolean not null default false,
  primary key (faq_id, locale)
);

-- =====================================================================
-- 8. MEDIA
-- =====================================================================

create table media (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  kind            text not null check (kind in ('image', 'video', 'audio', 'document', 'model3d')),
  storage_path    text not null,
  width           integer,
  height          integer,
  duration_ms     integer,
  credit          text,
  license         text not null,
  offline_eligible boolean not null default true,
  created_at      timestamptz not null default now()
);

create table media_translations (
  media_id uuid not null references media (id) on delete cascade,
  locale   text not null references locales (code),
  caption  text,
  alt_text text,
  primary key (media_id, locale)
);

create table media_links (
  media_id   uuid not null references media (id) on delete cascade,
  poi_id     uuid references pois (id) on delete cascade,
  entity_id  uuid references entities (id) on delete cascade,
  story_id   uuid references stories (id) on delete cascade,
  position   smallint not null default 0,
  is_cover   boolean not null default false,
  constraint media_links_target_chk check (num_nonnulls(poi_id, entity_id, story_id) = 1)
);
create index media_links_poi_idx on media_links (poi_id);

-- =====================================================================
-- 9. ITINERARI CURATI
-- =====================================================================

create table routes (
  id              uuid primary key default gen_random_uuid(),
  territory_id    uuid not null references territories (id),
  slug            text not null,
  duration_min    smallint not null,
  distance_m      integer,
  elevation_gain_m integer,
  difficulty      smallint check (difficulty between 1 and 5),
  step_free       boolean not null default false,
  interest_tags   text[] not null default '{}',
  path            geography (linestring, 4326),
  status          publish_status not null default 'draft',
  created_at      timestamptz not null default now(),
  unique (territory_id, slug)
);

alter table stories
  add constraint stories_route_fk foreign key (route_id) references routes (id) on delete cascade;

create table route_translations (
  route_id    uuid not null references routes (id) on delete cascade,
  locale      text not null references locales (code),
  name        text not null,               -- "Portovenere in 60 minuti"
  description text,
  primary key (route_id, locale)
);

create table route_stops (
  route_id            uuid not null references routes (id) on delete cascade,
  position            smallint not null,
  poi_id              uuid not null references pois (id),
  dwell_min           smallint,
  -- Racconto da ascoltare camminando verso la tappa successiva.
  transition_story_id uuid references stories (id),
  optional            boolean not null default false,
  primary key (route_id, position)
);

-- =====================================================================
-- 10. CONTENT PACK OFFLINE
-- =====================================================================

create table content_packs (
  id             uuid primary key default gen_random_uuid(),
  territory_id   uuid not null references territories (id),
  locale         text not null references locales (code),
  flavor         text not null default 'full' check (flavor in ('lite', 'full')),
  version        integer not null,
  schema_version smallint not null,
  min_app_version text not null,
  manifest       jsonb not null,           -- elenco file con sha256 e byte (delta update)
  total_bytes    bigint not null,
  kb_version     text not null,            -- hash dello stato dei claim inclusi
  built_at       timestamptz not null default now(),
  status         publish_status not null default 'draft',
  unique (territory_id, locale, flavor, version)
);

-- =====================================================================
-- 11. UTENTI, PREFERENZE, CONSENSI
-- =====================================================================
-- auth.users gestito da Supabase (anche sign-in anonimo).

create table profiles (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  locale             text references locales (code),
  guide_mode         guide_mode not null default 'ask',
  default_audience   audience_kind not null default 'general',
  narration_length_s smallint not null default 90,
  interests          jsonb not null default '{}',   -- { "history": 0.9, "nature": 0.4 }
  voice_id           text references voices (id),
  playback_rate      real not null default 1.0 check (playback_rate between 0.5 and 2.0),
  accessibility      jsonb not null default '{}',   -- { "avoid_stairs": true, "transcripts": true }
  store_conversations boolean not null default false,  -- opt-in esplicito
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Registro consensi (prova del consenso, art. 7 GDPR). Append-only.
create table consents (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  purpose     text not null check (purpose in (
                'location', 'conversation_storage', 'analytics',
                'personalization', 'partner_suggestions')),
  granted     boolean not null,
  policy_version text not null,
  created_at  timestamptz not null default now()
);
create index consents_user_idx on consents (user_id, purpose, created_at desc);

-- =====================================================================
-- 12. TOUR (sessioni di visita) + PROGRESSO + CONVERSAZIONE
-- =====================================================================

create table tours (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  territory_id   uuid not null references territories (id),
  route_id       uuid references routes (id),
  mode           tour_mode not null,
  locale         text not null references locales (code),
  audience       audience_kind not null default 'general',
  time_budget_min smallint,
  interests      text[] not null default '{}',
  status         tour_status not null default 'planned',
  started_at     timestamptz,
  ended_at       timestamptz,
  -- Riassunto conversazionale del tour (memoria limitata). Cancellato
  -- dal job di retention se l'utente non ha dato consenso alla conservazione.
  memory_summary text,
  client_version text,
  created_at     timestamptz not null default now()
);
create index tours_user_idx on tours (user_id, created_at desc);

-- Tappe pianificate (per tour dinamici) e stato di visita.
create table tour_stops (
  tour_id        uuid not null references tours (id) on delete cascade,
  position       smallint not null,
  poi_id         uuid not null references pois (id),
  planned_eta    timestamptz,
  state          text not null default 'pending' check (state in ('pending', 'visited', 'skipped')),
  visited_at     timestamptz,
  primary key (tour_id, position)
);

-- Cosa è stato raccontato (per non ripetersi e per riprendere).
create table tour_narrations (
  id               bigint generated always as identity primary key,
  tour_id          uuid not null references tours (id) on delete cascade,
  poi_id           uuid references pois (id),
  story_variant_id uuid references story_variants (id),
  claim_ids        uuid[] not null default '{}',
  completion       real,          -- 0..1
  interrupted_at_segment text,
  created_at       timestamptz not null default now()
);

-- Turni di conversazione: SOLO se profiles.store_conversations = true,
-- altrimenti restano sul dispositivo. Retention massima: 30 giorni.
create table conversation_turns (
  id             bigint generated always as identity primary key,
  tour_id        uuid not null references tours (id) on delete cascade,
  role           text not null check (role in ('user', 'guide')),
  content        text not null,
  poi_id         uuid references pois (id),
  cited_claim_ids uuid[] not null default '{}',
  generation_id  uuid,
  created_at     timestamptz not null default now()
);
create index conversation_turns_tour_idx on conversation_turns (tour_id, id);

-- =====================================================================
-- 13. AUDIT AI + LACUNE DI CONOSCENZA + SEGNALAZIONI
-- =====================================================================

create table ai_generations (
  id               uuid primary key default gen_random_uuid(),
  purpose          text not null check (purpose in ('editorial_variant', 'live_answer', 'live_narration', 'faq', 'translation')),
  model            text not null,
  prompt_version   text not null,
  kb_version       text not null,
  provided_claim_ids uuid[] not null,
  cited_claim_ids  uuid[] not null default '{}',
  validator_passed boolean,
  validator_issues jsonb,
  input_tokens     integer,
  output_tokens    integer,
  cache_read_tokens integer,
  latency_ms       integer,
  created_at       timestamptz not null default now()
);

-- Domande a cui la KB non sa rispondere → backlog redazionale.
create table knowledge_gaps (
  id           bigint generated always as identity primary key,
  territory_id uuid references territories (id),
  poi_id       uuid references pois (id),
  locale       text references locales (code),
  question     text not null,               -- testo ripulito da dati personali
  occurrences  integer not null default 1,
  status       text not null default 'open' check (status in ('open', 'planned', 'answered', 'wont_answer')),
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

-- "Questa informazione mi sembra sbagliata" dall'utente.
create table content_reports (
  id           bigint generated always as identity primary key,
  generation_id uuid references ai_generations (id),
  story_variant_id uuid references story_variants (id),
  claim_id     uuid references claims (id),
  reason       text not null,
  note         text,
  status       text not null default 'open' check (status in ('open', 'confirmed', 'dismissed')),
  created_at   timestamptz not null default now()
);

-- =====================================================================
-- 14. ANALYTICS (privacy-first: nessuna coordinata, solo POI)
-- =====================================================================

create table analytics_events (
  id           bigint generated always as identity primary key,
  -- ID pseudonimo ruotato per tour, NON user_id.
  session_hash text not null,
  territory_id uuid references territories (id),
  poi_id       uuid references pois (id),
  event        text not null,     -- 'tour_started','poi_arrived','story_completed','question_asked',...
  props        jsonb not null default '{}',
  app_version  text,
  occurred_at  timestamptz not null,
  received_at  timestamptz not null default now()
);
create index analytics_events_time_idx on analytics_events using brin (occurred_at);

-- =====================================================================
-- 15. INTEGRAZIONI ESTERNE (es. Ductavia) — isolate dal core
-- =====================================================================

create table partner_offers (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,                  -- 'ductavia'
  external_id   text not null,
  territory_id  uuid references territories (id),
  topic_tags    text[] not null default '{}',   -- 'wine','olive_oil','sailing'
  payload       jsonb not null,                 -- titolo, url, prezzo indicativo (cache)
  is_commercial boolean not null default true,
  active        boolean not null default true,
  synced_at     timestamptz not null default now(),
  unique (provider, external_id)
);

-- =====================================================================
-- 16. FUNZIONI DI SUPPORTO
-- =====================================================================

create or replace function is_staff(p_roles staff_role[] default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff_members s
    where s.user_id = auth.uid()
      and (p_roles is null or s.role = any (p_roles))
  );
$$;

-- POI pubblicati vicini a un punto (usata dal tool AI get_nearby_pois
-- e dall'API online; offline lo stesso calcolo avviene sul dispositivo).
create or replace function nearby_pois(
  p_lat double precision,
  p_lng double precision,
  p_radius_m integer default 300,
  p_locale text default 'it',
  p_limit integer default 10
)
returns table (poi_id uuid, name text, category_id text, importance smallint, distance_m double precision, bearing_deg double precision)
language sql stable as $$
  with me as (select st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography as g)
  select p.id,
         coalesce(t.name, t_it.name),
         p.category_id,
         p.importance,
         st_distance(p.location, me.g),
         degrees(st_azimuth(me.g::geometry, p.location::geometry))
  from pois p
  cross join me
  left join poi_translations t    on t.poi_id = p.id and t.locale = p_locale
  left join poi_translations t_it on t_it.poi_id = p.id and t_it.locale = 'it'
  where p.status = 'published'
    and st_dwithin(p.location, me.g, p_radius_m)
  order by st_distance(p.location, me.g)
  limit p_limit;
$$;

-- "Fact sheet" di un POI: tutti i claim verificati nella lingua richiesta,
-- con fallback. È esattamente ciò che l'AI riceve come contesto.
create or replace function poi_fact_sheet(p_poi_id uuid, p_locale text default 'it')
returns table (claim_id uuid, topic text, certainty certainty_level, statement text,
               year_from smallint, year_to smallint, importance smallint, kid_friendly boolean)
language sql stable as $$
  select c.id, c.topic, c.certainty,
         coalesce(ct.statement, ct_en.statement, ct_it.statement),
         c.year_from, c.year_to, c.importance, c.kid_friendly
  from claims c
  left join claim_translations ct    on ct.claim_id = c.id and ct.locale = p_locale
  left join claim_translations ct_en on ct_en.claim_id = c.id and ct_en.locale = 'en'
  left join claim_translations ct_it on ct_it.claim_id = c.id and ct_it.locale = 'it'
  where c.verification_status = 'verified'
    and (c.poi_id = p_poi_id
         or c.entity_id in (select pe.entity_id from poi_entities pe where pe.poi_id = p_poi_id))
  order by c.importance desc, c.year_from nulls last;
$$;

-- Se un claim viene deprecato/rifiutato, le storie che lo usano tornano in revisione.
create or replace function claims_invalidate_stories()
returns trigger language plpgsql as $$
begin
  if new.verification_status in ('deprecated', 'rejected')
     and old.verification_status = 'verified' then
    update stories s set status = 'in_review', updated_at = now()
    where s.status = 'published'
      and exists (select 1 from story_claims sc where sc.story_id = s.id and sc.claim_id = new.id);
  end if;
  return new;
end;
$$;

create trigger claims_invalidate_stories_trg
after update of verification_status on claims
for each row execute function claims_invalidate_stories();

-- =====================================================================
-- 17. ROW LEVEL SECURITY (estratto: pattern da replicare su tutte le tabelle)
-- =====================================================================

alter table pois               enable row level security;
alter table poi_translations   enable row level security;
alter table claims             enable row level security;
alter table claim_translations enable row level security;
alter table story_variants     enable row level security;
alter table profiles           enable row level security;
alter table consents           enable row level security;
alter table tours              enable row level security;
alter table tour_stops         enable row level security;
alter table conversation_turns enable row level security;

-- Contenuti: pubblico legge solo il pubblicato/verificato; staff legge e scrive tutto.
create policy pois_public_read on pois for select using (status = 'published' or is_staff());
create policy pois_staff_write on pois for all using (is_staff(array['admin','editor']::staff_role[]))
  with check (is_staff(array['admin','editor']::staff_role[]));

create policy poi_tr_public_read on poi_translations for select using (
  exists (select 1 from pois p where p.id = poi_id and p.status = 'published') or is_staff());
create policy poi_tr_staff_write on poi_translations for all
  using (is_staff(array['admin','editor','translator']::staff_role[]))
  with check (is_staff(array['admin','editor','translator']::staff_role[]));

create policy claims_public_read on claims for select using (verification_status = 'verified' or is_staff());
create policy claims_staff_write on claims for insert with check (is_staff(array['admin','editor','historian']::staff_role[]));
create policy claims_staff_update on claims for update using (is_staff(array['admin','editor','historian']::staff_role[]));

create policy claim_tr_public_read on claim_translations for select using (
  exists (select 1 from claims c where c.id = claim_id and c.verification_status = 'verified') or is_staff());

create policy story_variants_public_read on story_variants for select using (status = 'published' or is_staff());

-- Dati utente: solo il proprietario.
create policy profiles_owner on profiles for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy consents_owner_read on consents for select using (user_id = auth.uid());
create policy consents_owner_insert on consents for insert with check (user_id = auth.uid());
create policy tours_owner on tours for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tour_stops_owner on tour_stops for all using (
  exists (select 1 from tours t where t.id = tour_id and t.user_id = auth.uid()));
create policy conversation_turns_owner on conversation_turns for select using (
  exists (select 1 from tours t where t.id = tour_id and t.user_id = auth.uid()));
-- conversation_turns: insert solo dal backend (service role), dopo verifica consenso.
