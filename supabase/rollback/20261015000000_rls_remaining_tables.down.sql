-- Revoca di 20261015000000_rls_remaining_tables.sql (riporta le tabelle senza RLS: solo per le prove).
drop policy if exists organizations_member_read on organizations;
drop policy if exists organizations_admin_write on organizations;
drop policy if exists locales_read on locales;
drop policy if exists predicates_read on predicates;
drop policy if exists media_license_rules_read on media_license_rules;
drop policy if exists pack_dependencies_staff_read on pack_dependencies;
drop policy if exists pack_dependencies_admin_write on pack_dependencies;
drop policy if exists node_external_ids_staff_read on node_external_ids;
drop policy if exists node_external_ids_editor_write on node_external_ids;
drop policy if exists territory_memberships_staff_read on territory_memberships;
drop policy if exists territory_memberships_editor_write on territory_memberships;
drop policy if exists walk_edges_staff_read on walk_edges;
drop policy if exists walk_edges_editor_write on walk_edges;
drop policy if exists audio_assets_staff_read on audio_assets;

alter table organizations disable row level security;
alter table locales disable row level security;
alter table predicates disable row level security;
alter table media_license_rules disable row level security;
alter table pack_dependencies disable row level security;
alter table node_external_ids disable row level security;
alter table territory_memberships disable row level security;
alter table walk_edges disable row level security;
alter table audio_assets disable row level security;
