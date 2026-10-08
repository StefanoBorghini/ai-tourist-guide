-- Verifica sul campo e stadi di rilascio (Territory Pack v1, estensione).
--
-- - le ipotesi diventano un tipo di affermazione distinto dalle interpretazioni;
-- - i luoghi dichiarano quanto sono affidabili le coordinate e lo stato del racconto;
-- - i pack dichiarano lo stadio (ricerca, prova sul campo, produzione);
-- - i percorsi dichiarano se sono stati calibrati sul posto, difficoltà, dislivello e fonti.
-- Le informazioni pratiche (orari, accessi, trasporti) restano in places.practical (jsonb),
-- validate dallo schema del pack: hanno una data di controllo e una scadenza.

alter type assertion_type add value 'hypothesis' after 'interpretation';

create type coordinate_status as enum ('preliminary', 'field_verified', 'needs_review');
create type release_stage as enum ('research', 'field_test', 'production');
create type route_difficulty as enum ('easy', 'medium', 'hard');
create type route_calibration as enum ('draft', 'field_calibrated');

alter table packs
  add column release_stage    release_stage not null default 'production',
  add column editorial_status text;

alter table places
  add column coordinate_status      coordinate_status not null default 'preliminary',
  add column coordinate_verified_at date,
  add column coordinate_verified_by text,
  add column coordinate_method      text,
  add column story_status           text,
  add column field_notes            text[] not null default '{}',
  add column last_verified_at       date,
  add column verified_by            text,
  add column walkable               boolean not null default true,
  add constraint places_field_verified_check
    check (coordinate_status <> 'field_verified' or (coordinate_verified_at is not null and coordinate_verified_by is not null));

alter table sources
  add column priority    text,
  add column original_id text,
  add column accessed_at date;

alter table assertions
  add column original_claim text;

alter table routes
  add column calibration      route_calibration not null default 'draft',
  add column difficulty       route_difficulty,
  add column elevation_gain_m smallint check (elevation_gain_m >= 0),
  add column notes            text[] not null default '{}';

create table route_sources (
  route_id  uuid not null references routes (id) on delete cascade,
  source_id uuid not null references sources (id),
  primary key (route_id, source_id)
);

-- Come routes e route_stops: accesso solo dal backend (nessuna policy pubblica).
alter table route_sources enable row level security;
