-- Revoca di 20261014000000_platform_accounts_cms.sql (e dell'uso di 'platform_admin').
-- Riporta lo schema allo stato precedente. ATTENZIONE: cancella profili, preferiti, avanzamenti,
-- consensi, prodotti, diritti, acquisti, pubblicazioni e storico delle versioni: esportarli prima.
-- Il valore 'platform_admin' resta nel tipo member_role (Postgres non rimuove valori di enum),
-- ma nessuna membership lo usa più.

begin;

-- 10/9. Dati personali e premium
drop function if exists export_my_data();
drop function if exists can_access_route(uuid);
drop function if exists has_entitlement(uuid);
drop table if exists entitlements;
drop table if exists purchases;
drop table if exists products;
alter table narrative_units drop column if exists access_tier;
alter table routes drop column if exists access_tier;
drop type if exists access_tier;

-- 8. Visitatori
drop function if exists delete_my_account();
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists handle_new_user();
drop table if exists consents;
drop table if exists route_progress;
drop table if exists favorites;
drop table if exists profiles;

-- 7. Media e Storage
drop policy if exists bundles_public_read on storage.objects;
drop policy if exists media_files_editor_delete on storage.objects;
drop policy if exists media_files_editor_update on storage.objects;
drop policy if exists media_files_editor_insert on storage.objects;
drop policy if exists media_files_staff_read on storage.objects;
delete from storage.buckets where id in ('media', 'bundles') and not exists (select 1 from storage.objects o where o.bucket_id = storage.buckets.id);
drop policy if exists media_labels_editor_write on media_labels;
drop policy if exists media_labels_staff_read on media_labels;
drop policy if exists media_subjects_editor_write on media_subjects;
drop policy if exists media_subjects_staff_read on media_subjects;
alter table media_labels disable row level security;
alter table media_subjects disable row level security;
drop policy if exists media_editor_write on media_assets;
alter table destinations drop constraint if exists destinations_cover_fk;
delete from media_assets where kind = 'audio';
alter table media_assets
  drop constraint if exists media_assets_path_check,
  drop constraint if exists media_assets_size_check,
  drop constraint if exists media_assets_mime_check,
  drop column if exists updated_at,
  drop column if exists uploaded_by,
  drop column if exists status,
  drop column if exists duration_s,
  drop column if exists height,
  drop column if exists width,
  drop column if exists bytes,
  drop column if exists mime_type;
alter table media_assets drop constraint if exists media_assets_kind_check;
alter table media_assets add constraint media_assets_kind_check check (kind in ('image', 'video'));

-- 6. Pubblicazione
drop table if exists publications;
drop type if exists publication_status;

-- 5. Storico
do $$
declare t text;
begin
  foreach t in array array['nodes', 'places', 'sources', 'assertions', 'narrative_units', 'routes', 'media_assets', 'destinations'] loop
    execute format('drop trigger if exists %I on %I', t || '_revision_trg', t);
  end loop;
end $$;
drop function if exists record_revision();
drop table if exists content_revisions;

-- 4. Stati editoriali
drop trigger if exists editorial_publish_guard_destinations on destinations;
drop trigger if exists editorial_publish_guard_nodes on nodes;
drop trigger if exists editorial_publish_guard_routes on routes;
drop function if exists editorial_publish_guard();
drop trigger if exists editorial_unit_guard_trg on narrative_units;
drop function if exists editorial_unit_guard();
drop trigger if exists editorial_assertion_text_guard_trg on assertion_texts;
drop function if exists editorial_assertion_text_guard();
drop trigger if exists editorial_assertion_guard_trg on assertions;
drop function if exists editorial_assertion_guard();

-- 3. Scrittura per territorio: si torna alla scrittura della sola redazione centrale
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' and policyname in (
    'destinations_editor_write', 'destinations_staff_read', 'bundles_staff_read',
    'route_stops_editor_write', 'route_stops_staff_read', 'routes_editor_write', 'routes_staff_read',
    'unit_assertions_editor_write', 'unit_assertions_staff_read', 'units_editor_write',
    'disputes_editor_write', 'disputes_staff_read', 'evidence_editor_write', 'evidence_staff_read',
    'assertion_texts_editor_write', 'assertion_texts_staff_read', 'assertions_editor_write',
    'sources_editor_write', 'sources_staff_read', 'territories_editor_write', 'territories_staff_read',
    'geofences_editor_write', 'geofences_staff_read', 'places_editor_write', 'places_staff_read',
    'node_labels_editor_write', 'node_labels_staff_read', 'nodes_editor_write',
    'packs_editor_update', 'packs_admin_write', 'memberships_admin_all')
  loop
    execute format('drop policy %I on %I', r.policyname, r.tablename);
  end loop;
end $$;
alter table destinations disable row level security;
create policy nodes_platform_write on nodes for all
  using (has_role(array['platform_editor']::member_role[], pack_id))
  with check (has_role(array['platform_editor']::member_role[], pack_id));
create policy assertions_platform_write on assertions for all
  using (has_role(array['platform_editor']::member_role[], pack_id))
  with check (has_role(array['platform_editor']::member_role[], pack_id));

-- 2. Metadati dei territori
alter table destinations
  drop column if exists updated_at,
  drop column if exists published_by,
  drop column if exists published_at,
  drop column if exists cover_media_id,
  drop column if exists slug;
alter table packs
  drop column if exists description,
  drop column if exists title,
  drop column if exists locales;

-- 1. Ruoli
drop function if exists is_pack_staff(text);
drop function if exists can_publish_pack(text);
drop function if exists can_verify_pack(text);
drop function if exists can_edit_pack(text);
drop function if exists is_platform_admin();
delete from memberships where role = 'platform_admin';

commit;
