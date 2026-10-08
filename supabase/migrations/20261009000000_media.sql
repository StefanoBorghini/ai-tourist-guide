-- =====================================================================
-- Media con provenienza e licenza (immagini dei luoghi)
-- Rispecchia mediaSchema e MEDIA_LICENSES in packages/domain.
-- =====================================================================

create type media_source as enum ('own_photo', 'institution', 'archive', 'web', 'other');
create type media_license as enum (
  'own', 'public-domain', 'cc0', 'cc-by-4.0', 'cc-by-sa-4.0',
  'cc-by-nc-4.0', 'cc-by-nc-sa-4.0', 'licensed', 'all-rights-reserved'
);

-- Regole derivate dalla licenza: uso commerciale e attribuzione obbligatoria.
create table media_license_rules (
  license              media_license primary key,
  commercial_use       boolean not null,
  attribution_required boolean not null
);
insert into media_license_rules values
  ('own', true, false), ('public-domain', true, false), ('cc0', true, false),
  ('cc-by-4.0', true, true), ('cc-by-sa-4.0', true, true),
  ('cc-by-nc-4.0', false, true), ('cc-by-nc-sa-4.0', false, true),
  ('licensed', true, true), ('all-rights-reserved', false, true);

create table media_assets (
  id            uuid primary key default gen_random_uuid(),
  pack_id       text not null references packs (id),
  slug          text not null,
  kind          text not null check (kind = 'image'),
  storage_path  text not null,
  sha256        text not null,
  source        media_source not null,
  author        text,
  license       media_license not null,
  attribution   text,
  original_url  text,
  license_note  text,
  taken_at      date,
  location      geography (point, 4326),
  created_at    timestamptz not null default now(),
  unique (pack_id, slug),
  check (license = 'public-domain' or author is not null),
  check (license <> 'licensed' or license_note is not null),
  check (source <> 'web' or original_url is not null)
);

create table media_subjects (
  media_id uuid not null references media_assets (id) on delete cascade,
  node_id  uuid not null references nodes (id),
  primary key (media_id, node_id)
);

create table media_labels (
  media_id uuid not null references media_assets (id) on delete cascade,
  locale   text not null references locales (code),
  alt      text not null,
  caption  text,
  primary key (media_id, locale)
);

alter table media_assets enable row level security;
create policy media_staff_read on media_assets for select
  using (has_role(array['platform_editor', 'territory_editor', 'expert', 'institution', 'contributor', 'translator']::member_role[], pack_id));
